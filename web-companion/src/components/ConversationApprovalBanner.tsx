import { useEffect, useMemo, useState } from 'react';
import {
  formatRelativeTime,
  useApprovalActions,
  useApprovalStore,
  type CloudStagedToolCall,
  type MemoryWriteApproval,
  type ToolApproval,
} from '@rebel/cloud-client';
import styles from './ConversationApprovalBanner.module.css';
import { fireAndForget } from '../utils/fireAndForget';

type BannerItem =
  | { kind: 'tool'; data: ToolApproval }
  | { kind: 'staged'; data: CloudStagedToolCall }
  | { kind: 'memory'; data: MemoryWriteApproval };

function ToolApprovalCard({
  approval,
  onApprove,
  onDeny,
}: {
  approval: ToolApproval;
  onApprove: (allowForSession: boolean) => void;
  onDeny: () => void;
}) {
  const [allowForSession, setAllowForSession] = useState(false);

  return (
    <article className={styles.card} data-testid={`conversation-approval-tool-${approval.toolUseID}`}>
      <div className={styles.cardHeader}>
        <span className={styles.title}>{approval.toolName}</span>
        <span className={styles.timestamp}>{formatRelativeTime(approval.timestamp)}</span>
      </div>

      {approval.reason && <p className={styles.reason}>{approval.reason}</p>}

      <details className={styles.details}>
        <summary className={styles.summary}>View input details</summary>
        <pre className={styles.preview}>{JSON.stringify(approval.input, null, 2)}</pre>
      </details>

      <div className={styles.footerRow}>
        <label className={styles.checkboxLabel}>
          <input
            type="checkbox"
            checked={allowForSession}
            onChange={(event) => setAllowForSession(event.target.checked)}
          />
          <span>Allow for session</span>
        </label>

        <div className={styles.actions}>
          <button type="button" className={styles.secondaryButton} onClick={onDeny}>
            Deny
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => onApprove(allowForSession)}
          >
            Approve
          </button>
        </div>
      </div>
    </article>
  );
}

function StagedCallCard({
  call,
  onExecute,
  onReject,
}: {
  call: CloudStagedToolCall;
  onExecute: () => void;
  onReject: () => void;
}) {
  return (
    <article className={styles.card} data-testid={`conversation-approval-staged-${call.id}`}>
      <div className={styles.cardHeader}>
        <span className={styles.title}>{call.displayName}</span>
        <span className={`${styles.riskBadge} ${call.riskLevel === 'high' ? styles.riskHigh : ''}`}>
          {call.riskLevel}
        </span>
      </div>

      {call.reason && <p className={styles.reason}>{call.reason}</p>}

      <details className={styles.details}>
        <summary className={styles.summary}>View input details</summary>
        <pre className={styles.preview}>{JSON.stringify(call.mcpPayload.args, null, 2)}</pre>
      </details>

      <div className={styles.actions}>
        <button type="button" className={styles.secondaryButton} onClick={onReject}>
          Reject
        </button>
        <button type="button" className={styles.executeButton} onClick={onExecute}>
          Execute
        </button>
      </div>
    </article>
  );
}

function MemoryApprovalCard({
  approval,
  onSave,
  onSkip,
}: {
  approval: MemoryWriteApproval;
  onSave: () => void;
  onSkip: () => void;
}) {
  return (
    <article className={styles.card} data-testid={`conversation-approval-memory-${approval.toolUseId}`}>
      <div className={styles.cardHeader}>
        <span className={styles.title}>{approval.spaceName}</span>
        <span className={styles.timestamp}>{formatRelativeTime(approval.timestamp)}</span>
      </div>

      <p className={styles.path}>{approval.filePath}</p>
      <p className={styles.reason}>{approval.summary}</p>

      {approval.contentPreview && (
        <details className={styles.details}>
          <summary className={styles.summary}>View content preview</summary>
          <pre className={styles.preview}>{approval.contentPreview}</pre>
        </details>
      )}

      <div className={styles.actions}>
        <button type="button" className={styles.secondaryButton} onClick={onSkip}>
          Skip
        </button>
        <button type="button" className={styles.primaryButton} onClick={onSave}>
          Save
        </button>
      </div>
    </article>
  );
}

interface ConversationApprovalBannerProps {
  sessionId: string;
}

export function ConversationApprovalBanner({ sessionId }: ConversationApprovalBannerProps) {
  const allToolApprovals = useApprovalStore((state) => state.toolApprovals);
  const allStagedCalls = useApprovalStore((state) => state.stagedCalls);
  const allMemoryApprovals = useApprovalStore((state) => state.memoryApprovals);
  const storeError = useApprovalStore((state) => state.error);
  const fetchPending = useApprovalStore((state) => state.fetchPending);

  useEffect(() => {
    fireAndForget(fetchPending(), 'ConversationApprovalBanner:mount:fetchPending');
  }, [fetchPending]);

  const items = useMemo<BannerItem[]>(() => {
    return [
      ...allToolApprovals
        .filter((approval) => approval.sessionId === sessionId)
        .map((approval) => ({ kind: 'tool' as const, data: approval })),
      ...allStagedCalls
        .filter((call) => call.sessionId === sessionId)
        .map((call) => ({ kind: 'staged' as const, data: call })),
      ...allMemoryApprovals
        .filter((approval) => approval.originalSessionId === sessionId)
        .map((approval) => ({ kind: 'memory' as const, data: approval })),
    ].sort((a, b) => b.data.timestamp - a.data.timestamp);
  }, [allMemoryApprovals, allStagedCalls, allToolApprovals, sessionId]);

  const {
    handleApprove,
    handleDeny,
    handleExecute,
    handleReject,
    approveMemoryWrite,
    skipMemoryWrite,
    actionError,
  } = useApprovalActions();

  if (items.length === 0) return null;

  return (
    <section className={styles.container} data-testid="conversation-approval-banner">
      <div className={styles.header}>
        <p className={styles.headerTitle}>Awaiting approval</p>
        <span className={styles.headerCount}>{items.length} pending</span>
      </div>

      {(actionError || storeError) && (
        <p className={styles.inlineError} data-testid="conversation-approval-error">
          {actionError ?? storeError}
        </p>
      )}

      <div className={styles.list}>
        {items.map((item) => {
          if (item.kind === 'tool') {
            return (
              <ToolApprovalCard
                key={item.data.toolUseID}
                approval={item.data}
                onApprove={(allowForSession) => {
                  fireAndForget(handleApprove(item.data.toolUseID, allowForSession), 'ConversationApprovalBanner:onApprove');
                }}
                onDeny={() => {
                  fireAndForget(handleDeny(item.data.toolUseID), 'ConversationApprovalBanner:onDeny');
                }}
              />
            );
          }

          if (item.kind === 'staged') {
            return (
              <StagedCallCard
                key={item.data.id}
                call={item.data}
                onExecute={() => {
                  fireAndForget(handleExecute(item.data.id), 'ConversationApprovalBanner:onExecute');
                }}
                onReject={() => {
                  fireAndForget(handleReject(item.data.id), 'ConversationApprovalBanner:onReject');
                }}
              />
            );
          }

          return (
            <MemoryApprovalCard
              key={item.data.toolUseId}
              approval={item.data}
              onSave={() => {
                fireAndForget(approveMemoryWrite(item.data), 'ConversationApprovalBanner:onSaveMemory');
              }}
              onSkip={() => {
                fireAndForget(skipMemoryWrite(item.data), 'ConversationApprovalBanner:onSkipMemory');
              }}
            />
          );
        })}
      </div>
    </section>
  );
}
