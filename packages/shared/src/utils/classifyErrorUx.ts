import type { AgentErrorKind } from './agentErrorCatalog';

export type AgentErrorCategory =
  | 'transient'
  | 'user-fixable'
  | 'system-broken'
  | 'unsupported-feature'
  | 'unknown';

type BillingSubtype =
  | 'credits'
  | 'key_limit'
  | 'spend_limit'
  | 'free_tier_exhausted'
  | 'negative_balance'
  | 'unknown';

export type AgentErrorResolutionAction = {
  label: string;
  action:
    | 'switch-model'
    | 'switch-provider'
    | 'open-settings'
    | 'retry'
    // 260622 Stage 4: Chief-of-Staff recovery verbs.
    // - `recreate-chief-of-staff` re-provisions the README from the starter
    //   template (main-process `ensureChiefOfStaffSpace`) then retries the turn.
    // - `proceed-without-chief-of-staff` re-runs THIS turn once on the generic
    //   template, with the bypass flag set so admission admits — observable
    //   (logged), never a silent degrade.
    | 'recreate-chief-of-staff'
    | 'proceed-without-chief-of-staff';
  payload?: {
    model?: string;
    provider?: 'codex' | 'anthropic' | 'openrouter' | 'openai';
    settingsSection?: string;
    /**
     * FOX-3494: the route role whose model the switch should repair. When
     * `planning`, the switch-model handler updates the thinking slot
     * (`thinkingModel`/`thinkingProfileId`) so a planning-role failure does not
     * retry straight back into the same Claude planning terminal.
     */
    failedRole?: 'execution' | 'planning' | 'bts' | 'subagent';
  };
  variant?: 'primary' | 'secondary';
};

export type AgentErrorResolution = {
  category: AgentErrorCategory;
  kind: AgentErrorKind;
  title: string;
  body: string;
  alternatives: AgentErrorResolutionAction[];
  defaultAction?: AgentErrorResolutionAction;
  persistent: boolean;
};

export type ClassifyErrorUxInput = {
  errorKind: AgentErrorKind;
  rawMessage: string;
  provider?: string;
  limitScope?: 'provider' | 'plan' | 'account';
  upstreamProviderName?: string;
  billingMeta?: { subtype: BillingSubtype; upstreamProviderName?: string };
  rateLimitMeta?: { retryAfterMs?: number; resetAtMs?: number };
  settingsContext?: {
    activeProvider: 'codex' | 'anthropic' | 'openrouter' | 'local' | 'mindstone';
    currentModel?: string;
    hasAnthropicCredentials: boolean;
    hasOpenRouterCredentials: boolean;
    hasCodexSubscription: boolean;
    /**
     * Selectable model profiles that can serve a model (slim projection: id, name,
     * bare model id). When a recoverable "model can't run on the active provider"
     * terminal fires and one of these serves the failed model (e.g. a custom
     * OpenAI-compatible gateway proxying `claude-opus-4-8`), the recovery leads with
     * "Use <profile>" — a `switch-model` to `profile:<id>` that routes through that
     * profile's provider — instead of dead-ending on "switch provider / add a key".
     */
    recoveryProfiles?: ReadonlyArray<{ id: string; name: string; model: string }>;
  };
  unsupportedModelId?: string;
  /**
   * FOX-3494: the route-decision `invalidReason` carried on a
   * `ConnectionNotConfiguredError`. Lets the `connection-not-configured` branch
   * discriminate the model-aware "Claude isn't available on ChatGPT Pro" case
   * (`missing-anthropic-credentials-for-claude-model`) precisely, rather than
   * inferring it from `activeProvider` + a `claude-` prefix.
   */
  invalidReason?: string;
  /**
   * FOX-3494: the route role the failure originated from. Carried into the
   * switch-model recovery payload so the handler repairs the correct settings
   * slot (planning→thinking, else working).
   */
  failedRole?: 'execution' | 'planning' | 'bts' | 'subagent';
  /**
   * The cause carried by a `chief-of-staff-unavailable` error (260622 Stage 3):
   * - `reconnecting` — a dead/slow cloud mount; the file is presumed present.
   * - `unreadable` — the file exists but a non-absence fs error blocked the read.
   * - `missing-after-setup` — genuinely absent AFTER onboarding completed.
   * Stage 4 branches the recovery copy/actions on this; Stage 3 supplies the
   * minimal placeholder resolution so the kind is valid and categorized.
   */
  chiefOfStaffReason?: 'reconnecting' | 'unreadable' | 'missing-after-setup';
};

