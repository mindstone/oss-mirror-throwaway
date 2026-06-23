import crypto from 'node:crypto';

export interface StackFrame {
  filename?: string;
  function?: string;
  lineno?: number;
}

function normalizeFrameFile(filename: string | undefined): string {
  const normalized = (filename ?? '').replace(/\\/g, '/').trim().toLowerCase();
  const nodeModulesMarker = '/node_modules/';
  const markerIndex = normalized.lastIndexOf(nodeModulesMarker);
  if (markerIndex >= 0) {
    return normalized.slice(markerIndex + nodeModulesMarker.length);
  }
  if (normalized.startsWith('node_modules/')) {
    return normalized.slice('node_modules/'.length);
  }
  return normalized;
}

function normalizeFrameFunction(functionName: string | undefined): string {
  return (functionName ?? '').trim().toLowerCase();
}

function hashParts(parts: readonly string[]): string {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

function topFrames(stackFrames: readonly StackFrame[] | null | undefined): StackFrame[] | null {
  if (!stackFrames || stackFrames.length === 0) {
    return null;
  }
  return stackFrames.slice(0, 3);
}

/**
 * Cross-release fingerprint: stable across line-number drift by hashing only
 * the top stack frames' file/function pairs.
 */
export function fingerprintLooseHash(stackFrames: readonly StackFrame[] | null | undefined): string | null {
  const frames = topFrames(stackFrames);
  if (!frames) {
    return null;
  }

  return hashParts(
    frames.map((frame) => `${normalizeFrameFile(frame.filename)}:${normalizeFrameFunction(frame.function)}`),
  );
}

/**
 * In-tick fingerprint: includes line numbers, so Stage 1.3 can distinguish
 * nearby callsites in the same file/function.
 */
export function fingerprintTightHash(stackFrames: readonly StackFrame[] | null | undefined): string | null {
  const frames = topFrames(stackFrames);
  if (!frames) {
    return null;
  }

  if (frames.some((frame) => !Number.isInteger(frame.lineno))) {
    return null;
  }

  return hashParts(
    frames.map(
      (frame) =>
        `${normalizeFrameFile(frame.filename)}:${normalizeFrameFunction(frame.function)}:${frame.lineno}`,
    ),
  );
}
