#!/usr/bin/env npx tsx
/**
 * CI guard: macOS CLT-shimmed command names must be denied before the agent
 * Bash tool can shell-spawn them on CLT-missing Macs.
 *
 * This is intentionally source-shaped rather than a broad ESLint selector: the
 * invariant spans the Bash spawn chokepoint, the PreToolUse hook registration,
 * and the canonical shim-name table in pythonRuntimeService.
 *
 * Wired into: npm run validate:fast
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();

const FILES = {
  builtinTools: path.join(REPO_ROOT, 'src/core/rebelCore/builtinTools.ts'),
  toolSafety: path.join(REPO_ROOT, 'src/core/services/safety/toolSafetyService.ts'),
  pythonRuntime: path.join(REPO_ROOT, 'src/main/services/pythonRuntimeService.ts'),
} as const;

const REQUIRED_SHIM_BINARIES = [
  'python',
  'python3',
  'pip',
  'pip3',
  'git',
  'clang',
  'clang++',
  'make',
  'swift',
  'swiftc',
  'lldb',
  'gcc',
  'g++',
  'ld',
  'strip',
  'nm',
  'otool',
] as const;

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

function lineNumberForIndex(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function addIfMissing(
  failures: string[],
  text: string,
  needle: string | RegExp,
  message: string,
): void {
  const found = typeof needle === 'string' ? text.includes(needle) : needle.test(text);
  if (!found) failures.push(message);
}

function extractShimTable(text: string): string | null {
  const match = text.match(
    /export const MACOS_CLT_SHIM_PATHS_BY_BINARY = \{([\s\S]*?)\} as const/s,
  );
  return match?.[1] ?? null;
}

function findShellSpawnSites(text: string): Array<{ index: number; line: number; snippet: string }> {
  const sites: Array<{ index: number; line: number; snippet: string }> = [];
  const spawnRe = /\bspawn\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = spawnRe.exec(text)) !== null) {
    const start = match.index;
    const snippet = text.slice(start, Math.min(text.length, start + 500));
    if (/shell\s*:\s*true/.test(snippet)) {
      sites.push({
        index: start,
        line: lineNumberForIndex(text, start),
        snippet,
      });
    }
  }
  return sites;
}

const failures: string[] = [];

const builtinTools = read(FILES.builtinTools);
const toolSafety = read(FILES.toolSafety);
const pythonRuntime = read(FILES.pythonRuntime);

const shimTable = extractShimTable(pythonRuntime);
if (!shimTable) {
  failures.push(
    'src/main/services/pythonRuntimeService.ts: missing canonical MACOS_CLT_SHIM_PATHS_BY_BINARY table',
  );
} else {
  for (const binary of REQUIRED_SHIM_BINARIES) {
    const keyPattern = new RegExp(
      `(?:['"]${binary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]|${binary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s*:`,
    );
    const pathLiteral = `'/usr/bin/${binary}'`;
    if (!keyPattern.test(shimTable) || !shimTable.includes(pathLiteral)) {
      failures.push(
        `src/main/services/pythonRuntimeService.ts: MACOS_CLT_SHIM_PATHS_BY_BINARY must include ${binary}: ['/usr/bin/${binary}']`,
      );
    }
  }
}

addIfMissing(
  failures,
  pythonRuntime,
  'export async function macosCommandResolvesToCltShim',
  'src/main/services/pythonRuntimeService.ts: missing generalized macosCommandResolvesToCltShim resolver',
);
addIfMissing(
  failures,
  pythonRuntime,
  "/usr/bin/which', ['-a', cmd]",
  'src/main/services/pythonRuntimeService.ts: resolver must use /usr/bin/which -a for never-exec first-hit lookup',
);
addIfMissing(
  failures,
  pythonRuntime,
  "runProbe('/usr/bin/xcode-select', ['-p']",
  'src/main/services/pythonRuntimeService.ts: resolver must use xcode-select -p CLT-state probe, not candidate exec',
);

addIfMissing(
  failures,
  toolSafety,
  'MACOS_CLT_SHIM_BINARY_NAMES',
  'src/core/services/safety/toolSafetyService.ts: guard parser must be driven by MACOS_CLT_SHIM_BINARY_NAMES',
);
addIfMissing(
  failures,
  toolSafety,
  'macosCommandResolvesToCltShim',
  'src/core/services/safety/toolSafetyService.ts: guard must call generalized macosCommandResolvesToCltShim',
);
addIfMissing(
  failures,
  toolSafety,
  'export function detectMacosCltShimCommandInHeader',
  'src/core/services/safety/toolSafetyService.ts: missing generalized CLT-shim command-header detector',
);
addIfMissing(
  failures,
  toolSafety,
  'export async function macosCltShimGuard',
  'src/core/services/safety/toolSafetyService.ts: missing macosCltShimGuard',
);
addIfMissing(
  failures,
  toolSafety,
  'const shimExe = detectMacosCltShimCommandInHeader(header)',
  'src/core/services/safety/toolSafetyService.ts: macosCltShimGuard must parse Bash headers for generalized CLT-shim commands',
);
addIfMissing(
  failures,
  toolSafety,
  'permissionDecisionReason: buildMacosCltShimDenyReason(shimExe)',
  'src/core/services/safety/toolSafetyService.ts: CLT-shim deny UX must come from the shared per-binary helper',
);

const windowsGuardIndex = toolSafety.indexOf('await windowsPythonGuard(toolName, toolInput, log)');
const macGuardIndex = toolSafety.indexOf('await macosCltShimGuard(toolName, toolInput, log)');
const mcpServerModeIndex = toolSafety.indexOf('process.env.REBEL_MCP_SERVER_MODE');
if (windowsGuardIndex < 0 || macGuardIndex < 0) {
  failures.push(
    'src/core/services/safety/toolSafetyService.ts: PreToolUse hook must call windowsPythonGuard followed by macosCltShimGuard before LLM safety evaluation',
  );
} else if (windowsGuardIndex > macGuardIndex) {
  failures.push(
    'src/core/services/safety/toolSafetyService.ts: macosCltShimGuard must remain after windowsPythonGuard so platform shim guards stay together',
  );
}
if (macGuardIndex < 0 || mcpServerModeIndex < 0 || macGuardIndex > mcpServerModeIndex) {
  failures.push(
    'src/core/services/safety/toolSafetyService.ts: macosCltShimGuard must run before MCP-server-mode auto-approval / LLM safety evaluation',
  );
}

const shellSpawnSites = findShellSpawnSites(builtinTools);
if (shellSpawnSites.length !== 1) {
  failures.push(
    `src/core/rebelCore/builtinTools.ts: expected exactly one shell:true spawn chokepoint, found ${shellSpawnSites.length}. Update this guard and macosCltShimGuard when adding another shell spawn.`,
  );
} else {
  const [site] = shellSpawnSites;
  if (!site.snippet.includes('spawn(command,')) {
    failures.push(
      `src/core/rebelCore/builtinTools.ts:${site.line}: shell:true spawn must remain the Bash command chokepoint or this guard must be updated`,
    );
  }
  if (!/env\s*:\s*process\.env/.test(site.snippet)) {
    failures.push(
      `src/core/rebelCore/builtinTools.ts:${site.line}: Bash spawn must use process.env so macosCltShimGuard resolves the same PATH`,
    );
  }
}

if (findShellSpawnSites(toolSafety).length > 0) {
  failures.push(
    'src/core/services/safety/toolSafetyService.ts: tool-safety layer must not add shell:true spawns; route PATH-resolved command execution through the guarded Bash tool',
  );
}

if (failures.length > 0) {
  console.error(`ERROR: macOS CLT shim guard invariant failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('✓ macOS CLT shim guard chokepoint is intact');