const CATEGORY_BY_KIND = {
  rate_limit: 'transient',
  server_error: 'transient',
  network: 'transient',
  message_timeout: 'transient',
  process_exit: 'transient',
  auth: 'user-fixable',
  'connection-not-configured': 'user-fixable',
  billing: 'user-fixable',
  moderation: 'user-fixable',
  invalid_request: 'user-fixable',
  context_overflow: 'system-broken',
  model_unavailable: 'unsupported-feature',
  unsupported_model: 'unsupported-feature',
  // NOT transient (isTransientError is kind-first): retry re-sends the same
  // image-bearing history and re-fails. Persistent falls out of the category.
  image_input_unsupported: 'unsupported-feature',
  managed_model_not_allowed: 'user-fixable',
  routing: 'system-broken',
  session_not_found: 'user-fixable',
  tool_name_corrupt: 'system-broken',
  mcp_error: 'user-fixable',
  user_action: 'transient',
  // Chief-of-Staff instructions unreadable at admission. Default category is
  // `user-fixable` (the common terminal causes — `unreadable`, `missing-after-
  // setup` — need user action). Stage 4 refines the per-reason copy/actions and
  // may treat `reconnecting` as transient via the resolution branch.
  'chief-of-staff-unavailable': 'user-fixable',
  unknown: 'unknown',
} as const satisfies Record<AgentErrorKind, AgentErrorCategory>;

const DEFAULT_SUPPORTED_CODEX_MODEL = 'gpt-5.5';

export function categoryForKind(kind: AgentErrorKind): AgentErrorCategory {
  return CATEGORY_BY_KIND[kind];
}

