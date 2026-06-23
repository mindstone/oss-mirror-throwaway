/**
 * Contribution sensitive-file rules shared by public submission plumbing.
 *
 * The Mindstone relay owns the backend parity contract, but the public file
 * reader and request schema still need the same local fail-closed rules so a
 * missing private extension never causes sensitive files to be gathered.
 */

export const DENYLISTED_EXTENSIONS = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.crt',
  '.ppk',
  '.sh.bak',
  '.key.bak',
  '.pem.bak',
  '.p12.bak',
  '.pfx.bak',
  '.crt.bak',
  '.ppk.bak',
] as const;

export function isDenylistedFilename(basename: string): boolean {
  const lower = basename.toLowerCase();
  if (lower === '.env') return true;
  if (lower.startsWith('.env.')) return true;
  if (lower.endsWith('.env')) return true;
  if (lower.includes('.env.')) return true;
  for (const ext of DENYLISTED_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}
