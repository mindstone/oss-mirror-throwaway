import type { SafeModeErrorCategory } from '@shared/types/safeMode';

type ErrorRecord = {
  code?: unknown;
  message?: unknown;
  name?: unknown;
};

function asErrorRecord(error: unknown): ErrorRecord | null {
  if (!error || typeof error !== 'object') return null;
  return error as ErrorRecord;
}

function getErrorCode(error: unknown): string | undefined {
  const code = asErrorRecord(error)?.code;
  return typeof code === 'string' ? code : undefined;
}

function getErrorName(error: unknown): string | undefined {
  const name = asErrorRecord(error)?.name;
  return typeof name === 'string' ? name : undefined;
}

function getFirstLineMessage(error: unknown): string {
  const recordMessage = asErrorRecord(error)?.message;
  const message = typeof recordMessage === 'string' ? recordMessage : String(error);
  return (message.split(/\r?\n/, 1)[0] ?? '').toLowerCase();
}

export function categorizeSafeModeError(
  error: unknown,
  _attemptPhase?: string,
): SafeModeErrorCategory {
  if (!error) return 'unknown';

  const code = getErrorCode(error);
  if (code) {
    switch (code) {
      case 'ENOENT':
        return 'spawn_missing_executable';
      case 'EADDRINUSE':
        return 'port_conflict';
      case 'ECONNREFUSED':
      case 'ETIMEDOUT':
      case 'ENOTFOUND':
      case 'ENETUNREACH':
        return 'network';
      case 'EACCES':
      case 'EPERM':
        return 'permission';
      case 'EMFILE':
      case 'ENFILE':
        return 'fs_exhaustion';
    }
  }

  if (getErrorName(error) === 'MissingBundledSuperMcpError') {
    return 'missing_bundle';
  }

  const firstLine = getFirstLineMessage(error);

  if (firstLine.includes('missing its bundled super-mcp runtime')) {
    return 'missing_bundle';
  }
  if (firstLine.includes('enoent') || firstLine.includes('no such file or directory')) {
    return 'spawn_missing_executable';
  }
  if (firstLine.includes('emfile') || firstLine.includes('enfile') || firstLine.includes('too many open files')) {
    return 'fs_exhaustion';
  }
  if (firstLine.includes('process died during startup')) {
    return 'process_crash';
  }
  if (/failed to start within\s+\d+ms/.test(firstLine)) {
    return 'health_timeout';
  }
  if (firstLine.includes('eaddrinuse') || (firstLine.includes('port') && firstLine.includes('in use'))) {
    return 'port_conflict';
  }
  if (firstLine.includes('json') && (firstLine.includes('parse') || firstLine.includes('syntax'))) {
    return 'config_parse';
  }
  if (firstLine.includes('econnrefused') || firstLine.includes('etimedout') || firstLine.includes('network')) {
    return 'network';
  }
  if (firstLine.includes('permission') || firstLine.includes('eacces') || firstLine.includes('eperm')) {
    return 'permission';
  }
  if (firstLine.includes('exit') || firstLine.includes('sigterm') || firstLine.includes('sigkill') || firstLine.includes('crashed')) {
    return 'process_crash';
  }
  if (firstLine.includes('timeout')) {
    return 'timeout';
  }

  return 'unknown';
}
