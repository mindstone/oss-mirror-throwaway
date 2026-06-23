import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const TEARDOWN_FILE = 'mobile/src/services/accountScopedStateTeardown.ts';
const DEVICE_SCOPED_RE = /@device-scoped:\s*\S.+/;

const SCAN_ROOTS = [
  'mobile/app',
  'mobile/src',
  'cloud-client/src/auth',
  'cloud-client/src/offlineQueue',
  'cloud-client/src/persistence',
  'cloud-client/src/stores',
] as const;

const EXCLUDE_PARTS = new Set([
  '__tests__',
  'node_modules',
  'build',
  'dist',
]);

const PERSISTENCE_PATTERNS: readonly RegExp[] = [
  /\bimport\s+AsyncStorage\s+from\s+['"]@react-native-async-storage\/async-storage['"]/,
  /\bimport\s+\*\s+as\s+SecureStore\s+from\s+['"]expo-secure-store['"]/,
  /\bFileSystem\.(?:writeAsStringAsync|makeDirectoryAsync)\s*\(/,
  /\bnew\s+(?:Directory|ExpoFile)\s*\(/,
  /\b(?:persistStore|buildCacheKey)\s*\(/,
  // iOS App Group / widget shared storage (ExtensionStorage from @bacons/apple-targets).
  // App Group writes survive account switch and are user-content-bearing, so any new
  // App Group writer must be routed through teardown or explicitly @device-scoped.
  /@bacons\/apple-targets/,
];

function toRepoPath(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_PARTS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, out);
      continue;
    }
    if (!/\.(?:ts|tsx)$/.test(entry.name)) continue;
    if (/\.(?:test|spec)\.tsx?$/.test(entry.name)) continue;
    out.push(fullPath);
  }
  return out;
}

function readTeardownSurfacePaths(): Set<string> {
  const teardownPath = path.join(REPO_ROOT, TEARDOWN_FILE);
  const source = fs.readFileSync(teardownPath, 'utf8');
  const covered = new Set<string>([TEARDOWN_FILE]);
  const stringLiteralRe = /['"]((?:mobile|cloud-client)\/[^'"]+\.tsx?)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = stringLiteralRe.exec(source)) !== null) {
    covered.add(match[1]);
  }
  return covered;
}

function touchesPersistencePrimitive(source: string): boolean {
  const code = stripComments(source);
  return PERSISTENCE_PATTERNS.some((pattern) => pattern.test(code));
}

function main(): void {
  const covered = readTeardownSurfacePaths();
  const candidates = SCAN_ROOTS.flatMap((root) => walk(path.join(REPO_ROOT, root)));
  const failures: string[] = [];

  for (const filePath of candidates) {
    const repoPath = toRepoPath(filePath);
    const source = fs.readFileSync(filePath, 'utf8');
    if (!touchesPersistencePrimitive(source)) continue;
    if (covered.has(repoPath)) continue;
    if (DEVICE_SCOPED_RE.test(source)) continue;

    failures.push(
      `${repoPath}: touches mobile persistence but is not covered by wipeAllAccountScopedState ` +
      `and has no // @device-scoped: <one-line justification> marker. ` +
      `See docs/plans/260607_cloud-mobile-bug-prevention-longlist/subagent_reports/260607_060703_researcher-b2-teardown-spike.md.`,
    );
  }

  if (failures.length > 0) {
    console.error('Auth teardown coverage check failed:');
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log(`Auth teardown coverage check passed (${covered.size} account-scoped surfaces listed).`);
}

main();
