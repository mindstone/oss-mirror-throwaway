// web-companion/src/screens/ApprovalsScreen.tsx

import { useEffect, useCallback, useState } from 'react';
import {
  useApprovalStore,
  useApprovalActions,
  formatRelativeTime,
  type ToolApproval,
  type CloudStagedToolCall,
  type MemoryWriteApproval,
} from '@rebel/cloud-client';
import styles from './ApprovalsScreen.module.css';
import { fireAndForget } from '../utils/fireAndForget';

type ApprovalItem =
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
    <div className={styles.card} data-testid={`approval-card-${approval.toolUseID}`}>
      <div className={styles.cardHeader}>
        <span className={styles.toolName}>{approval.toolName}</span>
        <span className={styles.timestamp}>
          {formatRelativeTime(approval.timestamp)}
        </span>
      </div>

      {approval.reason && (
        <p className={styles.reason}>{approval.reason}</p>
      )}

      <details className={styles.inputDetails}>
        <summary className={styles.inputSummary}>View input details</summary>
        <div className={styles.inputPreview}>
          <pre className={styles.inputText}>
            {JSON.stringify(approval.input, null, 2)}
          </pre>
        </div>
      </details>

      <div className={styles.cardFooter}>
        <label className={styles.sessionCheckbox}>
          <input
            type="checkbox"
            checked={allowForSession}
            onChange={(e) => setAllowForSession(e.target.checked)}
          />
          <span>Allow for session</span>
        </label>

        <div className={styles.actions}>
          <button
            className={styles.denyButton}
            data-testid={`approval-deny-${approval.toolUseID}`}
            onClick={onDeny}
          >
            Deny
          </button>
          <button
            className={styles.approveButton}
            data-testid={`approval-approve-${approval.toolUseID}`}
            onClick={() => onApprove(allowForSession)}
          >
            Approve
          </button>
        </div>
      </div>
    </div>
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
    <div className={styles.card} data-testid={`approval-card-${call.id}`}>
      <div className={styles.cardHeader}>
        <span className={styles.toolName}>{call.displayName}</span>
        <span
          className={`${styles.riskBadge} ${call.riskLevel === 'high' ? styles.riskHigh : ''}`}
        >
          {call.riskLevel}
        </span>
      </div>

      {call.toolCategory && (
        <span className={styles.category}>{call.toolCategory}</span>
      )}

      {call.reason && (
        <p className={styles.reason}>{call.reason}</p>
      )}

      <details className={styles.inputDetails}>
        <summary className={styles.inputSummary}>View input details</summary>
        <div className={styles.inputPreview}>
          <pre className={styles.inputText}>
            {JSON.stringify(call.mcpPayload.args, null, 2)}
          </pre>
        </div>
      </details>

      <div className={styles.actions}>
        <button
          className={styles.denyButton}
          data-testid={`approval-deny-${call.id}`}
          onClick={onReject}
        >
          Reject
        </button>
        <button
          className={styles.executeButton}
          data-testid={`approval-approve-${call.id}`}
          onClick={onExecute}
        >
          Execute
        </button>
      </div>
    </div>
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
    <div className={`${styles.card} ${styles.memoryCard}`} data-testid={`approval-card-${approval.toolUseId}`}>
      <div className={styles.cardHeader}>
        <span className={styles.toolName}>{approval.spaceName}</span>
        <span className={styles.timestamp}>
          {formatRelativeTime(approval.timestamp)}
        </span>
      </div>

      <p className={styles.memoryPath}>{approval.filePath}</p>
      <p className={styles.reason}>{approval.summary}</p>

      {approval.contentPreview && (
        <details className={styles.inputDetails}>
          <summary className={styles.inputSummary}>View content preview</summary>
          <div className={styles.inputPreview}>
            <pre className={styles.inputText}>{approval.contentPreview}</pre>
          </div>
        </details>
      )}

      <div className={styles.actions}>
        <button
          className={styles.denyButton}
          data-testid={`approval-memory-skip-${approval.toolUseId}`}
          onClick={onSkip}
        >
          Skip
        </button>
        <button
          className={styles.approveButton}
          data-testid={`approval-memory-save-${approval.toolUseId}`}
          onClick={onSave}
        >
          Save
        </button>
      </div>
    </div>
  );
}

export function ApprovalsScreen() {
  const {
    toolApprovals,
    stagedCalls,
    memoryApprovals,
    isLoading,
    error,
    fetchPending,
  } = useApprovalStore();
  const {
    handleApprove,
    handleDeny,
    handleExecute,
    handleReject,
    approveMemoryWrite,
    skipMemoryWrite,
    actionError,
  } = useApprovalActions();

  useEffect(() => {
    fireAndForget(fetchPending(), 'ApprovalsScreen:mount:fetchPending');
  }, [fetchPending]);

  const handleRefresh = useCallback(() => {
    fireAndForget(fetchPending(), 'ApprovalsScreen:handleRefresh:fetchPending');
  }, [fetchPending]);

  const items: ApprovalItem[] = [
    ...toolApprovals.map((a) => ({ kind: 'tool' as const, data: a })),
    ...stagedCalls.map((c) => ({ kind: 'staged' as const, data: c })),
    ...memoryApprovals.map((m) => ({ kind: 'memory' as const, data: m })),
  ].sort((a, b) => {
    return b.data.timestamp - a.data.timestamp; // newest first
  });

  if (isLoading && items.length === 0) {
    return (
      <div className={styles.centered}>
        <div className="loading-spinner" />
      </div>
    );
  }

  if (error && items.length === 0) {
    return (
      <div className={styles.centered}>
        <p className={styles.errorText}>{error}</p>
        <button className={styles.retryButton} onClick={handleRefresh}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h1 className={styles.headerTitle}>Approvals</h1>
        {items.length > 0 && (
          <span className={styles.headerCount}>
            {items.length} pending
          </span>
        )}
      </div>

      {(actionError || (error && items.length > 0)) && (
        <p className={styles.inlineError}>{actionError ?? error}</p>
      )}

      {items.length === 0 ? (
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>All clear</p>
          <p className={styles.emptySubtitle}>Nothing requires your attention.</p>
        </div>
      ) : (
        <div className={styles.list}>
          {items.map((item) =>
            item.kind === 'tool' ? (
              <ToolApprovalCard
                key={item.data.toolUseID}
                approval={item.data}
                onApprove={(allowForSession) =>
                  fireAndForget(
                    handleApprove(item.data.toolUseID, allowForSession),
                    'ApprovalsScreen:onApprove',
                  )
                }
                onDeny={() =>
                  fireAndForget(
                    handleDeny(item.data.toolUseID),
                    'ApprovalsScreen:onDeny',
                  )
                }
              />
            ) : item.kind === 'staged' ? (
              <StagedCallCard
                key={item.data.id}
                call={item.data}
                onExecute={() =>
                  fireAndForget(
                    handleExecute(item.data.id),
                    'ApprovalsScreen:onExecute',
                  )
                }
                onReject={() =>
                  fireAndForget(
                    handleReject(item.data.id),
                    'ApprovalsScreen:onReject',
                  )
                }
              />
            ) : (
              <MemoryApprovalCard
                key={item.data.toolUseId}
                approval={item.data}
                onSave={() =>
                  fireAndForget(
                    approveMemoryWrite(item.data),
                    'ApprovalsScreen:onSaveMemory',
                  )
                }
                onSkip={() =>
                  fireAndForget(
                    skipMemoryWrite(item.data),
                    'ApprovalsScreen:onSkipMemory',
                  )
                }
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}
