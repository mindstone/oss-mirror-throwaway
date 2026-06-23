import type { AnyAttachmentPayload, ThinkingEffort } from '@shared/types';
import type { ActiveProvider } from '@shared/types/settings';
import type { SessionType } from '@core/services/promptTemplateService';
import type { TurnPolicy } from '@core/types/turnPolicy';

export type ApprovalRequest =
  | { kind: 'tool_safety'; toolName: string; toolInput: unknown; reason: string }
  | { kind: 'memory_write'; target: string; summary: string };

export type ApprovalDecision = { approved: true } | { approved: false; reason: string };

export type ApprovalHandler = (
  request: ApprovalRequest,
  signal: AbortSignal,
) => Promise<ApprovalDecision>;

export type PersistMode = { kind: 'cli-session' } | { kind: 'none' };

export interface HeadlessTurnOptions {
  sessionType: SessionType;
  persistMode: PersistMode;
  /**
   * Per-turn policy override. When omitted, the executor derives a policy from
   * `sessionType` using `derivePolicy()` (see {@link TurnPolicy}). When provided,
   * the override fields are merged on top of the session-type defaults via a
   * shallow spread.
   *
   * Use this to express caller intent declaratively without inventing new
   * sessionType values. Example: a meeting Q&A turn that should run with the
   * full pre-turn enrichment of an interactive turn but on the background lane:
   *
   *   policy: { lane: 'background' }   // automation defaults preserved otherwise
   *
   * Or: a low-priority automation turn that should still pre-fetch URLs and
   * include semantic context for richer answers (behaviour change opt-in):
   *
   *   policy: { semanticContext: 'sync', prefetchUrls: true }
   *
   * The `lane`, `watchdogHardCeilingMs`, `watchdogAbortsDuringApprovalWait`,
   * `prefetchUrls`, `semanticContext`, `autoInjectPastConversations`,
   * `promptSessionMode`, and `origin` fields are independently overridable.
   *
   * Caveat: behaviour-changing overrides on automation/cli/mcp_server callers
   * may have lane-load and analytics implications. Prefer to test override
   * combinations with the agreement assertion harness (Stage 5 removes the
   * harness; until then, divergences will surface as structured logs).
   */
  policy?: Partial<TurnPolicy>;

  sessionId?: string;
  resetConversation?: boolean;
  attachments?: AnyAttachmentPayload[];
  privateMode?: boolean;
  modelOverride?: string;
  thinkingModelOverride?: string;
  workingProfileOverrideId?: string;
  thinkingProfileOverrideId?: string;
  thinkingEffortOverride?: ThinkingEffort;
  councilMode?: boolean;
  unleashedMode?: boolean;
  finishLine?: string;
  activeProviderOverride?: ActiveProvider;
  bypassToolSafety?: boolean;

  approvalHandler?: ApprovalHandler;
}
