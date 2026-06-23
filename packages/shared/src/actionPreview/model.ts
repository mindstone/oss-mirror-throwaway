export type ActionEffectKind =
  | 'document'
  | 'message'
  | 'data-capture'
  | 'command'
  | 'external-record'
  | 'browser'
  | 'generic';

export type ContentVisibility = 'safe' | 'withheld' | 'unknown';

export type RiskReason = 'Shared' | 'Leaves Rebel' | 'Hard to undo';

export type Reversibility =
  | 'Can edit after posting'
  | 'Can edit after saving'
  | 'Runs once'
  | 'Hard to undo';

export interface BlastRadiusChip {
  label: string;
  /** `explicit` = directly present in payload, `derived` = deterministic transform. */
  evidence: 'explicit' | 'derived';
}

export interface BlastRadius {
  /** Group label in UI: "Where" */
  where: BlastRadiusChip[];
  /** Group label in UI: "Who can see it" */
  whoCanSeeIt: BlastRadiusChip[];
  /** Group label in UI: "Afterwards" */
  afterwards: BlastRadiusChip[];
}

export interface GenericStructuredRow {
  key: string;
  value: string;
  /**
   * When true, `value` is HTML markup (e.g. an HTML email body) and the
   * renderer must sanitize it before injecting it as markup. When false /
   * undefined the value is plain text and is rendered as an escaped text node.
   */
  isHtml?: boolean;
}

export type MemorySharing = 'private' | 'restricted' | 'company-wide' | 'public';
export type MemoryApprovalKind = 'memory_write' | 'shared_skill_checkpoint';

export interface ToolActionPreviewInput {
  kind: 'tool';
  toolName: string;
  effectiveToolId?: string;
  packageId?: string;
  reason?: string;
  args?: Record<string, unknown> | null;
  resolvedRecipientLabel?: string;
  resolvedChannelName?: string;
}

export interface StagedToolActionPreviewInput {
  kind: 'staged-tool';
  toolId: string;
  packageId?: string;
  displayName?: string;
  reason?: string;
  args?: Record<string, unknown> | null;
  automationId?: string;
  resolvedRecipientLabel?: string;
  resolvedChannelName?: string;
}

export interface MemoryActionPreviewInput {
  kind: 'memory';
  /** Canonical memory approval identifier (mirrors `MemoryWriteApproval.toolUseId`). */
  toolUseId?: string;
  filePath: string;
  spaceName: string;
  spacePath?: string;
  sharing?: MemorySharing;
  summary?: string;
  content?: string;
  contentPreview?: string;
  sensitivityReason?: string;
  isNewFile?: boolean;
  approvalKind?: MemoryApprovalKind;
  automationId?: string;
  hasConflict?: boolean;
}

export interface StagedFileActionPreviewInput {
  kind: 'staged-file';
  /** Canonical staged-file identifier (mirrors `StagedFile.id`). */
  stagedFileId?: string;
  filePath: string;
  spaceName: string;
  spacePath?: string;
  sharing?: MemorySharing;
  summary?: string;
  contentPreview?: string;
  sensitivityReason?: string;
  baseHash?: string;
  isNewFile?: boolean;
  hasConflict?: boolean;
  approvalKind?: MemoryApprovalKind;
  automationId?: string;
}

export type ActionPreviewInput =
  | ToolActionPreviewInput
  | StagedToolActionPreviewInput
  | MemoryActionPreviewInput
  | StagedFileActionPreviewInput;

export interface ActionPreviewModel {
  effectKind: ActionEffectKind;
  title: string;
  contentVisibility: ContentVisibility;
  blastRadius: BlastRadius;
  reversibility: Reversibility | null;
  riskReasons: RiskReason[];
  structuredArgs: GenericStructuredRow[];
  /**
   * Redacted args for receipts accordion. Never contains raw unredacted data.
   */
  safeRawArgs: Record<string, unknown>;
}
