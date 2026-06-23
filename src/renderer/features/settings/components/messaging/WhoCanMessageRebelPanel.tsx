import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import { Button, Input, Notice, Select } from '@renderer/components/ui';
import { SettingRow } from '../SettingRow';
import { SettingSection } from '../SettingSection';
import {
  useInboundAuthorPolicy,
  type SlackAuthorMetadata,
  type UseInboundAuthorPolicyResult,
} from '../../hooks/useInboundAuthorPolicy';

const SLACK_CONNECTOR = 'slack';

function formatCanonicalChipLabel(
  canonicalId: string,
  metadata: SlackAuthorMetadata | undefined,
): { primary: string; secondary: string | null } {
  const handle = metadata?.handle ? `@${metadata.handle}` : null;
  const displayName = metadata?.displayName ?? null;
  if (displayName && handle) {
    return { primary: `${displayName} (${handle})`, secondary: canonicalId };
  }
  if (handle) {
    return { primary: handle, secondary: canonicalId };
  }
  if (displayName) {
    return { primary: displayName, secondary: canonicalId };
  }
  return { primary: canonicalId, secondary: null };
}

function handleEnter(
  event: KeyboardEvent<HTMLInputElement>,
  action: () => void,
): void {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  action();
}

function EmptyTokenLabel() {
  return (
    <span style={{ color: 'var(--color-text-muted)', fontSize: '0.8rem' }}>
      No entries yet.
    </span>
  );
}

function TokenList({
  values,
  onRemove,
  testIdPrefix,
  metadataByCanonicalId,
}: {
  values: string[];
  onRemove?: (value: string) => void;
  testIdPrefix: string;
  metadataByCanonicalId?: Record<string, SlackAuthorMetadata>;
}) {
  if (values.length === 0) {
    return <EmptyTokenLabel />;
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
      {values.map((value) => {
        const { primary, secondary } = formatCanonicalChipLabel(
          value,
          metadataByCanonicalId?.[value],
        );
        return (
          <span
            key={value}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              padding: '0 var(--space-2)',
              borderRadius: 'var(--radius-pill)',
              border: '1px solid var(--color-border-soft)',
              background: 'var(--color-surface-raised)',
              fontSize: '0.78rem',
              overflowWrap: 'anywhere',
            }}
            data-testid={`${testIdPrefix}-value-${value}`}
          >
            <span>{primary}</span>
            {secondary ? (
              <span style={{ color: 'var(--color-text-muted)' }} data-testid={`${testIdPrefix}-canonical-${value}`}>
                · {secondary}
              </span>
            ) : null}
            {onRemove ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void onRemove(value);
                }}
                aria-label={`Remove ${value}`}
                data-testid={`${testIdPrefix}-remove-${value}`}
              >
                Remove
              </Button>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

function LegacyTokenList({
  values,
  onReresolve,
  onRemove,
  pendingValue,
  testIdPrefix,
}: {
  values: string[];
  onReresolve: (value: string) => Promise<void>;
  onRemove: (value: string) => void;
  pendingValue: string | null;
  testIdPrefix: string;
}) {
  if (values.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
      {values.map((value) => {
        const isPending = pendingValue === value;
        return (
          <span
            key={value}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              padding: '0 var(--space-2)',
              borderRadius: 'var(--radius-pill)',
              border: '1px solid var(--color-border-warning, var(--color-border-soft))',
              background: 'var(--color-surface-warning-soft, var(--color-surface-raised))',
              color: 'var(--color-text-warning, inherit)',
              fontSize: '0.78rem',
              overflowWrap: 'anywhere',
            }}
            data-testid={`${testIdPrefix}-legacy-value-${value}`}
          >
            <span title="Legacy entry — Slack can't match this until you re-resolve it.">
              {value}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => { void onReresolve(value); }}
              disabled={isPending}
              aria-label={`Re-resolve ${value}`}
              data-testid={`${testIdPrefix}-legacy-reresolve-${value}`}
            >
              {isPending ? 'Resolving…' : 'Re-resolve'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onRemove(value)}
              disabled={isPending}
              aria-label={`Remove ${value}`}
              data-testid={`${testIdPrefix}-legacy-remove-${value}`}
            >
              Remove
            </Button>
          </span>
        );
      })}
    </div>
  );
}

export interface WhoCanMessageRebelPanelProps {
  policyState?: UseInboundAuthorPolicyResult;
  slackConnected?: boolean;
  ownerIdentityUnknown?: boolean;
}

