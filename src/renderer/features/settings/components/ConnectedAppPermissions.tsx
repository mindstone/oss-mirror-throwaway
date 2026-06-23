import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { resolveSourceDisplayName } from '@shared/utils/mcpAppDisplayNames';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Notice,
} from '@renderer/components/ui';
import { useSessionStore } from '@renderer/features/agent-session/store/sessionStore';
import {
  connectedAppPermissionKey,
  type ListedPermission,
  useConnectedAppPermissions,
} from '../hooks/useConnectedAppPermissions';
import styles from './SettingsSurface.module.css';

const SECTION_TITLE = 'Connected app permissions';
const SECTION_SUBTITLE = "Apps you've allowed to speak in conversations, share context, or use tools.";
const EMPTY_COPY = 'Nothing allowed yet. Apps will ask here first.';
const REMOVE_ACCESS_COPY = 'Remove access';
const REMOVE_ALL_ACCESS_COPY = 'Remove all access';
const CONFIRMATION_COPY = 'Remove access? The app will need to ask again next time.';
const SUCCESS_ANNOUNCEMENT = 'Removed. The app will need to ask again next time.';

type ConfirmationTarget =
  | {
      kind: 'conversation';
      sourcePackageId: string;
      conversationId: string;
      packageDisplayName: string;
      conversationLabel: string;
    }
  | {
      kind: 'package';
      sourcePackageId: string;
      packageDisplayName: string;
    };

interface ConversationLookup {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

interface PermissionGroup {
  sourcePackageId: string;
  displayName: string;
  permissions: ListedPermission[];
}

function parsePermissionDate(value: string | number | null | undefined): Date {
  const date = typeof value === 'number' ? new Date(value) : new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function formatRelativeDate(dateInput: string | number, now = Date.now()): string {
  const date = parsePermissionDate(dateInput);
  const diffMs = date.getTime() - now;
  const absMs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  if (absMs < 60_000) {
    return 'just now';
  }

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const month = 30 * day;
  const year = 365 * day;

  if (absMs < hour) {
    return rtf.format(Math.round(diffMs / minute), 'minute');
  }
  if (absMs < day) {
    return rtf.format(Math.round(diffMs / hour), 'hour');
  }
  if (absMs < month) {
    return rtf.format(Math.round(diffMs / day), 'day');
  }
  if (absMs < year) {
    return rtf.format(Math.round(diffMs / month), 'month');
  }
  return rtf.format(Math.round(diffMs / year), 'year');
}

function formatFallbackDate(dateInput: string | number): string {
  const date = parsePermissionDate(dateInput);
  const now = new Date();
  const includeYear = date.getFullYear() !== now.getFullYear();
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    ...(includeYear ? { year: 'numeric' } : {}),
  }).format(date);
}

function buildConversationLookup(params: {
  sessionSummaries: ConversationLookup[];
  currentSessionId: string;
  currentSessionTitle: string;
  currentSessionCreatedAt: number;
}): Map<string, ConversationLookup> {
  const lookup = new Map<string, ConversationLookup>();
  params.sessionSummaries.forEach((summary) => lookup.set(summary.id, summary));
  if (params.currentSessionId) {
    lookup.set(params.currentSessionId, {
      id: params.currentSessionId,
      title: params.currentSessionTitle,
      createdAt: params.currentSessionCreatedAt,
      updatedAt: params.currentSessionCreatedAt,
    });
  }
  return lookup;
}

function getConversationLabel(
  permission: ListedPermission,
  conversationLookup: Map<string, ConversationLookup>,
): string {
  const conversation = conversationLookup.get(permission.conversationId);
  const title = conversation?.title?.trim();
  if (conversation && title) {
    return `${title} · ${formatRelativeDate(conversation.updatedAt ?? conversation.createdAt)}`;
  }
  return `Untitled conversation · ${formatFallbackDate(permission.grantedAt)}`;
}