export function classifyErrorUx(
  input: ClassifyErrorUxInput,
): AgentErrorResolution {
  switch (input.errorKind) {
    case 'rate_limit':
      return resolution(input.errorKind, {
        title: 'Rate limit reached.',
        body: formatRateLimitBody(input),
        alternatives: [retryAction('Try again')],
      });
    case 'server_error':
      return resolution(input.errorKind, {
        title: 'The AI service had a moment.',
        body: 'Your message is safe. Retry when the plumbing has stopped sulking.',
        alternatives: [retryAction('Try again')],
      });
    case 'network':
      return resolution(input.errorKind, {
        title: "Can't reach the AI service.",
        body: 'Rebel got as far as your network and stopped — usually a connection issue on this device (a dropped wifi, a VPN, or a protective corporate network). Your message is safe.',
        alternatives: [
          retryAction('Try again'),
          openSettingsAction('Check connections', 'diagnose', 'secondary'),
        ],
      });
    case 'message_timeout':
      return resolution(input.errorKind, {
        title: 'That took too long.',
        body: 'The turn timed out before a useful answer arrived. Your message is safe.',
        alternatives: [retryAction('Try again')],
      });
    case 'process_exit':
      return resolution(input.errorKind, {
        title: 'The AI process stopped.',
        body: 'The local worker exited mid-turn. Retry and Rebel will start fresh.',
        alternatives: [retryAction('Try again')],
      });
    case 'auth':
      if (input.settingsContext?.activeProvider === 'mindstone') {
        return resolution(input.errorKind, {
          title: 'Mindstone subscription needs attention.',
          body: 'Your Mindstone subscription credentials were rejected. Check your subscription status in Settings.',
          alternatives: [openSettingsAction('Open settings', 'subscription')],
        });
      }
      return resolution(input.errorKind, {
        title: 'Credentials need attention.',
        body: 'Your AI provider rejected the credentials. Settings is the least dramatic fix.',
        alternatives: [openSettingsAction('Open settings', 'providerKeys')],
      });
    case 'connection-not-configured':
      // Derive the provider from settingsContext.activeProvider — the provider
      // the user actually selected — NOT input.provider (which is "OpenAI" on a
      // codex turn). The turn failed pre-flight in admission, so nothing was
      // rejected: name the real provider and the truthful recovery.
      {
      // FOX-3494: a native-Claude (claude-*) model selected for a PRIMARY turn
      // under a connected ChatGPT Pro subscription with no Anthropic key
      // dead-ends (Claude runs on Anthropic, which isn't connected). Discriminate
      // on the EXACT route reason — not just `activeProvider==='codex'` + a
      // `claude-` prefix — so this only fires for the route that actually minted
      // it. Lead with switching to a GPT model; secondary is adding an Anthropic
      // key. Honest, model-aware attribution — never a bare "Anthropic not
      // connected". The kept ConnectionNotConfiguredError class preserves every
      // existing recoverable-terminal gate; this branch supplies the actionable
      // recovery the renderer shows.
      const claudeUnderCodex = classifyClaudeUnderCodex(input);
      if (claudeUnderCodex) return claudeUnderCodex;

      const activeProvider = input.settingsContext?.activeProvider;
      // Lead with the user's own profile that serves the failed model when one exists
      // (e.g. a custom gateway proxying the model) — applied across every provider case.
      const profileAction = profileRecoveryAction(input);
      const lead = (
        copy: { title: string; body: string; alternatives: AgentErrorResolutionAction[] },
      ): AgentErrorResolution =>
        resolution(input.errorKind, {
          ...copy,
          alternatives: profileAction ? [profileAction, ...copy.alternatives] : copy.alternatives,
        });
      switch (activeProvider) {
        case 'codex':
          return lead({
            title: 'ChatGPT Pro is disconnected.',
            body: 'Reconnect it in Settings, or switch to another provider. Your message is safe.',
            alternatives: [openSettingsAction('Reconnect', 'providerKeys')],
          });
        case 'openrouter':
          return lead({
            title: 'OpenRouter is disconnected.',
            body: 'Reconnect it in Settings, or switch to another provider. Your message is safe.',
            alternatives: [openSettingsAction('Reconnect', 'providerKeys')],
          });
        case 'anthropic':
          return lead({
            title: 'No Anthropic key yet.',
            body: 'Add your Anthropic API key in Settings, then try again. Your message is safe.',
            alternatives: [openSettingsAction('Add key', 'providerKeys')],
          });
        case 'mindstone':
          return lead({
            title: 'Mindstone subscription not ready.',
            body: "Your Mindstone subscription isn't ready yet. Open subscription settings, then try again.",
            alternatives: [openSettingsAction('Open settings', 'subscription')],
          });
        case 'local':
        case undefined:
          return lead({
            title: 'Connection not configured.',
            body: 'Connect the provider in Settings, then try again.',
            alternatives: [openSettingsAction('Open settings', 'providerKeys')],
          });
        default: {
          const _exhaustive: never = activeProvider;
          void _exhaustive;
          return lead({
            title: 'Connection not configured.',
            body: 'Connect the provider in Settings, then try again.',
            alternatives: [openSettingsAction('Open settings', 'providerKeys')],
          });
        }
      }
      }
    case 'billing':
      return resolution(input.errorKind, {
        title: 'Billing needs attention.',
        body: formatBillingBody(input),
        alternatives: [openSettingsAction('Open settings', 'billing')],
      });
    case 'moderation':
      return resolution(input.errorKind, {
        title: 'The model declined that message.',
        body: 'Try rephrasing with more context. Models enjoy manners almost as much as constraints.',
        alternatives: [retryAction('Try again')],
      });
    case 'invalid_request': {
      // Gemini behind an OpenAI-compatible gateway fails tool-calling turns when the
      // gateway can't round-trip the model's tool-call signature across steps (REBEL-5RJ
      // variant 2): "Function call is missing a thought_signature in functionCall parts".
      // The raw message is accurate but cryptic — give actionable, non-technical copy.
      if (/thought[\s_-]?signature/i.test(input.rawMessage ?? '')) {
        return resolution(input.errorKind, {
          title: "This model can't use its tools through your current setup.",
          body: 'The gateway it’s reached through drops information the model needs to call tools across steps, so tool use fails. Pick a model your provider fully supports, or ask whoever runs the gateway to preserve tool-call data between turns.',
          alternatives: [
            retryAction('Try again'),
            openSettingsAction('Open settings', 'models', 'secondary'),
          ],
        });
      }
      // Surface the provider's actual rejection reason when we have one (e.g. a gateway
      // 400 that names an unsupported parameter), so the user sees WHY instead of generic
      // copy. Falls back to the generic line when there's no meaningful message.
      const detail = cleanUpstreamErrorMessage(input.rawMessage);
      return resolution(input.errorKind, {
        title: 'The AI service rejected the request.',
        body: detail
          ? `${detail} Your message is safe — try again, or adjust the model or thinking level in Settings.`
          : 'Your message is safe. Try again, or adjust the model in Settings if it keeps happening.',
        alternatives: [
          retryAction('Try again'),
          openSettingsAction('Open settings', 'models', 'secondary'),
        ],
      });
    }
    case 'context_overflow':
      return resolution(input.errorKind, {
        title: 'This conversation got too long.',
        body: 'Rebel needs to summarize before continuing. The filing cabinet is full, not haunted.',
        alternatives: [retryAction('Try again')],
      });
    case 'model_unavailable':
      return resolution(input.errorKind, {
        title: 'That model is not available.',
        body: 'Pick another model in Settings to keep going.',
        alternatives: [openSettingsAction('Open settings', 'models')],
      });
    case 'unsupported_model':
      return classifyUnsupportedModel(input);
    case 'image_input_unsupported':
      // LEAD with switch-model (DA F2, 260610 plan): when the image came from
      // a tool result it is baked into history, so "remove the image and try
      // again" is impossible and retry loops forever. Remove-the-attachment is
      // mentioned only as the secondary clause for the attachment case.
      return resolution(input.errorKind, {
        title: "This model can't view images.",
        body: 'Switch to a vision-capable model to continue this conversation. If you just attached the image, you can also remove it and resend.',
        alternatives: [
          openSettingsAction('Switch model', 'models'),
          retryAction('Try again', 'secondary'),
        ],
      });
    case 'managed_model_not_allowed':
      return resolution(input.errorKind, {
        title: 'That model is not in your subscription plan.',
        body: 'Pick a model included in your plan, or upgrade in Settings.',
        alternatives: [
          openSettingsAction('Open settings', 'models'),
          retryAction('Try again', 'secondary'),
        ],
      });
    case 'routing':
      return resolution(input.errorKind, {
        title: 'Rebel hit a snag in the plumbing.',
        body: 'Not your message — something on our end. Your work is saved.',
        alternatives: [
          retryAction('Try again'),
          openSettingsAction('Open Diagnose', 'diagnose', 'secondary'),
        ],
      });
    case 'session_not_found':
      return resolution(input.errorKind, {
        title: 'This conversation could not be found.',
        body: 'Start a fresh conversation and continue from there. Annoying, but recoverable.',
        alternatives: [retryAction('Try again')],
      });
    case 'tool_name_corrupt':
      return resolution(input.errorKind, {
        title: 'A tool name broke in transit.',
        body: 'The connector returned something Rebel cannot safely call. Try again after a reset.',
        alternatives: [
          retryAction('Try again'),
          openSettingsAction('Open settings', 'connectors', 'secondary'),
        ],
      });
    case 'mcp_error':
      return resolution(input.errorKind, {
        title: 'A connector needs attention.',
        body: 'Open Settings to check the connector, then try again.',
        alternatives: [
          openSettingsAction('Open settings', 'connectors'),
          retryAction('Try again', 'secondary'),
        ],
      });
    case 'user_action':
      return resolution(input.errorKind, {
        title: 'Stopped.',
        body: 'You stopped the turn. Rebel will pretend this was graceful.',
        alternatives: [],
      });
    case 'chief-of-staff-unavailable':
      return classifyChiefOfStaffUnavailable(input);
    case 'unknown':
      return resolution(input.errorKind, {
        title: 'Something went sideways.',
        body: 'Your message is safe. Try again, or check Settings → Diagnose.',
        alternatives: [
          retryAction('Try again'),
          openSettingsAction('Open Diagnose', 'diagnose', 'secondary'),
        ],
      });
    default: {
      const _exhaustive: never = input.errorKind;
      void _exhaustive;
      return resolution('unknown', {
        title: 'Something went sideways.',
        body: 'Your message is safe. Try again.',
        alternatives: [retryAction('Try again')],
      });
    }
  }
}

