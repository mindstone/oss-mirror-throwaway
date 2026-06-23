import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type GuardOptions = {
  label?: string;
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_TMP_DIR = path.resolve(moduleDir, '..', '..', 'tmp');

export function isTestContext(): boolean {
  return process.env.REBEL_E2E_TEST_MODE === '1' || process.env.NODE_ENV === 'test';
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith(`~${path.sep}`)) return path.join(os.homedir(), input.slice(2));
  return input;
}

function realpathBestEffort(input: string): string {
  const resolved = path.resolve(expandHome(input));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    // Resolve the nearest existing ancestor so symlinked temp roots such as
    // /tmp -> /private/tmp are still compared by their real location.
  }

  const parts = resolved.split(path.sep).filter(Boolean);
  const root = path.parse(resolved).root;
  for (let index = parts.length; index >= 0; index -= 1) {
    const ancestor = path.join(root, ...parts.slice(0, index));
    try {
      const realAncestor = fs.realpathSync.native(ancestor);
      return path.join(realAncestor, ...parts.slice(index));
    } catch {
      // Keep walking up until an existing ancestor is found.
    }
  }

  return resolved;
}

function normalizeForCompare(input: string): string {
  const normalized = path.normalize(input);
  return normalized.length > 1 && normalized.endsWith(path.sep)
    ? normalized.slice(0, -1)
    : normalized;
}

function isSameOrInside(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeForCompare(candidate);
  const normalizedRoot = normalizeForCompare(root);
  if (normalizedCandidate === normalizedRoot) return true;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function unsafeDesktopDataRoots(): string[] {
  const home = os.homedir();
  const roots = [
    path.join(home, 'Library', 'Application Support', 'mindstone-rebel'),
    path.join(home, '.config', 'mindstone-rebel'),
    path.join(home, 'AppData', 'Roaming', 'mindstone-rebel'),
  ];
  if (process.env.APPDATA) {
    roots.push(path.join(process.env.APPDATA, 'mindstone-rebel'));
  }
  return roots;
}

function allowedTempRoots(): string[] {
  return [
    os.tmpdir(),
    '/tmp',
    '/private/tmp',
    REPO_TMP_DIR,
  ].map(realpathBestEffort);
}

function buildError(label: string, dataRoot: string | undefined, reason: string): Error {
  const renderedPath = dataRoot === undefined || dataRoot.trim().length === 0 ? '<unset>' : dataRoot;
  return new Error(
    `${label} is unsafe for Rebel test/E2E data isolation: ${renderedPath}. ${reason}. ` +
      'Set REBEL_USER_DATA to a temporary directory under os.tmpdir(), /tmp, /private/tmp, or the repo tmp/ directory.',
  );
}

export function assertTestDataRootSafe(dataRoot: string | undefined, opts: GuardOptions = {}): void {
  if (!isTestContext()) return;

  const label = opts.label ?? 'REBEL_USER_DATA';
  if (dataRoot === undefined || dataRoot.trim().length === 0) {
    throw buildError(label, dataRoot, 'Test context requires an explicit non-empty data root');
  }

  const realDataRoot = realpathBestEffort(dataRoot);
  const normalizedRealDataRoot = normalizeForCompare(realDataRoot);
  const normalizedDataPath = normalizeForCompare(path.resolve(expandHome(dataRoot)));

  const productionDataPath = normalizeForCompare(path.resolve('/data'));
  if (normalizedRealDataRoot === productionDataPath || normalizedDataPath === productionDataPath) {
    throw buildError(label, dataRoot, 'The production cloud /data volume is not allowed in local tests');
  }

  for (const unsafeRoot of unsafeDesktopDataRoots().map(realpathBestEffort)) {
    if (normalizedRealDataRoot === normalizeForCompare(unsafeRoot)) {
      throw buildError(label, dataRoot, 'The real Rebel desktop userData directory is not allowed in tests');
    }
  }

  const home = normalizeForCompare(realpathBestEffort(os.homedir()));
  if (normalizedRealDataRoot === home) {
    throw buildError(label, dataRoot, 'The home directory is not allowed in tests');
  }

  if (path.dirname(normalizedRealDataRoot) === home) {
    throw buildError(label, dataRoot, 'A direct non-temp child of the home directory is not allowed in tests');
  }

  const allowed = allowedTempRoots();
  if (!allowed.some((root) => isSameOrInside(normalizedRealDataRoot, root))) {
    throw buildError(label, dataRoot, 'The path is not under an allowed temporary root');
  }
}