function getCapabilitySummary(permission: ListedPermission): string {
  const capabilities: string[] = [];
  if (permission.methods.includes('ui/updateModelContext')) {
    capabilities.push('share context');
  }
  if (permission.methods.includes('ui/sendMessage')) {
    capabilities.push('send messages');
  }

  const toolCount = permission.toolAllowlist?.length ?? 0;
  if (toolCount > 0) {
    capabilities.push(`use ${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}`);
  }

  if (capabilities.length === 0) {
    return 'Can ask again when needed';
  }
  if (capabilities.length === 1) {
    if (capabilities[0].startsWith('use ')) {
      return `Can ${capabilities[0]}.`;
    }
    return `Can ${capabilities[0]}`;
  }
  if (capabilities.length === 2) {
    return `Can ${capabilities[0]} and ${capabilities[1]}`;
  }
  return `Can ${capabilities.slice(0, -1).join(', ')}, and ${capabilities.at(-1)}`;
}

function groupPermissions(permissions: ListedPermission[]): PermissionGroup[] {
  const grouped = new Map<string, ListedPermission[]>();
  permissions.forEach((permission) => {
    const existing = grouped.get(permission.sourcePackageId) ?? [];
    existing.push(permission);
    grouped.set(permission.sourcePackageId, existing);
  });

  return [...grouped.entries()]
    .map(([sourcePackageId, groupPermissions]) => ({
      sourcePackageId,
      displayName: resolveSourceDisplayName(sourcePackageId).displayName,
      permissions: [...groupPermissions].sort((a, b) => a.grantedAt.localeCompare(b.grantedAt)),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function ConnectedAppPermissions() {
  const {
    permissions,
    loading,
    error,
    refresh,
    revokeConversation,
    revokePackage,
    pendingRevokes,
  } = useConnectedAppPermissions();
  const sessionSummaries = useSessionStore((state) => state.sessionSummaries);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const currentSessionTitle = useSessionStore((state) => state.currentSessionTitle);
  const currentSessionCreatedAt = useSessionStore((state) => state.currentSessionCreatedAt);

  const [openPackageIds, setOpenPackageIds] = useState<Set<string>>(() => new Set());
  const [confirmationTarget, setConfirmationTarget] = useState<ConfirmationTarget | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const groups = useMemo(() => groupPermissions(permissions), [permissions]);
  const packageIdsKey = groups.map((group) => group.sourcePackageId).join('\u0000');
  const conversationLookup = useMemo(() => buildConversationLookup({
    sessionSummaries,
    currentSessionId,
    currentSessionTitle,
    currentSessionCreatedAt,
  }), [currentSessionCreatedAt, currentSessionId, currentSessionTitle, sessionSummaries]);

  useEffect(() => {
    const packageIds = groups.map((group) => group.sourcePackageId);
    setOpenPackageIds(new Set(packageIds.length <= 3 ? packageIds : []));
  }, [groups, packageIdsKey]);

  const togglePackage = useCallback((sourcePackageId: string) => {
    setOpenPackageIds((current) => {
      const next = new Set(current);
      if (next.has(sourcePackageId)) {
        next.delete(sourcePackageId);
      } else {
        next.add(sourcePackageId);
      }
      return next;
    });
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!confirmationTarget) return;
    setConfirming(true);
    try {
      if (confirmationTarget.kind === 'conversation') {
        await revokeConversation(
          confirmationTarget.sourcePackageId,
          confirmationTarget.conversationId,
        );
      } else {
        await revokePackage(confirmationTarget.sourcePackageId);
      }
      setAnnouncement(SUCCESS_ANNOUNCEMENT);
      setConfirmationTarget(null);
    } finally {
      setConfirming(false);
    }
  }, [confirmationTarget, revokeConversation, revokePackage]);

  const hasPermissions = permissions.length > 0;

  return (
    <div className={styles.connectedAppPermissions} data-testid="connected-app-permissions">
      <div className={styles.connectedAppPermissionsHeader}>
        <div>
          <h4 className={styles.standingPermSubGroupTitle}>{SECTION_TITLE}</h4>
          <p className={styles.standingPermSubGroupDesc}>{SECTION_SUBTITLE}</p>
        </div>
      </div>

      {error ? (
        <Notice
          tone="error"
          density="compact"
          placement="inline"
          title="Connected app permissions did not load"
          actions={[{ label: 'Retry', onClick: () => void refresh(), variant: 'secondary' }]}
        >
          {error}
        </Notice>
      ) : null}

      {!error && loading && !hasPermissions ? (
        <p className={styles.emptyState}>Loading connected app permissions…</p>
      ) : null}

      {!error && !loading && !hasPermissions ? (
        <p className={styles.emptyState}>{EMPTY_COPY}</p>
      ) : null}

      {hasPermissions ? (
        <div className={styles.connectedAppPermissionGroups} role="list">
          {groups.map((group) => {
            const isOpen = openPackageIds.has(group.sourcePackageId);
            const packagePending = group.permissions.some((permission) =>
              pendingRevokes.has(connectedAppPermissionKey(
                permission.sourcePackageId,
                permission.conversationId,
              )),
            );

            return (
              <section
                key={group.sourcePackageId}
                className={styles.connectedAppPermissionGroup}
                role="listitem"
              >
                <div className={styles.connectedAppPermissionGroupHeader}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={styles.connectedAppPermissionToggle}
                    aria-expanded={isOpen}
                    onClick={() => togglePackage(group.sourcePackageId)}
                  >
                    <ChevronRight
                      size={14}
                      aria-hidden
                      className={isOpen ? styles.connectedAppPermissionChevronOpen : undefined}
                    />
                    <span className={styles.connectedAppPermissionPackageName}>
                      {group.displayName}
                    </span>
                    <span className={styles.connectedAppPermissionCount}>
                      {group.permissions.length} {group.permissions.length === 1 ? 'conversation' : 'conversations'}
                    </span>
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="xs"
                    disabled={packagePending}
                    onClick={() => setConfirmationTarget({
                      kind: 'package',
                      sourcePackageId: group.sourcePackageId,
                      packageDisplayName: group.displayName,
                    })}
                  >
                    {REMOVE_ALL_ACCESS_COPY}
                  </Button>
                </div>

                {isOpen ? (
                  <div className={styles.connectedAppPermissionRows} role="list">
                    {group.permissions.map((permission) => {
                      const revokeKey = connectedAppPermissionKey(
                        permission.sourcePackageId,
                        permission.conversationId,
                      );
                      const rowPending = pendingRevokes.has(revokeKey);
                      const conversationLabel = getConversationLabel(permission, conversationLookup);

                      return (
                        <div
                          key={revokeKey}
                          className={styles.connectedAppPermissionRow}
                          data-pending={rowPending ? 'true' : 'false'}
                          role="listitem"
                        >
                          <div className={styles.connectedAppPermissionRowInfo}>
                            <span className={styles.connectedAppPermissionConversation}>
                              {conversationLabel}
                            </span>
                            <span className={styles.connectedAppPermissionCapability}>
                              {getCapabilitySummary(permission)}
                            </span>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            disabled={rowPending}
                            aria-label={`${REMOVE_ACCESS_COPY} for ${conversationLabel} from ${group.displayName}`}
                            onClick={() => setConfirmationTarget({
                              kind: 'conversation',
                              sourcePackageId: permission.sourcePackageId,
                              conversationId: permission.conversationId,
                              packageDisplayName: group.displayName,
                              conversationLabel,
                            })}
                          >
                            {rowPending ? 'Removing…' : REMOVE_ACCESS_COPY}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : null}

      <span className={styles.connectedAppPermissionLiveRegion} aria-live="polite">
        {announcement}
      </span>

      <Dialog
        open={confirmationTarget !== null}
        onOpenChange={(open) => {
          if (!open && !confirming) {
            setConfirmationTarget(null);
          }
        }}
        disableOutsideClose={confirming}
        disableEscapeClose={confirming}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{CONFIRMATION_COPY}</DialogTitle>
            <DialogDescription>
              {confirmationTarget?.kind === 'package'
                ? `${confirmationTarget.packageDisplayName} will lose access in every conversation.`
                : `${confirmationTarget?.packageDisplayName ?? 'The app'} will lose access for ${confirmationTarget?.kind === 'conversation' ? confirmationTarget.conversationLabel : 'this conversation'}.`}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className={styles.connectedAppPermissionConfirmCopy}>
              {CONFIRMATION_COPY}
            </p>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={confirming}
              onClick={() => setConfirmationTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={confirming}
              onClick={() => void handleConfirm()}
            >
              {confirming ? 'Removing…' : REMOVE_ACCESS_COPY}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