/**
 * 260622 Stage 4: Chief-of-Staff instructions unreadable at admission. Three
 * causes (per the Chief-Designer matrix), each a distinct recovery resolution.
 * Copy is dry/calm/non-technical — the user must conclude "Rebel paused because
 * it couldn't reach my instructions", never "the AI broke" or "my data is gone".
 * We never interpolate raw errno / mount paths into the body (BRAND_VOICE).
 *
 * - `reconnecting` (dead/slow drive, file presumed present): `transient`/info.
 *   "Try again" re-probes the drive; the explicit "Run without my instructions"
 *   escape is always offered as the second action so the user is NEVER trapped
 *   on a dead drive (the user's allow-proceed-with-warning decision). The notice
 *   is dismissible (transient), and the next turn re-evaluates the drive — so a
 *   drive that comes back resumes normally without the escape being sticky.
 * - `unreadable` (exists but EACCES/EISDIR/corrupt): `user-fixable`/warning.
 *   "Try again" + "Open the file" (reveal the README so the user can fix it).
 * - `missing-after-setup` (onboarding completed, README genuinely gone):
 *   `user-fixable`/warning. "Recreate from template" + "Run without my
 *   instructions" so the user is never trapped.
 *
 * An absent README BEFORE onboarding completes is legitimate first-run and never
 * reaches admission's block (Stage 3 gates it) — so it never reaches here.
 */
