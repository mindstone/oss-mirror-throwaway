import { describe, expect, it } from 'vitest';
import { MissingBundledSuperMcpError } from '@core/services/superMcpHttpManager';
import { categorizeError } from '../safeModeContext';

function errnoError(code: string, message = `spawn ${code}`): Error {
  return Object.assign(new Error(message), { code });
}

describe('categorizeError', () => {
  it('classifies new categories from structured error codes', () => {
    expect(categorizeError(errnoError('ENOENT'))).toBe('spawn_missing_executable');
    expect(categorizeError(errnoError('EMFILE', 'EMFILE: too many open files'))).toBe('fs_exhaustion');
    expect(categorizeError(errnoError('ENFILE', 'ENFILE: file table overflow'))).toBe('fs_exhaustion');
  });

  it('classifies missing bundled Super-MCP errors by error class', () => {
    const error = new MissingBundledSuperMcpError('/Applications/Rebel.app/Contents/Resources/super-mcp/dist/cli.js');

    expect(categorizeError(error)).toBe('missing_bundle');
  });

  it('classifies new categories from first-line messages only', () => {
    expect(categorizeError(new Error('Packaged Rebel is missing its bundled Super-MCP runtime at /redacted/path'))).toBe('missing_bundle');
    expect(categorizeError(new Error('spawn ENOENT /redacted/path'))).toBe('spawn_missing_executable');
    expect(categorizeError(new Error('EMFILE: too many open files, open /redacted/path'))).toBe('fs_exhaustion');
    expect(categorizeError(new Error('Super-MCP HTTP server failed to start within 30000ms (150 attempts)'))).toBe('health_timeout');
  });

  it('does not classify from misleading spawn-log tail keywords', () => {
    const error = new Error(
      'Super-MCP failed for an opaque startup reason\n' +
        'Child process output (last 4KB):\n' +
        'permission denied timeout EADDRINUSE EMFILE missing bundled Super-MCP runtime',
    );

    expect(categorizeError(error)).toBe('unknown');
  });

  it('classifies manager startup-death and health-check-timeout messages', () => {
    expect(categorizeError(new Error('Super-MCP process died during startup\nChild process output: timeout'))).toBe('process_crash');
    expect(categorizeError(new Error('Super-MCP HTTP server failed to start within 30000ms (150 attempts)'))).toBe('health_timeout');
  });
});
