import { z } from 'zod';

export type OperatorKind = 'operator';
export type OperatorRole = 'operator' | 'live_meeting';
export type OperatorSourceCategory = 'bundled' | 'space';

export interface OperatorFrontmatter {
  name: string;
  description: string;
  consult_when: string;
  kind: OperatorKind;
  roles: OperatorRole[];
  proactive_interval_minutes?: number;
  use_cases?: string[];
  consultation_prompt?: string;
  live_prompt?: string;
  display_name?: string;
  /** Reserved for future extension semantics; Stage 1 only persists the value. */
  extends?: string;
}

export interface OperatorDefinition {
  /**
   * Stable registry id. Stage 1 uses `{spacePath}::${operatorSlug}` so
   * same-named Operators can coexist in different Spaces.
   */
  id: string;
  operatorSlug: string;
  spacePath: string;
  sourceSpacePath?: string;
  category?: OperatorSourceCategory;
  operatorDirAbsolutePath: string;
  operatorFileAbsolutePath: string;
  groundingPath: string;
  diaryPath: string;
  /** Raw parsed frontmatter (snake_case) for round-trip serialization paths. */
  frontmatter: OperatorFrontmatter;
  name: string;
  description: string;
  consult_when: string;
  kind: OperatorKind;
  roles: OperatorRole[];
  /** Reserved for future extension semantics; Stage 1 only persists the value. */
  extends?: string;
  proactiveIntervalMinutes?: number;
  useCases?: string[];
  consultationPrompt?: string;
  livePrompt?: string;
  displayName?: string;
  /** Markdown body from OPERATOR.md, excluding frontmatter. */
  body: string;
  /**
   * Non-blocking author warnings (e.g. description longer than recommended).
   * Operator still loads and is available; the panel surfaces these so
   * authors can tighten copy without the Operator silently disappearing.
   */
  warnings?: string[];
}

export interface OperatorListOptions {
  roleFilter?: OperatorRole;
  /**
   * Resolved (absolute, `path.resolve`-normalised) SPACE roots whose operator
   * directory-walk root `realpath` must be FORCED through the killable cloud lane.
   * Set by `buildOperatorPromptMetadata` for a scan-discovered Chief-of-Staff SYMLINK
   * absent from `settings.spaces` (the dead-Drive case) — its workspace path is
   * pattern-LOCAL and containment never learned it, so without this the walk root
   * realpath would take the bare-fs LOCAL lane and HANG dereferencing the dead cloud
   * symlink target (260622 Phase-7 F1, rd4-analogous). Omitted/empty → every root keeps
   * its normal pattern/containment lane selection (local fast path preserved).
   */
  forceCloudRoots?: ReadonlySet<string>;
}

export const OPERATOR_ACTIVATION_ERROR_CODES = [
  'already_activated',
  'source_not_found',
  'target_not_writable',
  'copy_failed',
  'operator_not_found',
  'space_not_found',
  'broadcast_failed',
  'delete_failed',
  'display_name_too_long',
  'write_failed',
  'slug_collision_unresolvable',
  'live_prompt_missing',
  'roles_would_be_empty',
] as const;

export type OperatorActivationErrorCode = typeof OPERATOR_ACTIVATION_ERROR_CODES[number];

export interface ActivateOperatorRequest {
  operatorSlug: string;
  sourceSpacePath: string;
  targetSpacePath: string;
}

export interface ActivateOperatorResponse {
  success: boolean;
  errorCode?: OperatorActivationErrorCode;
  activatedPath?: string;
  orphanPath?: string;
  existingOperatorPath?: string;
}

export interface RemoveOperatorRequest {
  operatorSlug: string;
  targetSpacePath: string;
}

export type RemoveOperatorErrorCode =
  | 'operator_not_found'
  | 'space_not_found'
  | 'delete_failed';

export type RemoveOperatorResponse =
  | { success: true }
  | {
      success: false;
      errorCode: RemoveOperatorErrorCode;
    };

export interface SetOperatorDisplayNameRequest {
  operatorSlug: string;
  targetSpacePath: string;
  displayName: string | null;
}

export type SetOperatorDisplayNameErrorCode =
  | 'operator_not_found'
  | 'display_name_too_long'
  | 'write_failed';

export type SetOperatorDisplayNameResponse =
  | { success: true }
  | {
      success: false;
      errorCode: SetOperatorDisplayNameErrorCode;
    };