function classifyChiefOfStaffUnavailable(
  input: ClassifyErrorUxInput,
): AgentErrorResolution {
  const reason = input.chiefOfStaffReason;
  switch (reason) {
    case 'reconnecting':
      return resolutionWithCategory('transient', input.errorKind, {
        title: 'Reconnecting to your drive.',
        body: "Rebel paused this turn because it can't reach your drive right now, where your Chief-of-Staff instructions live. Try again once it's back, or run this turn without your instructions just this once.",
        alternatives: [
          retryAction('Try again'),
          // Always offered (never trap the user on a dead drive). The next turn
          // re-evaluates the drive, so it isn't sticky when the drive returns.
          proceedWithoutChiefOfStaffAction('Run without my instructions', 'secondary'),
        ],
      });
    case 'unreadable':
      return resolutionWithCategory('user-fixable', input.errorKind, {
        title: "Can't read your Chief-of-Staff instructions.",
        body: "The file is there, but Rebel couldn't open it, usually a permissions issue or the file got into a bad state. Fix the file, then try again.",
        alternatives: [
          retryAction('Try again'),
          openChiefOfStaffReadmeAction('Open the file', 'secondary'),
        ],
      });
    case 'missing-after-setup':
      return resolutionWithCategory('user-fixable', input.errorKind, {
        title: 'Your Chief-of-Staff instructions are missing.',
        body: "Rebel set these up for you during onboarding, but the file isn't where it should be, it may have been moved or deleted. Recreate it from the starter template and you're back in business.",
        alternatives: [
          recreateChiefOfStaffAction('Recreate from template'),
          proceedWithoutChiefOfStaffAction('Run without my instructions', 'secondary'),
        ],
      });
    case undefined:
    default: {
      // No reason supplied (defensive): a calm, recoverable single-action
      // fallback. Stays `user-fixable` (the kind's default category).
      return resolutionWithCategory('user-fixable', input.errorKind, {
        title: "Rebel can't read your Chief-of-Staff instructions.",
        body: 'Your Chief-of-Staff instructions are unavailable right now. Your message is safe.',
        alternatives: [retryAction('Try again')],
      });
    }
  }
}

/**
 * FOX-3494: actionable recovery for a native-Claude (`claude-*`) model selected
 * for a PRIMARY user turn under a connected ChatGPT Pro subscription with no
 * Anthropic key. Returns the model-aware "Switch to a GPT model" resolution, or
 * `undefined` when this is not that case (the caller falls through to the generic
 * connection-not-configured copy). Discriminates on the exact route reason so it
 * can't mis-fire on an unrelated connection-not-configured.
 */
