import React, { useState } from 'react';
import { ShieldCheck, AlertTriangle, ShieldX, ChevronDown, ChevronRight } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Tooltip,
} from '@renderer/components/ui';
import {
  ELEVATED_PERMISSIONS,
  EXTERNAL_PERMISSIONS,
  getEffectivePermissions,
  STANDARD_READ_PERMISSIONS,
} from '../api/pluginPermissions';
import type { Permission } from '../api/types';
import type { PluginSecurityReport } from './pluginSecurityReview';

interface PluginSecurityDialogProps {
  open: boolean;
  pluginName: string;
  sourceSpaceLabel: string;
  report: PluginSecurityReport | null;
  permissions?: Permission[];
  externalDomains?: string[];
  isEnabling?: boolean;
  /** When true, shows a "Close" button only (no Enable/Cancel). Used for re-scanning active plugins. */
  readOnly?: boolean;
  /**
   * When true, this is an agent-created plugin held for security review because
   * it requested elevated permissions (Stage 3A). Switches the title/description
   * copy so the user understands Rebel built it and paused it for their approval,
   * rather than it being an ordinary inactive Space plugin.
   */
  pendingReview?: boolean;
  /** When set, the security review threw an error — treat as block (fail-closed). */
  scanError?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

const PERMISSION_LABELS: Record<Permission, string> = {
  'conversations:read': 'Read conversation metadata',
  'conversations:write': 'Send messages / start conversations',
  'conversations:transcript': 'Read conversation transcripts',
  'memory:read': 'Read memory topics and sources',
  'skills:read': 'Read skill files',
  'skills:write': 'Write skill files',
  'automations:create': 'Create automations',
  'entities:read': 'Read people/company metadata',
  'external-fetch': 'Call external APIs (domain-gated)',
};

const PERMISSION_CAN_DO_TEXT: Record<Permission, string> = {
  'conversations:read': 'Read and organize conversation metadata.',
  'conversations:write': 'Send messages or start conversations for you.',
  'conversations:transcript': 'Read conversation message transcripts.',
  'memory:read': 'Read memory topics and source summaries.',
  'skills:read': 'Read skill files to understand your workflows.',
  'skills:write': 'Create or update skill files.',
  'automations:create': 'Create scheduled automations on your behalf.',
  'entities:read': 'Read people and company metadata from your workspace.',
  'external-fetch': 'Call external APIs that are explicitly allowlisted.',
};

function renderPermissionList(items: Permission[]): React.ReactNode {
  if (items.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
        None requested.
      </p>
    );
  }

  return (
    <ul style={{ margin: 0, paddingLeft: '1rem', display: 'grid', gap: '0.25rem' }}>
      {items.map((permission) => (
        <li key={permission} style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
          {PERMISSION_LABELS[permission]}
        </li>
      ))}
    </ul>
  );
}

function renderDetailList(items: string[]): React.ReactNode {
  if (items.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
        Nothing detected.
      </p>
    );
  }

  return (
    <ul style={{ margin: 0, paddingLeft: '1rem', display: 'grid', gap: '0.25rem' }}>
      {items.map((item) => (
        <li key={item} style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
          {item}
        </li>
      ))}
    </ul>
  );
}