export interface SetLiveMeetingEnabledRequest {
  operatorSlug: string;
  targetSpacePath: string;
  enabled: boolean;
}

export type SetLiveMeetingEnabledErrorCode =
  | 'operator_not_found'
  | 'live_prompt_missing'
  | 'roles_would_be_empty'
  | 'write_failed';

export type SetLiveMeetingEnabledResponse =
  | { success: true }
  | {
      success: false;
      errorCode: SetLiveMeetingEnabledErrorCode;
    };

export interface DuplicateOperatorRequest {
  sourceSlug: string;
  sourceSpacePath: string;
  newDisplayName: string;
}

export type DuplicateOperatorErrorCode =
  | 'source_not_found'
  | 'display_name_too_long'
  | 'slug_collision_unresolvable'
  | 'copy_failed';

export type DuplicateOperatorResponse =
  | { success: true; newSlug: string }
  | {
      success: false;
      errorCode: DuplicateOperatorErrorCode;
    };

export interface OperatorMetadata {
  id: string;
  operatorSlug: string;
  spacePath: string;
  sourceSpacePath: string;
  category: OperatorSourceCategory;
  name: string;
  description: string;
  consult_when: string;
  kind: OperatorKind;
  roles: OperatorRole[];
  proactiveIntervalMinutes?: number;
  useCases?: string[];
  displayName?: string;
  operatorFileAbsolutePath: string;
  groundingPath: string;
  diaryPath: string;
  warnings?: string[];
}

export const OperatorConsultToolInputSchema = z.object({
  operatorId: z.string().min(1, 'operatorId is required'),
  focus: z.string().min(1, 'focus is required'),
});
export type OperatorConsultToolInput = z.infer<typeof OperatorConsultToolInputSchema>;

export interface OperatorConsultRequest extends OperatorConsultToolInput {
  spacePath: string;
}

export interface OperatorConsultErrorResult {
  isError: true;
  errorCode: string;
  message: string;
  reason?: 'rate_limited' | 'malformed_response' | 'auth_failed' | 'network' | 'invalid_request' | 'unknown';
  operatorId?: string;
  operatorName?: string;
  availableIds?: string[];
}

export interface OperatorConsultNeedsCalibrationResult {
  isError: false;
  calibrated: false;
  errorCode: null;
  operatorId: string;
  operatorName: string;
  message: string;
}

export interface OperatorConsultSuccessResult {
  isError: false;
  calibrated: true;
  errorCode: null;
  operatorId: string;
  operatorName: string;
  perspective: string;
  evidenceCited: string[];
  confidence: number;
  diaryAppendFailed: boolean;
  message?: string;
  /** @deprecated Use perspective. Kept for a short compatibility window. */
  response?: string;
}

export type OperatorConsultResult =
  | OperatorConsultErrorResult
  | OperatorConsultNeedsCalibrationResult
  | OperatorConsultSuccessResult;

export type OperatorParseFailureCode =
  | 'malformed-frontmatter'
  | 'missing-name'
  | 'wrong-kind'
  | 'unsynced-stub'
  | 'invalid-frontmatter'
  | 'invalid-slug'
  | 'invalid-path-shape'
  | 'scan-truncated'
  // The OPERATOR.md lives on a dead/slow cloud (FUSE) mount; its bounded read timed
  // out. Distinct from `malformed-frontmatter` (a real read error) so the cause is
  // observable and the scan can continue calmly instead of silently dropping it.
  | 'reconnecting';

export interface OperatorParseFailure {
  spacePath: string;
  operatorSlug: string;
  operatorFileAbsolutePath: string;
  errorCode: OperatorParseFailureCode;
  message: string;
}

export interface OperatorScanResult {
  operators: OperatorDefinition[];
  failures: OperatorParseFailure[];
}

export function createOperatorId(spacePath: string, operatorSlug: string): string {
  return `${spacePath}::${operatorSlug}`;
}

export function parseOperatorId(operatorId: string): { spacePath?: string; operatorSlug: string } {
  const separatorIndex = operatorId.lastIndexOf('::');
  if (separatorIndex < 0) {
    return { operatorSlug: operatorId };
  }
  return {
    spacePath: operatorId.slice(0, separatorIndex),
    operatorSlug: operatorId.slice(separatorIndex + 2),
  };
}
