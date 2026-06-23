import { useCallback, useMemo, useState } from 'react';
import {
  InboundAuthorPolicySchema,
  InboundAuthorPolicySchemaVersion,
  type InboundAuthorConnector,
  type InboundAuthorPolicy,
  type PolicyMode,
} from '@rebel/shared';
import { useSettingsSafe } from '../SettingsProvider';

const SLACK_CONNECTOR: InboundAuthorConnector = 'slack';
const DEFAULT_POLICY_MODE: PolicyMode = 'ownerOnly';
const SLACK_CANONICAL_USER_ID_PATTERN = /^[UW][A-Z0-9]+$/;

export interface AddAuthorResult {
  ok: boolean;
  error?: string;
  canonicalId?: string;
  displayName?: string;
  handle?: string;
}

/**
 * Per-entry metadata captured from the resolver response so chips can render
 * `Hannah (@hannah) · U0A1M65FV6U` instead of just the canonical ID. Lives in
 * renderer memory only; the persisted policy stays a list of canonical IDs so
 * the cross-surface contract does not change. A future cycle can promote this
 * into the persisted policy if cloud/mobile surfaces want the same affordance.
 */
export interface SlackAuthorMetadata {
  displayName?: string;
  handle?: string;
}

export const INBOUND_AUTHOR_UPGRADE_DISMISSED_AT_KEY = 'rebel:inbound-author-policy:upgrade-dismissed-at';
export const INBOUND_AUTHOR_UPGRADE_REPROMPT_SUPPRESSED_KEY = 'rebel:inbound-author-policy:upgrade-reprompt-suppressed';

const FALLBACK_INBOUND_POLICY: InboundAuthorPolicy = {
  inboundAuthorPolicySchemaVersion: InboundAuthorPolicySchemaVersion,
  policyRevision: 0,
  mode: DEFAULT_POLICY_MODE,
  allowlist: {},
  blocklist: {},
  surfaceTrusted: {},
  agentAllowlist: {},
  notices: {
    upgradeReviewPending: false,
  },
};

const SORTED_EMPTY: string[] = [];

function normalizeSlackAuthorId(rawAuthorId: string): string {
  return rawAuthorId.trim().replace(/^@+/, '').toUpperCase();
}

function isCanonicalSlackUserId(value: string): boolean {
  return SLACK_CANONICAL_USER_ID_PATTERN.test(value);
}

/**
 * Designer-binding error copy. Single source of truth so the panel and any
 * callers display the exact same Rebel-voice strings.
 */
const REBEL_VOICE_ERROR_FALLBACK: Record<string, (input: string) => string> = {
  not_found: (input) =>
    `Couldn't find ${input} in this Slack workspace. Double-check the spelling, or paste their Slack user ID (starts with U).`,
  auth_failed: () => `Slack wouldn't let Rebel check that person. Reconnect Slack, then try again.`,
  deactivated: () => `That Slack account is deactivated, so it can't message Rebel. Not adding a ghost.`,
  ambiguous: (input) =>
    `More than one person matched ${input}. Be more specific — try @handle or paste their U-ID.`,
  no_workspace: () => `Connect Slack first, then add people to your messaging list.`,
  transport_error: () => `Could not reach Slack to verify that user. Try again in a moment.`,
  invalid_input: () => `Enter a Slack ID, handle, or display name.`,
  rate_limited: () => `Slack rate-limited that lookup. Wait a moment and try again.`,
};

function rebelVoiceErrorFor(code: string | undefined, input: string, fallback: string): string {
  if (!code) return fallback;
  const builder = REBEL_VOICE_ERROR_FALLBACK[code];
  return builder ? builder(input) : fallback;
}