export function WhoCanMessageRebelPanel({
  policyState,
  slackConnected = true,
  ownerIdentityUnknown = false,
}: WhoCanMessageRebelPanelProps) {
  const hookedPolicyState = useInboundAuthorPolicy();
  const inboundPolicy = policyState ?? hookedPolicyState;
  const policy = inboundPolicy.policy;
  const inboundAuthorPolicyBypassActive = inboundPolicy.inboundAuthorPolicyBypassActive === true;

  const [allowlistInput, setAllowlistInput] = useState('');
  const [blocklistInput, setBlocklistInput] = useState('');
  const [trustedChannelInput, setTrustedChannelInput] = useState('');
  const [agentAllowlistInput, setAgentAllowlistInput] = useState('');
  const [allowlistError, setAllowlistError] = useState<string | null>(null);
  const [blocklistError, setBlocklistError] = useState<string | null>(null);
  const [allowlistPending, setAllowlistPending] = useState(false);
  const [blocklistPending, setBlocklistPending] = useState(false);
  const [legacyAllowlistPending, setLegacyAllowlistPending] = useState<string | null>(null);
  const [legacyBlocklistPending, setLegacyBlocklistPending] = useState<string | null>(null);

  const legacyAllowlist = inboundPolicy.legacyAllowlistSlack;
  const legacyBlocklist = inboundPolicy.legacyBlocklistSlack;
  const policyAllowlist = inboundPolicy.policy.allowlist;
  const policyBlocklist = inboundPolicy.policy.blocklist;
  const allowlist = useMemo(() => {
    const all = policyAllowlist[SLACK_CONNECTOR] ?? [];
    const legacy = legacyAllowlist ?? [];
    return all.filter((entry) => !legacy.includes(entry));
  }, [policyAllowlist, legacyAllowlist]);
  const blocklist = useMemo(() => {
    const all = policyBlocklist[SLACK_CONNECTOR] ?? [];
    const legacy = legacyBlocklist ?? [];
    return all.filter((entry) => !legacy.includes(entry));
  }, [policyBlocklist, legacyBlocklist]);
  const trustedChannels = useMemo(
    () => policy.surfaceTrusted[SLACK_CONNECTOR] ?? [],
    [policy.surfaceTrusted],
  );
  const agentAllowlist = useMemo(
    () => policy.agentAllowlist[SLACK_CONNECTOR] ?? [],
    [policy.agentAllowlist],
  );

  const addAllowlistEntry = useCallback(async () => {
    const candidate = allowlistInput.trim();
    if (!candidate || allowlistPending) return;
    setAllowlistPending(true);
    setAllowlistError(null);
    try {
      const result = await inboundPolicy.addToAllowlist(candidate);
      if (result.ok) {
        setAllowlistInput('');
      } else {
        setAllowlistError(result.error ?? 'Could not add that Slack user.');
      }
    } finally {
      setAllowlistPending(false);
    }
  }, [allowlistInput, allowlistPending, inboundPolicy]);

  const addBlocklistEntry = useCallback(async () => {
    const candidate = blocklistInput.trim();
    if (!candidate || blocklistPending) return;
    setBlocklistPending(true);
    setBlocklistError(null);
    try {
      const result = await inboundPolicy.addToBlocklist(candidate);
      if (result.ok) {
        setBlocklistInput('');
      } else {
        setBlocklistError(result.error ?? 'Could not add that Slack user.');
      }
    } finally {
      setBlocklistPending(false);
    }
  }, [blocklistInput, blocklistPending, inboundPolicy]);

  const addTrustedChannel = useCallback(() => {
    const candidate = trustedChannelInput.trim();
    if (!candidate) return;
    const next = trustedChannels.includes(candidate)
      ? trustedChannels
      : [...trustedChannels, candidate];
    void inboundPolicy.setSurfaceTrusted(SLACK_CONNECTOR, next);
    setTrustedChannelInput('');
  }, [inboundPolicy, trustedChannelInput, trustedChannels]);

  const addAgentAllowlistEntry = useCallback(() => {
    const candidate = agentAllowlistInput.trim();
    if (!candidate) return;
    void inboundPolicy.addToAgentAllowlist(SLACK_CONNECTOR, candidate);
    setAgentAllowlistInput('');
  }, [agentAllowlistInput, inboundPolicy]);

  const removeTrustedChannel = useCallback((channelId: string) => {
    const next = trustedChannels.filter((entry) => entry !== channelId);
    void inboundPolicy.setSurfaceTrusted(SLACK_CONNECTOR, next);
  }, [inboundPolicy, trustedChannels]);

  return (
    <SettingSection
      title="Who can message Rebel"
      description="Choose whether Rebel accepts messages from only you, a curated allowlist, or your legacy permissive setup."
      data-section="who-can-message-rebel"
      data-testid="who-can-message-rebel-panel"
    >
      {!slackConnected ? (
        <Notice
          tone="info"
          placement="inline"
          data-testid="who-can-message-rebel-panel-disconnected"
        >
          Connect Slack to add people from recent attempts.
        </Notice>
      ) : null}

      {ownerIdentityUnknown && policy.mode === 'ownerOnly' ? (
        <Notice
          tone="warning"
          placement="inline"
          data-testid="who-can-message-rebel-panel-owner-identity-missing"
        >
          Rebel can&apos;t tell which Slack user is you. Reconnect Slack to keep owner-only messaging working.
        </Notice>
      ) : null}

      {inboundAuthorPolicyBypassActive ? (
        <Notice
          tone="warning"
          placement="inline"
          data-testid="who-can-message-rebel-panel-bypass-active"
        >
          <strong>Inbound author policy is currently bypassed.</strong> An operator set <code>REBEL_INBOUND_AUTHOR_POLICY_BYPASS=1</code> on the cloud. While this is active, anyone who DMs Rebel or @-mentions it in Slack can trigger replies — your policy below has no effect. Remove the env flag on the cloud service to restore enforcement.
        </Notice>
      ) : null}

      <SettingRow
        label="Messaging access mode"
        description="Owner only is the strict default. Allowlist unlocks explicit people and trusted channels."
        htmlFor="who-can-message-rebel-mode"
      >
        <Select
          id="who-can-message-rebel-mode"
          value={policy.mode}
          data-section-focus-target
          data-testid="who-can-message-rebel-mode"
          onChange={(event) => {
            void inboundPolicy.setMode(event.target.value as typeof policy.mode);
          }}
        >
          <option value="ownerOnly">Owner only</option>
          <option value="allowlist">Allowlist</option>
          <option value="legacyPermissive" disabled={policy.mode !== 'legacyPermissive'}>
            Legacy permissive
          </option>
        </Select>
      </SettingRow>

      {policy.mode === 'allowlist' ? (
        <>
          <SettingRow
            label="Allowlist"
            description="Add Slack people Rebel may accept. Use a Slack ID (starts with U or W) or an @handle — Rebel resolves it before saving."
            variant="stacked"
          >
            <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Input
                  value={allowlistInput}
                  placeholder="@hannah or U12345678"
                  aria-label="Allowlist entry"
                  aria-invalid={allowlistError ? true : undefined}
                  aria-describedby="who-can-message-rebel-allowlist-helper"
                  data-testid="who-can-message-rebel-allowlist-input"
                  disabled={allowlistPending}
                  onChange={(event) => {
                    setAllowlistInput(event.target.value);
                    if (allowlistError) setAllowlistError(null);
                  }}
                  onKeyDown={(event) => {
                    handleEnter(event, () => { void addAllowlistEntry(); });
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => { void addAllowlistEntry(); }}
                  disabled={allowlistPending}
                  data-testid="who-can-message-rebel-allowlist-add"
                >
                  {allowlistPending ? 'Resolving…' : 'Add'}
                </Button>
              </div>
              <span
                id="who-can-message-rebel-allowlist-helper"
                style={{ color: 'var(--color-text-muted)', fontSize: '0.78rem' }}
                data-testid="who-can-message-rebel-allowlist-helper"
              >
                Rebel checks Slack before saving, so @handles match the right person.
              </span>
              {allowlistError ? (
                <Notice
                  tone="error"
                  placement="inline"
                  data-testid="who-can-message-rebel-allowlist-error"
                >
                  {allowlistError}
                </Notice>
              ) : null}
              {legacyAllowlist.length > 0 ? (
                <Notice
                  tone="warning"
                  placement="inline"
                  data-testid="who-can-message-rebel-allowlist-legacy-notice"
                >
                  Some allowlist entries don't match the current Slack format. Re-resolve to update them, or remove if they're no longer relevant.
                </Notice>
              ) : null}
              <LegacyTokenList
                values={legacyAllowlist}
                pendingValue={legacyAllowlistPending}
                onReresolve={async (value) => {
                  setLegacyAllowlistPending(value);
                  setAllowlistError(null);
                  try {
                    const result = await inboundPolicy.reresolveLegacyAllowlistEntry(value);
                    if (!result.ok) {
                      setAllowlistError(result.error ?? 'Could not resolve that entry.');
                    }
                  } finally {
                    setLegacyAllowlistPending(null);
                  }
                }}
                onRemove={(value) => { void inboundPolicy.removeFromAllowlist(value); }}
                testIdPrefix="who-can-message-rebel-allowlist"
              />
              <TokenList
                values={allowlist}
                onRemove={(value) => inboundPolicy.removeFromAllowlist(value)}
                testIdPrefix="who-can-message-rebel-allowlist"
                metadataByCanonicalId={inboundPolicy.slackAuthorMetadata}
              />
            </div>
          </SettingRow>

          <SettingRow
            label="Blocklist"
            description="Block specific Slack people even if other rules might allow them. Resolves against your workspace before saving."
            variant="stacked"
          >
            <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Input
                  value={blocklistInput}
                  placeholder="@hannah or U12345678"
                  aria-label="Blocklist entry"
                  aria-invalid={blocklistError ? true : undefined}
                  aria-describedby="who-can-message-rebel-blocklist-helper"
                  data-testid="who-can-message-rebel-blocklist-input"
                  disabled={blocklistPending}
                  onChange={(event) => {
                    setBlocklistInput(event.target.value);
                    if (blocklistError) setBlocklistError(null);
                  }}
                  onKeyDown={(event) => {
                    handleEnter(event, () => { void addBlocklistEntry(); });
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => { void addBlocklistEntry(); }}
                  disabled={blocklistPending}
                  data-testid="who-can-message-rebel-blocklist-add"
                >
                  {blocklistPending ? 'Resolving…' : 'Add'}
                </Button>
              </div>
              <span
                id="who-can-message-rebel-blocklist-helper"
                style={{ color: 'var(--color-text-muted)', fontSize: '0.78rem' }}
                data-testid="who-can-message-rebel-blocklist-helper"
              >
                Rebel checks Slack before saving, so @handles match the right person.
              </span>
              {blocklistError ? (
                <Notice
                  tone="error"
                  placement="inline"
                  data-testid="who-can-message-rebel-blocklist-error"
                >
                  {blocklistError}
                </Notice>
              ) : null}
              {legacyBlocklist.length > 0 ? (
                <Notice
                  tone="warning"
                  placement="inline"
                  data-testid="who-can-message-rebel-blocklist-legacy-notice"
                >
                  Some blocklist entries don't match the current Slack format. Re-resolve to update them, or remove if they're no longer relevant.
                </Notice>
              ) : null}
              <LegacyTokenList
                values={legacyBlocklist}
                pendingValue={legacyBlocklistPending}
                onReresolve={async (value) => {
                  setLegacyBlocklistPending(value);
                  setBlocklistError(null);
                  try {
                    const result = await inboundPolicy.reresolveLegacyBlocklistEntry(value);
                    if (!result.ok) {
                      setBlocklistError(result.error ?? 'Could not resolve that entry.');
                    }
                  } finally {
                    setLegacyBlocklistPending(null);
                  }
                }}
                onRemove={(value) => { void inboundPolicy.removeFromBlocklist(value); }}
                testIdPrefix="who-can-message-rebel-blocklist"
              />
              <TokenList
                values={blocklist}
                onRemove={(value) => inboundPolicy.removeFromBlocklist(value)}
                testIdPrefix="who-can-message-rebel-blocklist"
                metadataByCanonicalId={inboundPolicy.slackAuthorMetadata}
              />
            </div>
          </SettingRow>

          <SettingRow
            label="Trusted channels"
            variant="stacked"
          >
            <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
              <Notice
                tone="warning"
                placement="inline"
                data-testid="who-can-message-rebel-trusted-channel-warning"
              >
                <strong>Trusted channels.</strong> Any Slack member of these channels can trigger Rebel — including people who aren&apos;t on your allowlist. Avoid public channels like #general.
              </Notice>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Input
                  value={trustedChannelInput}
                  placeholder="C12345678"
                  aria-label="Trusted channel"
                  data-testid="who-can-message-rebel-trusted-channel-input"
                  onChange={(event) => {
                    setTrustedChannelInput(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    handleEnter(event, addTrustedChannel);
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={addTrustedChannel}
                  data-testid="who-can-message-rebel-trusted-channel-add"
                >
                  Add
                </Button>
              </div>
              <TokenList
                values={trustedChannels}
                onRemove={removeTrustedChannel}
                testIdPrefix="who-can-message-rebel-trusted-channel"
              />
            </div>
          </SettingRow>

          <SettingRow
            label="Other Rebels"
            description="Allow known Rebel instance IDs in this workspace."
            variant="stacked"
          >
            <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
              <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Input
                  value={agentAllowlistInput}
                  placeholder="rebel-instance-id"
                  aria-label="Other Rebel instance ID"
                  data-testid="who-can-message-rebel-agent-allowlist-input"
                  onChange={(event) => {
                    setAgentAllowlistInput(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    handleEnter(event, addAgentAllowlistEntry);
                  }}
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={addAgentAllowlistEntry}
                  data-testid="who-can-message-rebel-agent-allowlist-add"
                >
                  Add
                </Button>
              </div>
              <TokenList
                values={agentAllowlist}
                testIdPrefix="who-can-message-rebel-agent-allowlist"
              />
            </div>
          </SettingRow>
        </>
      ) : null}
    </SettingSection>
  );
}
