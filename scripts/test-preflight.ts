import { execFile } from 'node:child_process';
import { access, readdir, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type Status = 'PASS' | 'INFO' | 'WARN' | 'FAIL';
type Mode = 'full' | 'quick';

interface CheckResult {
  label: string;
  status: Status;
  detail?: string;
  remediation?: string;
  summaryValue?: string;
}

interface ProcessInfo {
  pid: number;
  command: string;
}

interface ExecFileFailure extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

const repoRoot = process.cwd();
const quickMode = process.argv.includes('--quick');
const mode: Mode = quickMode ? 'quick' : 'full';

const quickLabels = ['Disk free', 'Node on PATH', 'Submodules', 'Super MCP dist', 'Rebel CLI dist', '.env.local'];
const fullLabels = [
  'Disk free',
  'Port 5173',
  'Port 9222',
  'rebel-test processes',
  'Installed app',
  'MCP dev-server state files',
  'Node on PATH',
  'Submodules',
  'Super MCP dist',
  'Rebel CLI dist',
  '.env.local',
  'Temp dir',
];

function relativePath(...segments: string[]): string {
  return path.join(...segments);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return `${gib.toFixed(1)}GB`;
}

async function runCommand(command: string, args: string[], timeoutMs = 750): Promise<{ stdout: string; stderr: string } | null> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: repoRoot,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch {
    return null;
  }
}

async function runUnixProbe(command: string, args: string[], timeoutMs = 750): Promise<{ stdout: string; unavailable: boolean }> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd: repoRoot,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, unavailable: false };
  } catch (error) {
    const failure = error as ExecFileFailure;
    if (failure.code === 1) {
      return { stdout: failure.stdout ?? '', unavailable: false };
    }
    return { stdout: failure.stdout ?? '', unavailable: true };
  }
}

async function checkDiskFree(): Promise<CheckResult> {
  try {
    const stats = await statfs(repoRoot);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const free = formatBytes(freeBytes);

    if (freeBytes < 2 * 1024 ** 3) {
      return {
        label: 'Disk free',
        status: 'FAIL',
        detail: `${free} available at ${repoRoot}`,
        remediation: 'Free at least 2GB before launching or packaging Rebel.',
      };
    }

    if (freeBytes < 10 * 1024 ** 3) {
      return {
        label: 'Disk free',
        status: 'WARN',
        detail: `${free} available at ${repoRoot}; packaged build path will be tight.`,
        remediation: 'Free space or skip packaged-app validation until at least 10GB is available.',
      };
    }

    return { label: 'Disk free', status: 'PASS', summaryValue: free };
  } catch (error) {
    return {
      label: 'Disk free',
      status: 'FAIL',
      detail: error instanceof Error ? error.message : 'Unable to read filesystem statistics.',
      remediation: 'Check filesystem permissions and retry from the repo root.',
    };
  }
}

async function checkNodeOnPath(): Promise<CheckResult> {
  const result = await runCommand('node', ['--version']);
  const version = result?.stdout.trim();

  if (!version) {
    return {
      label: 'Node on PATH',
      status: 'FAIL',
      detail: '`node --version` failed.',
      remediation: 'Install Node.js >=20 and ensure `node` is available on PATH.',
    };
  }

  return { label: 'Node on PATH', status: 'PASS', summaryValue: version };
}

// Whether a submodule is declared in this checkout's `.gitmodules`. The OSS public
// mirror ships a `.gitmodules` without `mcp-servers` (it's a standalone public repo,
// not a submodule of the app mirror), so a checkout-aware preflight must not hard-
// require a submodule that isn't declared here. Mirrors the predev guard in
// scripts/update-submodule-if-declared.mjs.
async function isSubmoduleDeclared(name: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['config', '--file', path.join(repoRoot, '.gitmodules'), '--get-regexp', '^submodule\\..*\\.path$'],
      { cwd: repoRoot },
    );
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [key, ...rest] = trimmed.split(/\s+/);
      const submodulePath = rest.join(' ');
      const match = /^submodule\.(.+)\.path$/.exec(key);
      if ((match && match[1] === name) || submodulePath === name) return true;
    }
    return false;
  } catch {
    // git config exits non-zero when .gitmodules has no entries / is absent → not declared.
    return false;
  }
}