function classifyClaudeUnderCodex(
  input: ClassifyErrorUxInput,
): AgentErrorResolution | undefined {
  if (input.invalidReason !== 'missing-anthropic-credentials-for-claude-model') {
    return undefined;
  }
  const settings = input.settingsContext;
  // The producer only mints this reason under active codex; the renderer-side
  // copy is codex-flavoured, so require it here too as defence in depth.
  if (settings?.activeProvider !== 'codex') return undefined;
  const claudeModel = input.unsupportedModelId;
  const gptModel = supportedModelFallback(undefined, settings?.currentModel);
  // Lead with the user's own profile that serves this model (e.g. a gateway that
  // proxies Claude) when one exists — it actually runs the model they picked.
  const profileAction = profileRecoveryAction(input);
  return resolution(input.errorKind, {
    title: "Claude isn't available on ChatGPT Pro.",
    body: `You're connected to ChatGPT Pro, but the selected model — ${
      formatModelLabel(claudeModel ?? 'Claude')
    } — runs on Anthropic, which isn't connected. Your message is safe.`,
    alternatives: [
      ...(profileAction ? [profileAction] : []),
      switchModelAction(`Switch to ${formatModelLabel(gptModel)}`, gptModel, input.failedRole),
      openSettingsAction('Add an Anthropic key', 'providerKeys', 'secondary'),
    ],
  });
}

function classifyUnsupportedModel(
  input: ClassifyErrorUxInput,
): AgentErrorResolution {
  const settings = input.settingsContext;

  const hasSameProviderAlternative =
    (!settings || (settings.activeProvider === 'codex' && settings.hasCodexSubscription)) &&
    (input.unsupportedModelId !== DEFAULT_SUPPORTED_CODEX_MODEL ||
      settings?.currentModel !== DEFAULT_SUPPORTED_CODEX_MODEL);

  if (!hasSameProviderAlternative) {
    return resolution(input.errorKind, {
      title: "This model isn't available on your subscription.",
      body: 'Choose another to keep going.',
      alternatives: [openSettingsAction('Choose another', 'model')],
    });
  }

  const model = supportedModelFallback(
    input.unsupportedModelId,
    settings?.currentModel,
  );
  return resolution(input.errorKind, {
    title: "ChatGPT Pro doesn't run GPT-5.5 Pro.",
    body: 'Pick a model that works on your subscription, or switch providers.',
    alternatives: [
      switchModelAction(`Use ${formatModelLabel(model)}`, model),
      openSettingsAction('Open settings', 'providerKeys', 'secondary'),
    ],
  });
}

const MAX_ALTERNATIVES = 2;

function resolution(
  kind: AgentErrorKind,
  options: {
    title: string;
    body: string;
    alternatives: AgentErrorResolutionAction[];
    defaultAction?: AgentErrorResolutionAction;
  },
): AgentErrorResolution {
  const category = categoryForKind(kind);
  const alternatives = options.alternatives.slice(0, MAX_ALTERNATIVES);
  const defaultAction = options.defaultAction ?? alternatives[0];
  const base = {
    category,
    kind,
    title: options.title,
    body: options.body,
    alternatives,
    persistent: isPersistent(category),
  };
  return defaultAction ? { ...base, defaultAction } : base;
}

/**
 * Like `resolution()` but with an explicit category, for kinds whose tone varies
 * by sub-reason rather than being fixed by the kind alone (e.g.
 * `chief-of-staff-unavailable`: `reconnecting` is transient/info, the others are
 * user-fixable/warning). Persistence still derives from the (overridden)
 * category, so a transient reconnecting notice stays dismissible while a blocking
 * user-fixable one persists.
 */
function resolutionWithCategory(
  category: AgentErrorCategory,
  kind: AgentErrorKind,
  options: {
    title: string;
    body: string;
    alternatives: AgentErrorResolutionAction[];
    defaultAction?: AgentErrorResolutionAction;
  },
): AgentErrorResolution {
  const alternatives = options.alternatives.slice(0, MAX_ALTERNATIVES);
  const defaultAction = options.defaultAction ?? alternatives[0];
  const base = {
    category,
    kind,
    title: options.title,
    body: options.body,
    alternatives,
    persistent: isPersistent(category),
  };
  return defaultAction ? { ...base, defaultAction } : base;
}