export const PluginSecurityDialog: React.FC<PluginSecurityDialogProps> = ({
  open,
  pluginName,
  sourceSpaceLabel,
  report,
  permissions,
  externalDomains = [],
  isEnabling = false,
  readOnly = false,
  pendingReview = false,
  scanError = null,
  onCancel,
  onConfirm,
}) => {
  const [showDetails, setShowDetails] = useState(false);

  if (!report && !scanError) {
    return null;
  }

  // Fail-closed: scanner error = block
  const isBlocked = scanError !== null || (report?.maxSeverity === 'block');
  const isWarn = !isBlocked && report?.maxSeverity === 'warn';

  const warningCount = report?.warnings.length ?? 0;
  const effectivePermissions = getEffectivePermissions(permissions);
  const usesLegacyDefaults = !permissions || permissions.length === 0;

  const standardPermissions = effectivePermissions.filter((permission) =>
    STANDARD_READ_PERMISSIONS.includes(permission),
  );
  const elevatedPermissions = effectivePermissions.filter((permission) =>
    ELEVATED_PERMISSIONS.includes(permission),
  );
  const externalPermissions = effectivePermissions.filter((permission) =>
    EXTERNAL_PERMISSIONS.includes(permission),
  );
  const hasExternalFetch = externalPermissions.includes('external-fetch');

  const canDoItems = Array.from(
    new Set(
      effectivePermissions.map((permission) => PERMISSION_CAN_DO_TEXT[permission]),
    ),
  );
  if (hasExternalFetch && externalDomains.length > 0) {
    canDoItems.push(`Call external APIs only on these domains: ${externalDomains.join(', ')}.`);
  }

  const cannotDoItems: string[] = [];
  if (!effectivePermissions.includes('conversations:write')) {
    cannotDoItems.push('It cannot send messages or start conversations for you.');
  }
  if (!effectivePermissions.includes('skills:write')) {
    cannotDoItems.push('It cannot create or edit skill files.');
  }
  if (!hasExternalFetch) {
    cannotDoItems.push('It cannot access external websites or APIs.');
  } else if (externalDomains.length > 0) {
    cannotDoItems.push(`It cannot access external domains outside: ${externalDomains.join(', ')}.`);
  }
  if (!effectivePermissions.includes('memory:read')) {
    cannotDoItems.push('It cannot read memory topics or source summaries.');
  }
  if (!effectivePermissions.includes('skills:read')) {
    cannotDoItems.push('It cannot read skill files.');
  }
  if (!effectivePermissions.includes('entities:read')) {
    cannotDoItems.push('It cannot read people or company metadata.');
  }
  if (!effectivePermissions.includes('conversations:read')) {
    cannotDoItems.push('It cannot read or organize conversation metadata.');
  }

  const StatusIcon = isBlocked ? ShieldX : (report?.passed ? ShieldCheck : AlertTriangle);
  const statusColor = isBlocked
    ? 'var(--color-text-error, #ef4444)'
    : report?.passed
      ? 'var(--color-text-success, #22c55e)'
      : 'var(--color-text-warning, #f59e0b)';

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onCancel()}>
      <DialogContent size="md">
        <DialogHeader onClose={onCancel}>
          <DialogTitle>
            {readOnly ? 'Security Scan' : pendingReview ? 'Review plugin access' : 'Enable plugin'}
          </DialogTitle>
          <DialogDescription>
            {readOnly
              ? <>Security scan results for <strong>{pluginName}</strong>.</>
              : pendingReview
                ? <>Rebel built <strong>{pluginName}</strong>. Before it can run, review the access it requested.</>
                : <>You're about to enable <strong>{pluginName}</strong> from <strong>{sourceSpaceLabel}</strong>.</>}
          </DialogDescription>
        </DialogHeader>

        <DialogBody style={{ display: 'grid', gap: '1rem' }}>
          {/* Blocking banner — scanner error or block-severity findings */}
          {isBlocked && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.875rem',
                borderRadius: '0.625rem',
                backgroundColor: 'var(--color-bg-error, rgba(239, 68, 68, 0.08))',
                border: '1px solid var(--color-border-error, rgba(239, 68, 68, 0.3))',
              }}
            >
              <ShieldX size={20} style={{ color: 'var(--color-text-error, #ef4444)', flexShrink: 0 }} />
              <div style={{ display: 'grid', gap: '0.125rem' }}>
                <p style={{ margin: 0, fontSize: '0.875rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                  {scanError ? 'Security review failed' : 'This plugin cannot be enabled'}
                </p>
                <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                  {scanError
                    ? 'The security review encountered an error. The plugin cannot be enabled.'
                    : 'This plugin uses patterns that are not allowed. It cannot be enabled.'}
                </p>
              </div>
            </div>
          )}

          {/* Warning banner — warn-severity findings */}
          {!isBlocked && isWarn && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.875rem',
                borderRadius: '0.625rem',
                backgroundColor: 'var(--color-bg-warning, rgba(245, 158, 11, 0.08))',
                border: '1px solid var(--color-border-warning, rgba(245, 158, 11, 0.3))',
              }}
            >
              <AlertTriangle size={20} style={{ color: 'var(--color-text-warning, #f59e0b)', flexShrink: 0 }} />
              <div style={{ display: 'grid', gap: '0.125rem' }}>
                <p style={{ margin: 0, fontSize: '0.875rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                  Review these findings before enabling
                </p>
                <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                  This plugin uses some patterns that may need a closer look.
                </p>
              </div>
            </div>
          )}

          {/* Success banner — no issues */}
          {!isBlocked && !isWarn && !scanError && report && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.875rem',
                borderRadius: '0.625rem',
                backgroundColor: 'var(--color-bg-success, rgba(34, 197, 94, 0.06))',
                border: '1px solid var(--color-border-success, rgba(34, 197, 94, 0.2))',
              }}
            >
              <StatusIcon size={20} style={{ color: statusColor, flexShrink: 0 }} />
              <div style={{ display: 'grid', gap: '0.125rem' }}>
                <p style={{ margin: 0, fontSize: '0.875rem', fontWeight: 600, color: 'var(--color-text-primary)' }}>
                  Looks good
                </p>
                <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                  This plugin passed our automated safety checks.
                </p>
              </div>
            </div>
          )}

          {/* Findings list — shown for warn and block so user/author can see what to fix */}
          {report && warningCount > 0 && (
            <div
              style={{
                display: 'grid',
                gap: '0.5rem',
                padding: '0.75rem',
                borderRadius: '0.5rem',
                backgroundColor: isBlocked
                  ? 'var(--color-bg-error, rgba(239, 68, 68, 0.08))'
                  : 'var(--color-bg-warning, rgba(245, 158, 11, 0.08))',
              }}
            >
              {report.warnings.map((warning) => (
                <p key={warning} style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                  {warning}
                </p>
              ))}
            </div>
          )}

          <div
            style={{
              display: 'grid',
              gap: '0.75rem',
              padding: '0.75rem',
              borderRadius: '0.5rem',
              backgroundColor: 'var(--color-bg-secondary, rgba(255,255,255,0.03))',
              border: '1px solid var(--color-border-secondary, rgba(255,255,255,0.06))',
            }}
          >
            <section style={{ display: 'grid', gap: '0.375rem' }}>
              <p style={{ margin: 0, fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                Requested permissions
              </p>
              {usesLegacyDefaults && (
                <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
                  This plugin uses legacy defaults (read-only permissions).
                </p>
              )}
            </section>

            <section style={{ display: 'grid', gap: '0.375rem' }}>
              <p style={{ margin: 0, fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                Standard (no extra approval)
              </p>
              {renderPermissionList(standardPermissions)}
            </section>

            <section style={{ display: 'grid', gap: '0.375rem' }}>
              <p style={{ margin: 0, fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                Elevated (rate-limited)
              </p>
              {renderPermissionList(elevatedPermissions)}
            </section>

            <section style={{ display: 'grid', gap: '0.375rem' }}>
              <p style={{ margin: 0, fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                External (domain-gated)
              </p>
              {renderPermissionList(externalPermissions)}
              {hasExternalFetch && (
                <div style={{ display: 'grid', gap: '0.375rem' }}>
                  <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
                    Allowed domains
                  </p>
                  {externalDomains.length > 0 ? (
                    <ul style={{ margin: 0, paddingLeft: '1rem', display: 'grid', gap: '0.25rem' }}>
                      {externalDomains.map((domain) => (
                        <li key={domain} style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                          {domain}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                      No domains listed.
                    </p>
                  )}
                </div>
              )}
            </section>
          </div>

          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <section style={{ display: 'grid', gap: '0.375rem' }}>
              <p style={{ margin: 0, fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                What this plugin can do
              </p>
              {renderDetailList(canDoItems)}
            </section>
            <section style={{ display: 'grid', gap: '0.375rem' }}>
              <p style={{ margin: 0, fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                What this plugin cannot do
              </p>
              {renderDetailList(cannotDoItems)}
            </section>
          </div>

          <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
            Plugins run inside Rebel and can access features like your conversations and memory.
            Only enable plugins you trust.
          </p>

          <button
            type="button"
            onClick={() => setShowDetails((prev) => !prev)}
            style={{
              all: 'unset',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '0.375rem',
              fontSize: '0.75rem',
              color: 'var(--color-text-tertiary)',
              userSelect: 'none',
            }}
          >
            {showDetails ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Advanced details
          </button>

          {showDetails && report && (
            <div
              style={{
                display: 'grid',
                gap: '0.75rem',
                padding: '0.75rem',
                borderRadius: '0.5rem',
                backgroundColor: 'var(--color-bg-secondary, rgba(255,255,255,0.03))',
                border: '1px solid var(--color-border-secondary, rgba(255,255,255,0.06))',
              }}
            >
              <section style={{ display: 'grid', gap: '0.375rem' }}>
                <p style={{ margin: 0, fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                  Safety scan summary
                </p>
                {renderDetailList(report.summary)}
              </section>

              {report.apiUsage.length > 0 && (
                <section style={{ display: 'grid', gap: '0.375rem' }}>
                  <p style={{ margin: 0, fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                    APIs used by this plugin
                  </p>
                  {renderDetailList(report.apiUsage)}
                </section>
              )}

              <p style={{ margin: 0, fontSize: '0.6875rem', color: 'var(--color-text-tertiary)' }}>
                Additional validation runs automatically when the plugin is enabled.
              </p>
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          {readOnly ? (
            <Button onClick={onCancel}>Close</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onCancel} disabled={isEnabling}>
                Cancel
              </Button>
              {isBlocked ? (
                <Tooltip content="This plugin uses blocked patterns and cannot be enabled.">
                  <Button disabled>Enable</Button>
                </Tooltip>
              ) : (
                <Button onClick={onConfirm} disabled={isEnabling}>
                  {isEnabling ? 'Enabling…' : 'Enable'}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