async function checkSubmodules(): Promise<CheckResult> {
  // rebel-system + super-mcp are submodules on every surface (incl. the OSS mirror).
  const required = [
    { name: 'rebel-system', marker: relativePath('rebel-system', 'package.json') },
    { name: 'super-mcp', marker: relativePath('super-mcp', 'package.json') },
  ];
  // mcp-servers is required only where it's actually declared as a submodule (canonical);
  // on the OSS mirror it's stripped from .gitmodules, so skip it there rather than fail.
  if (await isSubmoduleDeclared('mcp-servers')) {
    required.push({ name: 'mcp-servers', marker: relativePath('mcp-servers', 'README.md') });
  }
  const missing: string[] = [];

  for (const submodule of required) {
    if (!(await exists(path.join(repoRoot, submodule.marker)))) {
      missing.push(submodule.name);
    }
  }

  if (missing.length > 0) {
    return {
      label: 'Submodules',
      status: 'FAIL',
      detail: `Missing: ${missing.join(', ')}`,
      remediation: `Run \`git submodule update --init ${missing.join(' ')}\`.`,
    };
  }

  return { label: 'Submodules', status: 'PASS' };
}

async function checkSuperMcpDist(): Promise<CheckResult> {
  const bundlePath = relativePath('super-mcp', 'dist', 'cli.js');
  if (!(await exists(path.join(repoRoot, bundlePath)))) {
    return {
      label: 'Super MCP dist',
      status: 'FAIL',
      detail: `${bundlePath} is missing.`,
      remediation: 'Run `npm run build:super-mcp`.',
    };
  }

  return { label: 'Super MCP dist', status: 'PASS' };
}

async function checkRebelCliDist(): Promise<CheckResult> {
  const bundlePath = relativePath('scripts', 'rebel-cli', 'dist', 'rebel.js');
  if (!(await exists(path.join(repoRoot, bundlePath)))) {
    return {
      label: 'Rebel CLI dist',
      status: 'WARN',
      detail: `${bundlePath} is missing.`,
      remediation: 'Run `node scripts/rebel-cli/build.mjs`.',
    };
  }

  return { label: 'Rebel CLI dist', status: 'PASS' };
}

async function checkEnvLocal(): Promise<CheckResult> {
  if (!(await exists(path.join(repoRoot, '.env.local')))) {
    return {
      label: '.env.local',
      status: 'WARN',
      detail: '.env.local is missing; live agent turns will be unavailable.',
      remediation: 'Create .env.local with the required API keys before live-turn validation.',
    };
  }

  return { label: '.env.local', status: 'PASS' };
}

function isUnixProcessProbeSupported(): boolean {
  return process.platform === 'darwin' || process.platform === 'linux';
}

async function getCommandForPid(pid: number): Promise<string> {
  if (!isUnixProcessProbeSupported()) {
    return '';
  }

  const result = await runCommand('ps', ['-p', String(pid), '-o', 'command=']);
  return result?.stdout.trim() ?? '';
}