function isPersistent(category: AgentErrorCategory): boolean {
  return (
    category === 'user-fixable' ||
    category === 'system-broken' ||
    category === 'unsupported-feature' ||
    category === 'unknown'
  );
}

function retryAction(
  label: string,
  variant: AgentErrorResolutionAction['variant'] = 'primary',
): AgentErrorResolutionAction {
  return { label, action: 'retry', variant };
}

function openSettingsAction(
  label: string,
  settingsSection: string,
  variant: AgentErrorResolutionAction['variant'] = 'primary',
): AgentErrorResolutionAction {
  return {
    label,
    action: 'open-settings',
    payload: { settingsSection },
    variant,
  };
}

// 260622 Stage 4 Chief-of-Staff recovery actions. The renderer maps each verb
// to behaviour (recreate → ensureChiefOfStaffSpace + retry; proceed-without →
// logged template-bypass retry; open-the-file → reveal the README via the
// open-settings reveal-path seam). They carry no payload — the failed-turn id
// and the README path are resolved renderer/main-side.
function recreateChiefOfStaffAction(
  label: string,
  variant: AgentErrorResolutionAction['variant'] = 'primary',
): AgentErrorResolutionAction {
  return { label, action: 'recreate-chief-of-staff', variant };
}

function proceedWithoutChiefOfStaffAction(
  label: string,
  variant: AgentErrorResolutionAction['variant'] = 'primary',
): AgentErrorResolutionAction {
  return { label, action: 'proceed-without-chief-of-staff', variant };
}

// "Open the file" reveals the Chief-of-Staff README in the OS file manager. It
// reuses the existing `open-settings` action verb with a sentinel
// `settingsSection: 'reveal-chief-of-staff-readme'` so no third Chief-of-Staff
// verb is added to the union (the renderer intercepts this section and reveals
// the README rather than opening Settings).
function openChiefOfStaffReadmeAction(
  label: string,
  variant: AgentErrorResolutionAction['variant'] = 'secondary',
): AgentErrorResolutionAction {
  return {
    label,
    action: 'open-settings',
    payload: { settingsSection: 'reveal-chief-of-staff-readme' },
    variant,
  };
}

type SwitchModelFailedRole = NonNullable<AgentErrorResolutionAction['payload']>['failedRole'];

function switchModelAction(
  label: string,
  model: string,
  failedRole?: SwitchModelFailedRole,
): AgentErrorResolutionAction {
  return {
    label,
    action: 'switch-model',
    payload: failedRole ? { model, failedRole } : { model },
    variant: 'primary',
  };
}

// Normalize a model id for matching a failed model against a profile's model:
// case-insensitive, strip the `[1m]` extended-context suffix and any provider
// prefix (`anthropic/claude-opus-4-8` → `claude-opus-4-8`).
function normalizeModelForMatch(model: string | undefined): string | undefined {
  const trimmed = model?.trim().toLowerCase().replace(/\[1m\]$/i, '');
  if (!trimmed) return undefined;
  const slash = trimmed.lastIndexOf('/');
  const bare = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  // Claude dotted aliases (`claude-opus-4.8`) vs catalog dashes (`claude-opus-4-8`).
  // Scoped to `claude-` so it can't corrupt dotted GPT ids (`gpt-5.5`). (Review F3.)
  return bare.startsWith('claude-') ? bare.replace(/\./g, '-') : bare;
}

// When the failed model is served by one of the user's selectable profiles (e.g. a
// custom OpenAI-compatible gateway proxying the model), return a "Use <profile>"
// switch-model action targeting `profile:<id>` — which the IPC handler pins as the
// working/thinking profile so the turn routes through that profile's provider.
function profileRecoveryAction(
  input: ClassifyErrorUxInput,
): AgentErrorResolutionAction | undefined {
  const failed = normalizeModelForMatch(input.unsupportedModelId);
  if (!failed) return undefined;
  const profiles = input.settingsContext?.recoveryProfiles;
  if (!profiles?.length) return undefined;
  const match = profiles.find((p) => normalizeModelForMatch(p.model) === failed);
  if (!match) return undefined;
  return switchModelAction(`Use ${match.name}`, `profile:${match.id}`, input.failedRole);
}