async function resolveSlackAuthorViaIpc(rawInput: string): Promise<AddAuthorResult> {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { ok: false, error: REBEL_VOICE_ERROR_FALLBACK.invalid_input(trimmed) };
  }
  const slackApi = (typeof window !== 'undefined' ? window.slackApi : undefined) as
    | { resolveAuthorInput?: (request: { query: string; teamId?: string }) => Promise<unknown> }
    | undefined;
  // Per chief-designer binding, even canonical IDs go through users.info verification —
  // bogus or deactivated IDs would otherwise sneak in. The handler short-circuits the
  // workspace member scan for ID-shaped inputs so the round-trip stays cheap.
  if (!slackApi?.resolveAuthorInput) {
    // Renderer running in a build without the IPC bridge (e.g. cloud-only). Fall back
    // to the syntactic check so users at least don't get bricked. We surface the
    // limitation in the error path of `addToAllowlist` if a non-canonical input lands
    // here without verification.
    const normalized = normalizeSlackAuthorId(trimmed);
    if (isCanonicalSlackUserId(normalized)) {
      return { ok: true, canonicalId: normalized };
    }
    return {
      ok: false,
      error: 'Slack handle resolution is not available in this build. Use the canonical user ID (starts with U or W).',
    };
  }
  try {
    const response = await slackApi.resolveAuthorInput({ query: trimmed });
    if (!response || typeof response !== 'object') {
      return { ok: false, error: 'Slack returned an unexpected response. Try again or use the canonical user ID.' };
    }
    const r = response as {
      outcome?: string;
      author?: { id?: string; displayName?: string; realName?: string; handle?: string };
      message?: string;
      code?: string;
    };
    if (r.outcome === 'resolved' && r.author?.id && isCanonicalSlackUserId(r.author.id)) {
      const displayName = r.author.displayName?.trim() || r.author.realName?.trim() || undefined;
      const handle = r.author.handle?.trim() || undefined;
      return { ok: true, canonicalId: r.author.id.toUpperCase(), displayName, handle };
    }
    if (r.outcome === 'error') {
      const fallback = typeof r.message === 'string' && r.message
        ? r.message
        : `Could not resolve that Slack user. Use the canonical ID (starts with U or W).`;
      return { ok: false, error: rebelVoiceErrorFor(r.code, trimmed, fallback) };
    }
    return { ok: false, error: 'Could not resolve that Slack user. Use the canonical ID (starts with U or W).' };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error
        ? `Could not reach Slack to verify that user (${err.message}).`
        : 'Could not reach Slack to verify that user.',
    };
  }
}

function normalizeSurfaceId(rawSurfaceId: string): string {
  return rawSurfaceId.trim();
}

export interface SlackPolicyPartition {
  canonical: string[];
  legacy: string[];
}

/**
 * Split Slack allowlist/blocklist entries into canonical (U-ID-shaped) and
 * legacy (anything else) buckets. We never drop legacy entries on read — the
 * panel surfaces them as warning chips with Re-resolve / Remove actions so
 * users can clean up old non-canonical strings without Rebel pretending they
 * never existed.
 */
export function partitionSlackPolicyEntries(values: readonly string[]): SlackPolicyPartition {
  const canonical: string[] = [];
  const legacy: string[] = [];
  for (const entry of values) {
    if (isCanonicalSlackUserId(entry)) canonical.push(entry);
    else legacy.push(entry);
  }
  return { canonical, legacy };
}

function parseInboundAuthorPolicy(candidate: unknown): InboundAuthorPolicy {
  const parsed = InboundAuthorPolicySchema.safeParse(candidate);
  if (parsed.success) {
    return parsed.data;
  }
  return FALLBACK_INBOUND_POLICY;
}

function asUnique(values: readonly string[]): string[] {
  if (values.length === 0) return SORTED_EMPTY;
  const next: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    next.push(value);
  }
  return next;
}

function connectorList(
  map: Record<string, string[]>,
  connector: InboundAuthorConnector,
): string[] {
  return map[connector] ?? SORTED_EMPTY;
}

function withoutValue(list: readonly string[], value: string): string[] {
  if (!list.includes(value)) return list as string[];
  return list.filter((entry) => entry !== value);
}

function addUniqueValue(list: readonly string[], value: string): string[] {
  if (list.includes(value)) return list as string[];
  return [...list, value];
}

function hasPolicyChanged(
  currentPolicy: InboundAuthorPolicy,
  nextPolicy: InboundAuthorPolicy,
): boolean {
  const normalize = (policy: InboundAuthorPolicy) => ({
    ...policy,
    policyRevision: 0,
  });
  return JSON.stringify(normalize(currentPolicy)) !== JSON.stringify(normalize(nextPolicy));
}

function writeDismissedAt(now: number): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(INBOUND_AUTHOR_UPGRADE_DISMISSED_AT_KEY, String(now));
  } catch {
    // Best-effort local UI preference write.
  }
}

export function readUpgradeReviewDismissedAt(): number | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(INBOUND_AUTHOR_UPGRADE_DISMISSED_AT_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function suppressUpgradeReviewReprompt(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(INBOUND_AUTHOR_UPGRADE_REPROMPT_SUPPRESSED_KEY, 'true');
  } catch {
    // Best-effort local UI preference write.
  }
}