function parseLsofPids(output: string): number[] {
  const pids = new Set<number>();
  const lines = output.split(/\r?\n/).slice(1);

  for (const line of lines) {
    const columns = line.trim().split(/\s+/);
    const pid = Number(columns[1]);
    if (Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }

  return [...pids].sort((a, b) => a - b);
}

async function listPortHolders(port: number): Promise<ProcessInfo[] | null> {
  if (!isUnixProcessProbeSupported()) {
    return null;
  }

  const result = await runUnixProbe('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
  if (result.unavailable) {
    return null;
  }

  if (!result.stdout.trim()) {
    return [];
  }

  const pids = parseLsofPids(result.stdout);
  return Promise.all(
    pids.map(async (pid) => ({
      pid,
      command: await getCommandForPid(pid),
    })),
  );
}

function summarizeProcesses(processes: ProcessInfo[]): string {
  return processes.map((processInfo) => `pid ${processInfo.pid} (${processInfo.command || 'command unavailable'})`).join('; ');
}

function commandLooksLikeRebelTest(command: string): boolean {
  return /--rebel-test|\brebel-test\b/i.test(command);
}

async function checkPort(port: number): Promise<CheckResult> {
  const label = `Port ${port}`;
  const holders = await listPortHolders(port);

  if (holders === null) {
    return {
      label,
      status: 'INFO',
      detail: `Port holder probe (lsof) could not run here (non-Unix platform, tool missing, sandbox-blocked, or timed out).`,
      remediation: 'Check port holders manually if a launch later reports a collision.',
    };
  }

  if (holders.length === 0) {
    return { label, status: 'PASS' };
  }

  const rebelTestHolders = holders.filter((holder) => commandLooksLikeRebelTest(holder.command));
  if (rebelTestHolders.length > 0) {
    return {
      label,
      status: 'WARN',
      detail: `Held by orphaned rebel-test process: ${summarizeProcesses(rebelTestHolders)}.`,
      remediation: 'Do not kill user processes; only stop these PIDs if you started that rebel-test launch.',
    };
  }

  return {
    label,
    status: 'WARN',
    detail: `Held by likely user dev server or app: ${summarizeProcesses(holders)}.`,
    remediation: 'Do not kill it; use an isolated test profile/alternate port or skip launch-class validation.',
  };
}

async function listRebelTestProcesses(): Promise<ProcessInfo[] | null> {
  if (!isUnixProcessProbeSupported()) {
    return null;
  }

  const pgrep = await runUnixProbe('pgrep', ['-f', 'rebel-test']);
  if (pgrep.unavailable) {
    return null;
  }

  if (!pgrep.stdout.trim()) {
    return [];
  }

  const currentPid = process.pid;
  const pids = pgrep.stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== currentPid);

  const processes = await Promise.all(
    [...new Set(pids)].map(async (pid) => ({
      pid,
      command: await getCommandForPid(pid),
    })),
  );

  return processes.filter((processInfo) => commandLooksLikeRebelTest(processInfo.command));
}

async function checkRebelTestProcesses(): Promise<CheckResult> {
  const processes = await listRebelTestProcesses();

  if (processes === null) {
    return {
      label: 'rebel-test processes',
      status: 'INFO',
      detail: `Process probe (pgrep) could not run here (non-Unix platform, tool missing, sandbox-blocked, or timed out).`,
      remediation: 'Check for stale rebel-test processes manually before launch-class validation.',
    };
  }

  if (processes.length === 0) {
    return { label: 'rebel-test processes', status: 'PASS' };
  }

  return {
    label: 'rebel-test processes',
    status: 'WARN',
    detail: `Found ${summarizeProcesses(processes)}.`,
    remediation: 'Do not kill user processes; only stop these PIDs if you started that rebel-test launch.',
  };
}

async function checkInstalledApp(): Promise<CheckResult> {
  if (!isUnixProcessProbeSupported()) {
    return {
      label: 'Installed app',
      status: 'INFO',
      detail: `Installed-app process probing is unavailable on ${process.platform}.`,
      remediation: '`--rebel-test` paths still use isolated state and can coexist with the installed app.',
    };
  }

  const pgrep = await runUnixProbe('pgrep', ['-f', 'Mindstone Rebel']);
  if (pgrep.unavailable) {
    return {
      label: 'Installed app',
      status: 'INFO',
      detail: 'Installed-app process probe is unavailable because `pgrep` could not be run.',
      remediation: '`--rebel-test` paths still use isolated state and can coexist with the installed app.',
    };
  }

  if (!pgrep.stdout.trim()) {
    return { label: 'Installed app', status: 'PASS' };
  }

  const pids = pgrep.stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  const processes = await Promise.all(
    [...new Set(pids)].map(async (pid) => ({
      pid,
      command: await getCommandForPid(pid),
    })),
  );
  const matching = processes.filter((processInfo) => /Mindstone Rebel/i.test(processInfo.command));

  if (matching.length === 0) {
    return { label: 'Installed app', status: 'PASS' };
  }

  return {
    label: 'Installed app',
    status: 'INFO',
    detail: `Installed Mindstone Rebel appears to be running: ${summarizeProcesses(matching)}.`,
    remediation: '`--rebel-test` launch paths coexist with it; do not stop the user app.',
  };
}

async function checkMcpDevServerStateFiles(): Promise<CheckResult> {
  const tmpDir = os.tmpdir();
  try {
    const entries = await readdir(tmpDir);
    const staleFiles = entries.filter((entry) => /^rebel-electron-mcp-dev-server-.*\.json$/.test(entry));

    if (staleFiles.length === 0) {
      return { label: 'MCP dev-server state files', status: 'PASS' };
    }

    return {
      label: 'MCP dev-server state files',
      status: 'WARN',
      detail: `Found ${staleFiles.length} state file(s) in ${tmpDir}: ${staleFiles.slice(0, 3).join(', ')}${staleFiles.length > 3 ? ', ...' : ''}.`,
      remediation: 'After confirming no matching test app is running, remove stale rebel-electron-mcp-dev-server-*.json files.',
    };
  } catch (error) {
    return {
      label: 'MCP dev-server state files',
      status: 'WARN',
      detail: error instanceof Error ? error.message : `Unable to list ${tmpDir}.`,
      remediation: 'Check TMPDIR permissions before launch-class validation.',
    };
  }
}

function checkTempDir(): CheckResult {
  return {
    label: 'Temp dir',
    status: 'PASS',
    summaryValue: os.tmpdir(),
  };
}

async function runChecks(): Promise<CheckResult[]> {
  if (mode === 'quick') {
    return Promise.all([
      checkDiskFree(),
      checkNodeOnPath(),
      checkSubmodules(),
      checkSuperMcpDist(),
      checkRebelCliDist(),
      checkEnvLocal(),
    ]);
  }

  const full = [
    checkDiskFree(),
    checkPort(5173),
    checkPort(9222),
    checkRebelTestProcesses(),
    checkInstalledApp(),
    checkMcpDevServerStateFiles(),
    checkNodeOnPath(),
    checkSubmodules(),
    checkSuperMcpDist(),
    checkRebelCliDist(),
    checkEnvLocal(),
    Promise.resolve(checkTempDir()),
  ];

  return Promise.all(full);
}

function statusRank(status: Status): number {
  switch (status) {
    case 'FAIL':
      return 3;
    case 'WARN':
      return 2;
    case 'INFO':
      return 1;
    case 'PASS':
      return 0;
  }
}

function overallStatus(results: CheckResult[]): Status {
  return results.reduce<Status>((worst, result) => (statusRank(result.status) > statusRank(worst) ? result.status : worst), 'PASS');
}

function formatSummary(results: CheckResult[]): string {
  const labels = mode === 'quick' ? quickLabels : fullLabels;
  const summaryBits = labels.map((label) => {
    const result = results.find((candidate) => candidate.label === label);
    const suffix = result?.summaryValue ? `=${result.summaryValue}` : '';
    return `${label}${suffix}`;
  });
  const summaryStatus = overallStatus(results);

  return `${summaryStatus} (${results.length} checks, mode=${mode}): ${summaryBits.join(', ')}`;
}

function formatDetail(result: CheckResult): string {
  const detail = result.detail ? ` — ${ensureSentence(result.detail)}` : '.';
  const remediation = result.remediation ? ` Remediation: ${ensureSentence(result.remediation)}` : '';
  return `${result.status} ${result.label}${detail}${remediation}`;
}

function ensureSentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

async function main(): Promise<void> {
  const results = await runChecks();
  console.log(formatSummary(results));

  for (const result of results) {
    if (result.status !== 'PASS') {
      console.log(formatDetail(result));
    }
  }

  process.exitCode = results.some((result) => result.status === 'FAIL') ? 1 : 0;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`FAIL Preflight crashed — ${message}. Remediation: Re-run from the repo root and report the stack trace.`);
  process.exitCode = 1;
});
