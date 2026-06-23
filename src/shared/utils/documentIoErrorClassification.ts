type UserMessage = {
  title: string;
  description?: string;
};

const WRITE_CONFLICT_MESSAGE = 'This shared skill changed elsewhere. Reload it before saving again.';

// Whitelist of error names that are safe to emit verbatim. Anything else is
// clamped to 'CustomError' to avoid leaking arbitrary library-defined names.
// `ZodError` is included because the IPC boundary is contract-first with Zod
// schemas (see AGENTS.md "Contract-first IPC with Zod"), so a validation
// failure on settingsApi.get / getStagedFiles / publishStagedFile /
// keepStagedFilePrivate is a plausible failure mode at this hook's emit
// sites and is high-value triage signal.
const KNOWN_ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'AbortError',
  'TimeoutError',
  'NetworkError',
  'ZodError',
  'NonError',
]);

export const ACTIONABLE_WRITE_ERRNOS: ReadonlySet<string> = new Set([
  'ENOSPC',
  'EDQUOT',
  'EACCES',
  'EPERM',
  'EROFS',
]);

export class WriteFailureError extends Error {
  code: string;

  constructor(code: string) {
    super('Unable to save file changes.');
    this.code = code;
  }
}

/**
 * Privacy-safe error classifier for telemetry. Extracts low-cardinality
 * fields (constructor name, errno code) from an error without ever exposing
 * `err.message` — Node.js `fs` errors frequently include absolute paths
 * (e.g. `EACCES: permission denied, open '/Users/.../file.md'`) which
 * would leak through `sanitizeMetadata` (which only strips control chars
 * and bounds length, not paths).
 *
 * Both `Error.name` and `Error.code` are technically arbitrary strings on
 * any thrown object, so we whitelist:
 *   - `errorName` to a known-safe set (constructor names from `globalThis`
 *     plus a few common ones); other names collapse to `'CustomError'`.
 *   - `errorCode` to the strict POSIX errno pattern `^E[A-Z]+$` (length-bound).
 *
 * Always prefer this over inlining `err.message` when emitting telemetry.
 */
export type SafeErrorClassifier = {
  errorName: string;
  errorCode?: string;
  errorKind: 'fs' | 'unknown';
};

export function classifySafeError(err: unknown): SafeErrorClassifier {
  if (err instanceof Error) {
    const rawCode = (err as NodeJS.ErrnoException).code;
    // Whitelist errno code: must match POSIX errno shape and be short.
    const codeMatches = typeof rawCode === 'string'
      && rawCode.length <= 16
      && /^E[A-Z]+$/.test(rawCode);
    const code = codeMatches ? rawCode : undefined;
    const errorKind: SafeErrorClassifier['errorKind'] = code ? 'fs' : 'unknown';
    const safeName = KNOWN_ERROR_NAMES.has(err.name) ? err.name : 'CustomError';
    return {
      errorName: safeName,
      ...(code ? { errorCode: code } : {}),
      errorKind,
    };
  }
  return { errorName: 'NonError', errorKind: 'unknown' };
}

export function errnoToUserMessage(errorCode: string | undefined): UserMessage {
  switch (errorCode) {
    case 'ENOSPC':
    case 'EDQUOT':
      return {
        title: 'Your storage is full.',
        description: 'Free up some space and try again.',
      };
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return {
        title: "Rebel can't write to this file.",
        description: 'It may be read-only — check permissions and try again.',
      };
    case 'EISDIR':
    case 'ENOTDIR':
      return { title: "That location isn't a writable file." };
    default:
      return { title: 'Unable to save file changes.' };
  }
}

export function writeErrorToUserMessage(err: WriteFailureError): UserMessage;
export function writeErrorToUserMessage(err: unknown): UserMessage;
export function writeErrorToUserMessage(err: unknown): UserMessage {
  if (err instanceof Error && err.message === WRITE_CONFLICT_MESSAGE) {
    return { title: WRITE_CONFLICT_MESSAGE };
  }
  return errnoToUserMessage(classifySafeError(err).errorCode);
}