export function isUpgradeReviewRepromptSuppressed(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  try {
    return window.localStorage.getItem(INBOUND_AUTHOR_UPGRADE_REPROMPT_SUPPRESSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export interface UseInboundAuthorPolicyResult {
  policy: InboundAuthorPolicy;
  inboundAuthorPolicyBypassActive?: boolean;
  /** Legacy non-canonical Slack allowlist entries that need re-resolution or removal. */
  legacyAllowlistSlack: string[];
  /** Legacy non-canonical Slack blocklist entries that need re-resolution or removal. */
  legacyBlocklistSlack: string[];
  /**
   * Renderer-only metadata cache keyed by canonical Slack user ID, populated
   * after a successful resolve. Lets chips render `Hannah (@hannah) · U…`
   * without re-querying Slack on every render.
   */
  slackAuthorMetadata: Record<string, SlackAuthorMetadata>;
  setMode: (mode: PolicyMode) => Promise<void>;
  addToAllowlist: (authorId: string) => Promise<AddAuthorResult>;
  addToBlocklist: (authorId: string) => Promise<AddAuthorResult>;
  removeFromAllowlist: (authorId: string) => Promise<void>;
  removeFromBlocklist: (authorId: string) => Promise<void>;
  /**
   * Resolve a legacy non-canonical entry and atomically replace it with the
   * canonical U-ID. Returns the resolution result so the panel can surface
   * Rebel-voice errors when the lookup fails.
   */
  reresolveLegacyAllowlistEntry: (legacyEntry: string) => Promise<AddAuthorResult>;
  reresolveLegacyBlocklistEntry: (legacyEntry: string) => Promise<AddAuthorResult>;
  setSurfaceTrusted: (connector: InboundAuthorConnector, surfaceIds: string[]) => Promise<void>;
  addToAgentAllowlist: (connector: InboundAuthorConnector, instanceId: string) => Promise<void>;
  dismissUpgradeReviewNotice: () => Promise<void>;
  markUpgradeReviewDismissedNow: () => void;
}

export function useInboundAuthorPolicy(): UseInboundAuthorPolicyResult {
  const settingsContext = useSettingsSafe();
  const settings = settingsContext?.draftSettings ?? settingsContext?.settings ?? null;
  const [slackAuthorMetadata, setSlackAuthorMetadata] = useState<Record<string, SlackAuthorMetadata>>({});

  const captureMetadata = useCallback((result: AddAuthorResult): void => {
    if (!result.ok || !result.canonicalId) return;
    const canonicalId = result.canonicalId;
    const displayName = result.displayName;
    const handle = result.handle;
    if (!displayName && !handle) return;
    setSlackAuthorMetadata((current) => {
      const existing = current[canonicalId];
      if (existing && existing.displayName === displayName && existing.handle === handle) {
        return current;
      }
      return { ...current, [canonicalId]: { displayName, handle } };
    });
  }, []);

  const policy = useMemo(
    () => parseInboundAuthorPolicy(settings?.experimental?.inboundAuthorPolicy),
    [settings?.experimental?.inboundAuthorPolicy],
  );
  const inboundAuthorPolicyBypassActive = settings?.experimental?.inboundAuthorPolicyBypassActive;

  const writePolicy = useCallback(async (
    updater: (current: InboundAuthorPolicy) => InboundAuthorPolicy,
  ): Promise<void> => {
    const saveSettingsWith = settingsContext?.saveSettingsWith;
    if (!saveSettingsWith) return;

    await saveSettingsWith((current) => {
      const currentPolicy = parseInboundAuthorPolicy(current.experimental?.inboundAuthorPolicy);
      const candidate = updater(currentPolicy);
      if (!hasPolicyChanged(currentPolicy, candidate)) {
        return current;
      }

      return {
        ...current,
        experimental: {
          ...(current.experimental ?? {}),
          inboundAuthorPolicy: {
            ...candidate,
            inboundAuthorPolicySchemaVersion: InboundAuthorPolicySchemaVersion,
            policyRevision: currentPolicy.policyRevision + 1,
          },
        },
      };
    }, { keepOpen: true });
  }, [settingsContext?.saveSettingsWith]);

  const setMode = useCallback(async (mode: PolicyMode): Promise<void> => {
    await writePolicy((currentPolicy) => {
      if (mode === 'legacyPermissive' && currentPolicy.mode !== 'legacyPermissive') {
        return currentPolicy;
      }
      if (currentPolicy.mode === mode) {
        return currentPolicy;
      }
      return {
        ...currentPolicy,
        mode,
        notices: {
          ...currentPolicy.notices,
          upgradeReviewPending: mode === 'legacyPermissive'
            ? currentPolicy.notices.upgradeReviewPending
            : false,
        },
      };
    });
  }, [writePolicy]);

  const addToAllowlist = useCallback(async (authorId: string): Promise<AddAuthorResult> => {
    const resolved = await resolveSlackAuthorViaIpc(authorId);
    if (!resolved.ok || !resolved.canonicalId) return resolved;
    const canonicalId = resolved.canonicalId;
    captureMetadata(resolved);
    await writePolicy((currentPolicy) => {
      const currentAllowlist = connectorList(currentPolicy.allowlist, SLACK_CONNECTOR);
      const currentBlocklist = connectorList(currentPolicy.blocklist, SLACK_CONNECTOR);
      const nextAllowlist = addUniqueValue(currentAllowlist, canonicalId);
      const nextBlocklist = withoutValue(currentBlocklist, canonicalId);
      return {
        ...currentPolicy,
        allowlist: {
          ...currentPolicy.allowlist,
          [SLACK_CONNECTOR]: nextAllowlist,
        },
        blocklist: {
          ...currentPolicy.blocklist,
          [SLACK_CONNECTOR]: nextBlocklist,
        },
      };
    });
    return resolved;
  }, [writePolicy, captureMetadata]);

  const addToBlocklist = useCallback(async (authorId: string): Promise<AddAuthorResult> => {
    const resolved = await resolveSlackAuthorViaIpc(authorId);
    if (!resolved.ok || !resolved.canonicalId) return resolved;
    const canonicalId = resolved.canonicalId;
    captureMetadata(resolved);
    await writePolicy((currentPolicy) => {
      const currentAllowlist = connectorList(currentPolicy.allowlist, SLACK_CONNECTOR);
      const currentBlocklist = connectorList(currentPolicy.blocklist, SLACK_CONNECTOR);
      const nextAllowlist = withoutValue(currentAllowlist, canonicalId);
      const nextBlocklist = addUniqueValue(currentBlocklist, canonicalId);
      return {
        ...currentPolicy,
        allowlist: {
          ...currentPolicy.allowlist,
          [SLACK_CONNECTOR]: nextAllowlist,
        },
        blocklist: {
          ...currentPolicy.blocklist,
          [SLACK_CONNECTOR]: nextBlocklist,
        },
      };
    });
    return resolved;
  }, [writePolicy, captureMetadata]);

  const removeFromAllowlist = useCallback(async (authorId: string): Promise<void> => {
    // Match legacy entries verbatim so users can remove non-canonical strings
    // without going through normalization (which would mangle them and never
    // match the persisted value).
    const normalizedAuthorId = isCanonicalSlackUserId(authorId)
      ? normalizeSlackAuthorId(authorId)
      : authorId;
    if (!normalizedAuthorId) return;
    await writePolicy((currentPolicy) => {
      const currentAllowlist = connectorList(currentPolicy.allowlist, SLACK_CONNECTOR);
      const nextAllowlist = withoutValue(currentAllowlist, normalizedAuthorId);
      return {
        ...currentPolicy,
        allowlist: {
          ...currentPolicy.allowlist,
          [SLACK_CONNECTOR]: nextAllowlist,
        },
      };
    });
  }, [writePolicy]);

  const removeFromBlocklist = useCallback(async (authorId: string): Promise<void> => {
    const normalizedAuthorId = isCanonicalSlackUserId(authorId)
      ? normalizeSlackAuthorId(authorId)
      : authorId;
    if (!normalizedAuthorId) return;
    await writePolicy((currentPolicy) => {
      const currentBlocklist = connectorList(currentPolicy.blocklist, SLACK_CONNECTOR);
      const nextBlocklist = withoutValue(currentBlocklist, normalizedAuthorId);
      return {
        ...currentPolicy,
        blocklist: {
          ...currentPolicy.blocklist,
          [SLACK_CONNECTOR]: nextBlocklist,
        },
      };
    });
  }, [writePolicy]);

  const reresolveLegacyAllowlistEntry = useCallback(async (legacyEntry: string): Promise<AddAuthorResult> => {
    const resolved = await resolveSlackAuthorViaIpc(legacyEntry);
    if (!resolved.ok || !resolved.canonicalId) return resolved;
    const canonicalId = resolved.canonicalId;
    captureMetadata(resolved);
    await writePolicy((currentPolicy) => {
      const currentAllowlist = connectorList(currentPolicy.allowlist, SLACK_CONNECTOR);
      const currentBlocklist = connectorList(currentPolicy.blocklist, SLACK_CONNECTOR);
      const nextAllowlist = addUniqueValue(withoutValue(currentAllowlist, legacyEntry), canonicalId);
      const nextBlocklist = withoutValue(currentBlocklist, canonicalId);
      return {
        ...currentPolicy,
        allowlist: { ...currentPolicy.allowlist, [SLACK_CONNECTOR]: nextAllowlist },
        blocklist: { ...currentPolicy.blocklist, [SLACK_CONNECTOR]: nextBlocklist },
      };
    });
    return resolved;
  }, [writePolicy, captureMetadata]);

  const reresolveLegacyBlocklistEntry = useCallback(async (legacyEntry: string): Promise<AddAuthorResult> => {
    const resolved = await resolveSlackAuthorViaIpc(legacyEntry);
    if (!resolved.ok || !resolved.canonicalId) return resolved;
    const canonicalId = resolved.canonicalId;
    captureMetadata(resolved);
    await writePolicy((currentPolicy) => {
      const currentAllowlist = connectorList(currentPolicy.allowlist, SLACK_CONNECTOR);
      const currentBlocklist = connectorList(currentPolicy.blocklist, SLACK_CONNECTOR);
      const nextBlocklist = addUniqueValue(withoutValue(currentBlocklist, legacyEntry), canonicalId);
      const nextAllowlist = withoutValue(currentAllowlist, canonicalId);
      return {
        ...currentPolicy,
        allowlist: { ...currentPolicy.allowlist, [SLACK_CONNECTOR]: nextAllowlist },
        blocklist: { ...currentPolicy.blocklist, [SLACK_CONNECTOR]: nextBlocklist },
      };
    });
    return resolved;
  }, [writePolicy, captureMetadata]);

  const setSurfaceTrusted = useCallback(async (
    connector: InboundAuthorConnector,
    surfaceIds: string[],
  ): Promise<void> => {
    const normalizedSurfaceIds = asUnique(surfaceIds.map(normalizeSurfaceId).filter(Boolean));
    await writePolicy((currentPolicy) => ({
      ...currentPolicy,
      surfaceTrusted: {
        ...currentPolicy.surfaceTrusted,
        [connector]: normalizedSurfaceIds,
      },
    }));
  }, [writePolicy]);

  const addToAgentAllowlist = useCallback(async (
    connector: InboundAuthorConnector,
    instanceId: string,
  ): Promise<void> => {
    const normalizedInstanceId = instanceId.trim();
    if (!normalizedInstanceId) return;
    await writePolicy((currentPolicy) => {
      const currentAgentAllowlist = connectorList(currentPolicy.agentAllowlist, connector);
      const nextAgentAllowlist = addUniqueValue(currentAgentAllowlist, normalizedInstanceId);
      return {
        ...currentPolicy,
        agentAllowlist: {
          ...currentPolicy.agentAllowlist,
          [connector]: nextAgentAllowlist,
        },
      };
    });
  }, [writePolicy]);

  const dismissUpgradeReviewNotice = useCallback(async (): Promise<void> => {
    await writePolicy((currentPolicy) => ({
      ...currentPolicy,
      notices: {
        ...currentPolicy.notices,
        upgradeReviewPending: false,
      },
    }));
  }, [writePolicy]);

  const markUpgradeReviewDismissedNow = useCallback(() => {
    writeDismissedAt(Date.now());
  }, []);

  const legacyAllowlistSlack = useMemo(
    () => partitionSlackPolicyEntries(policy.allowlist[SLACK_CONNECTOR] ?? []).legacy,
    [policy.allowlist],
  );
  const legacyBlocklistSlack = useMemo(
    () => partitionSlackPolicyEntries(policy.blocklist[SLACK_CONNECTOR] ?? []).legacy,
    [policy.blocklist],
  );

  return useMemo(() => ({
    policy,
    inboundAuthorPolicyBypassActive,
    legacyAllowlistSlack,
    legacyBlocklistSlack,
    slackAuthorMetadata,
    setMode,
    addToAllowlist,
    addToBlocklist,
    removeFromAllowlist,
    removeFromBlocklist,
    reresolveLegacyAllowlistEntry,
    reresolveLegacyBlocklistEntry,
    setSurfaceTrusted,
    addToAgentAllowlist,
    dismissUpgradeReviewNotice,
    markUpgradeReviewDismissedNow,
  }), [
    policy,
    inboundAuthorPolicyBypassActive,
    legacyAllowlistSlack,
    legacyBlocklistSlack,
    slackAuthorMetadata,
    setMode,
    addToAllowlist,
    addToBlocklist,
    removeFromAllowlist,
    removeFromBlocklist,
    reresolveLegacyAllowlistEntry,
    reresolveLegacyBlocklistEntry,
    setSurfaceTrusted,
    addToAgentAllowlist,
    dismissUpgradeReviewNotice,
    markUpgradeReviewDismissedNow,
  ]);
}