function supportedModelFallback(
  unsupportedModelId: string | undefined,
  currentModel: string | undefined,
): string {
  if (
    unsupportedModelId &&
    unsupportedModelId !== DEFAULT_SUPPORTED_CODEX_MODEL
  ) {
    return DEFAULT_SUPPORTED_CODEX_MODEL;
  }
  if (currentModel && currentModel !== DEFAULT_SUPPORTED_CODEX_MODEL) {
    return DEFAULT_SUPPORTED_CODEX_MODEL;
  }
  return DEFAULT_SUPPORTED_CODEX_MODEL;
}

// A short, readable label for a model id without depending on the full model
// catalog (which lives in `src/shared` and cannot be imported here without
// inverting the package dependency). Turns `claude-opus-4-8` → "Claude Opus 4 8"
// and `gpt-5.5` → "GPT-5.5"; unknown shapes degrade to the raw id. FOX-3494 F4:
// nicer than a raw `toUpperCase()` while staying self-contained.
function formatModelLabel(model: string): string {
  const stripped = model.replace(/\[1m\]$/i, '');
  if (/^gpt[-.]/i.test(stripped)) return stripped.toUpperCase();
  if (/^claude-/i.test(stripped)) {
    return stripped
      .split('-')
      .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join(' ');
  }
  return stripped;
}

// A user-facing one-liner from an upstream provider error message. The message reaching
// here is already the extracted provider message (modelErrors.extractHttpErrorMessage),
// so we only need light hygiene: drop empty/placeholder values, collapse whitespace, and
// bound the length so a verbose body can't blow up the notice. Ends with a period.
function cleanUpstreamErrorMessage(raw: string | undefined): string | undefined {
  const trimmed = raw?.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed === '{}' || trimmed.length < 4) return undefined;
  const bounded = trimmed.length > 240 ? `${trimmed.slice(0, 239)}…` : trimmed;
  return /[.!?…]$/.test(bounded) ? bounded : `${bounded}.`;
}

function formatBillingBody(input: ClassifyErrorUxInput): string {
  if (input.limitScope === 'plan') {
    return 'Your subscription plan has hit its usage allowance. Open Settings to switch plans or provider.';
  }

  const provider =
    input.billingMeta?.upstreamProviderName ??
    input.upstreamProviderName ??
    input.provider;
  const providerPrefix = provider ? `${provider} says ` : '';
  const subtype = input.billingMeta?.subtype;
  switch (subtype) {
    case 'credits':
      return `${providerPrefix}the account needs more credits. Settings will know where the bodies are buried.`;
    case 'negative_balance':
      return `${providerPrefix}the account has a negative balance. Even free models insist on bookkeeping.`;
    case 'key_limit':
      return `${providerPrefix}the key hit its usage limit. Try later or adjust provider settings.`;
    case 'spend_limit':
      return `${providerPrefix}the spending limit is doing its job. Open Settings to change course.`;
    case 'free_tier_exhausted':
      return `${providerPrefix}today's free-tier allowance is used up. The meter is real, apparently.`;
    case 'unknown':
    case undefined:
      return `${providerPrefix}there is a billing issue. Open Settings to inspect the damage.`;
    default: {
      const _exhaustive: never = subtype;
      void _exhaustive;
      return 'There is a billing issue. Open Settings to inspect the damage.';
    }
  }
}

function formatRateLimitBody(input: ClassifyErrorUxInput): string {
  if (input.limitScope === 'plan') {
    if (input.rateLimitMeta?.retryAfterMs) {
      const seconds = Math.ceil(input.rateLimitMeta.retryAfterMs / 1000);
      return `Your subscription usage window is tapped out. Try again in about ${seconds} seconds, or switch providers in Settings.`;
    }
    return 'Your subscription usage window is tapped out. Try again when it resets, or switch providers in Settings.';
  }

  if (input.rateLimitMeta?.retryAfterMs) {
    const seconds = Math.ceil(input.rateLimitMeta.retryAfterMs / 1000);
    return `The provider asked for a breather. Try again in about ${seconds} seconds.`;
  }
  return 'The provider asked for a breather. Try again shortly.';
}
