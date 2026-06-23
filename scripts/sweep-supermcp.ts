#!/usr/bin/env tsx

process.env.REBEL_SWEEP_CLI = "1";

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ClassifierContext,
  ClassifierResult,
  Decision,
} from "../src/core/services/superMcpOwnershipClassifier";

const DEFAULT_START_PORT = 3000;
const DEFAULT_END_PORT = 3300;
const REASON_DESCRIPTIONS: Partial<Record<ClassifierResult["reason"], string>> = {
  "identity-changed-during-classification":
    "process identity changed during classification (PID-reuse race detected); not killable",
  "owner-alive-heartbeat-stale":
    "owner alive but registry heartbeat stale; check if orchestrator is paused or registry I/O is degraded",
};

export interface SweepOptions {
  startPort: number;
  endPort: number;
  kill: boolean;
  includeUnknown: boolean;
  json: boolean;
  help: boolean;
}

export interface PidFileRecord {
  pid: number;
  port: number;
  pidFilePath: string;
}

export interface SweepDecision {
  pid: number;
  port: number | null;
  pidFilePath?: string;
  result: ClassifierResult;
}

export interface KillOutcome {
  pid: number;
  port: number | null;
  status: "killed" | "aborted";
  reason: "no-longer-matches" | "killed" | "pid-gone" | "identity-unverifiable";
}

export interface SweepSummary {
  protected: number;
  killable: number;
  unknown: number;
}

export interface SweepRunResult {
  range: [number, number];
  scannedAt: string;
  decisions: SweepDecision[];
  summary: SweepSummary;
  killed: KillOutcome[];
}

export interface OutputWriter {
  log: (message: string) => void;
  error: (message: string) => void;
}

export interface SweepDeps {
  discoverPids: (startPort: number, endPort: number) => Promise<number[]>;
  classifyByPid: (
    pid: number,
    ctx?: ClassifierContext,
  ) => Promise<ClassifierResult>;
  killWrapper: (
    pid: number,
    observedStartTimeMs: number | null,
  ) => Promise<{ killed: boolean; reason: KillOutcome["reason"] }>;
  outputWriter: OutputWriter;
  readPidFiles?: (
    startPort: number,
    endPort: number,
  ) => Promise<PidFileRecord[]>;
  deletePidFile?: (pidFilePath: string) => Promise<void>;
  now?: () => Date;
}

interface ProcessObservation {
  pid: number;
  port: number | null;
  pidFilePath?: string;
}

export class SweepCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SweepCliError";
  }
}

export function parseArgs(argv: string[]): SweepOptions {
  const options: SweepOptions = {
    startPort: DEFAULT_START_PORT,
    endPort: DEFAULT_END_PORT,
    kill: false,
    includeUnknown: false,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--kill":
        options.kill = true;
        break;
      case "--include-unknown":
        options.includeUnknown = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--range": {
        const value = argv[i + 1];
        if (!value) {
          throw new SweepCliError("--range requires a value like 3000-3300");
        }
        const range = parsePortRange(value);
        options.startPort = range[0];
        options.endPort = range[1];
        i += 1;
        break;
      }
      default:
        throw new SweepCliError(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export function usage(): string {
  return [
    "Usage:",
    "  npm run sweep:supermcp",
    "  npm run sweep:supermcp -- --kill",
    "  npm run sweep:supermcp -- --kill --include-unknown",
    "  npm run sweep:supermcp -- --range 3000-3300",
    "  npm run sweep:supermcp -- --json",
    "  npm run sweep:supermcp -- --help",
    "",
    "Options:",
    "  --kill              Kill processes classified as killable",
    "  --include-unknown   With --kill, also attempt unknown decisions (operator override)",
    "  --range <a-b>       Port range to scan (default: 3000-3300)",
    "  --json              Print machine-readable JSON",
    "  --help, -h          Show this help text",
  ].join("\n");
}

export async function runSweep(
  options: SweepOptions,
  deps: SweepDeps,
): Promise<SweepRunResult> {
  const scannedAt = (deps.now?.() ?? new Date()).toISOString();
  const pidFiles = await (deps.readPidFiles?.(
    options.startPort,
    options.endPort,
  ) ?? Promise.resolve([]));
  const listeningPids = await deps.discoverPids(
    options.startPort,
    options.endPort,
  );
  const observations = mergeProcessObservations(pidFiles, listeningPids);
  const decisions: SweepDecision[] = [];

  for (const observation of observations) {
    const ctx = observation.pidFilePath
      ? { pidFilePath: observation.pidFilePath }
      : undefined;
    const result = await deps.classifyByPid(observation.pid, ctx);
    decisions.push({
      pid: observation.pid,
      port: observation.port,
      pidFilePath: observation.pidFilePath,
      result,
    });
  }

  decisions.sort(compareDecisions);

  const summary = summarize(decisions);
  const killed = options.kill
    ? await killSelectedProcesses(options, deps, decisions)
    : [];

  const result: SweepRunResult = {
    range: [options.startPort, options.endPort],
    scannedAt,
    decisions,
    summary,
    killed,
  };

  writeOutput(options, deps.outputWriter, result);
  return result;
}

async function killSelectedProcesses(
  options: SweepOptions,
  deps: SweepDeps,
  decisions: SweepDecision[],
): Promise<KillOutcome[]> {
  const targets = decisions.filter((decision) => {
    if (decision.result.decision === "killable") return true;
    return options.includeUnknown && decision.result.decision === "unknown";
  });
  const outcomes: KillOutcome[] = [];

  for (const target of targets) {
    if (target.result.reason === "pid-dead") {
      if (target.pidFilePath) {
        await deps.deletePidFile?.(target.pidFilePath);
      }
      outcomes.push({
        pid: target.pid,
        port: target.port,
        status: "killed",
        reason: "pid-gone",
      });
      continue;
    }

    const kill = await deps.killWrapper(
      target.pid,
      target.result.identity.observedStartTimeMs,
    );
    const outcome: KillOutcome = {
      pid: target.pid,
      port: target.port,
      status: kill.killed ? "killed" : "aborted",
      reason: kill.reason,
    };
    outcomes.push(outcome);

    if (kill.killed && target.pidFilePath) {
      await deps.deletePidFile?.(target.pidFilePath);
    }
  }

  return outcomes;
}

function writeOutput(
  options: SweepOptions,
  writer: OutputWriter,
  result: SweepRunResult,
): void {
  if (options.json) {
    writer.log(JSON.stringify(toJsonOutput(result), null, 2));
    return;
  }

  const lines: string[] = [];
  if (result.decisions.length === 0) {
    lines.push(
      `No super-mcp processes found in ${result.range[0]}-${result.range[1]}.`,
    );
  } else {
    lines.push(
      `Found ${result.decisions.length} super-mcp processes in ${result.range[0]}-${result.range[1]}:`,
    );
    for (const decision of result.decisions) {
      lines.push(formatDecisionLine(decision));
    }
  }

  lines.push("");
  lines.push(`Summary: ${formatSummary(result.summary)}.`);

  if (options.kill) {
    const targetCount = result.killed.length;
    if (targetCount > 0) {
      const label = options.includeUnknown ? "killable/unknown" : "killable";
      lines.push(
        `Killing ${targetCount} ${label} ${pluralize("process", targetCount)}...`,
      );
      for (const kill of result.killed) {
        lines.push(formatKillLine(kill));
      }
      const killedCount = result.killed.filter(
        (outcome) => outcome.status === "killed",
      ).length;
      lines.push(`Killed ${killedCount} / ${targetCount}.`);
    } else {
      lines.push("No matching processes to kill.");
    }
  } else if (result.summary.killable > 0) {
    lines.push(
      `Run with --kill to kill the ${result.summary.killable} killable ${pluralize("process", result.summary.killable)}.`,
    );
  }

  writer.log(lines.join("\n"));
}

function toJsonOutput(result: SweepRunResult): {
  range: [number, number];
  scannedAt: string;
  decisions: Array<{
    pid: number;
    port: number | null;
    decision: Decision;
    reason: ClassifierResult["reason"];
    ownerKind?: string;
    ownerPid?: number;
  }>;
  summary: SweepSummary;
  killed: KillOutcome[];
} {
  return {
    range: result.range,
    scannedAt: result.scannedAt,
    decisions: result.decisions.map((decision) => ({
      pid: decision.pid,
      port: decision.port,
      decision: decision.result.decision,
      reason: decision.result.reason,
      ownerKind: decision.result.ownerSnapshot?.ownerKind,
      ownerPid: decision.result.ownerSnapshot?.ownerPid,
    })),
    summary: result.summary,
    killed: result.killed,
  };
}

function formatDecisionLine(decision: SweepDecision): string {
  const status = decision.result.decision.toUpperCase().padEnd(9, " ");
  const port = formatPort(decision.port);
  const owner = formatOwner(decision.result.ownerSnapshot);
  const reasonDescription = REASON_DESCRIPTIONS[decision.result.reason];
  const formattedReason = reasonDescription
    ? `${decision.result.reason} (${reasonDescription})`
    : decision.result.reason;
  return `  ${status}  pid=${decision.pid}  port=${port}  owner=${owner}  reason=${formattedReason}`;
}

function formatKillLine(kill: KillOutcome): string {
  const status = kill.status.toUpperCase().padEnd(7, " ");
  const parts = [
    `  ${status}`,
    `pid=${kill.pid}`,
    `port=${formatPort(kill.port)}`,
  ];
  if (kill.status === "aborted") {
    parts.push(`reason=${kill.reason}`);
  }
  return parts.join("  ");
}

function formatOwner(ownerSnapshot: ClassifierResult["ownerSnapshot"]): string {
  if (!ownerSnapshot) {
    return "untagged";
  }
  if (ownerSnapshot.ownerKind && ownerSnapshot.ownerPid !== undefined) {
    return `${ownerSnapshot.ownerKind} (pid ${ownerSnapshot.ownerPid})`;
  }
  if (ownerSnapshot.ownerKind) {
    return ownerSnapshot.ownerKind;
  }
  if (ownerSnapshot.ownerPid !== undefined) {
    return `tagged-owner (pid ${ownerSnapshot.ownerPid})`;
  }
  return "untagged";
}

function formatSummary(summary: SweepSummary): string {
  return `${summary.protected} protected, ${summary.killable} killable, ${summary.unknown} unknown`;
}

function formatPort(port: number | null): string {
  return port === null ? "unknown" : String(port);
}

function pluralize(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}es`;
}

function summarize(decisions: SweepDecision[]): SweepSummary {
  const summary: SweepSummary = { protected: 0, killable: 0, unknown: 0 };
  for (const decision of decisions) {
    summary[decision.result.decision] += 1;
  }
  return summary;
}

function mergeProcessObservations(
  pidFiles: PidFileRecord[],
  listeningPids: number[],
): ProcessObservation[] {
  const byPid = new Map<number, ProcessObservation>();

  for (const pidFile of pidFiles) {
    if (!byPid.has(pidFile.pid)) {
      byPid.set(pidFile.pid, {
        pid: pidFile.pid,
        port: pidFile.port,
        pidFilePath: pidFile.pidFilePath,
      });
    }
  }

  for (const pid of listeningPids) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!byPid.has(pid)) {
      byPid.set(pid, { pid, port: null });
    }
  }

  return [...byPid.values()];
}

function compareDecisions(a: SweepDecision, b: SweepDecision): number {
  const portA = a.port ?? Number.MAX_SAFE_INTEGER;
  const portB = b.port ?? Number.MAX_SAFE_INTEGER;
  if (portA !== portB) return portA - portB;
  return a.pid - b.pid;
}

function parsePortRange(value: string): [number, number] {
  const match = value.match(/^(\d+)-(\d+)$/);
  if (!match) {
    throw new SweepCliError(
      "--range must be formatted as <start>-<end>, for example 3000-3300",
    );
  }

  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2], 10);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start <= 0 ||
    end <= 0
  ) {
    throw new SweepCliError("--range ports must be positive integers");
  }
  if (start > end) {
    throw new SweepCliError("--range start must be less than or equal to end");
  }
  return [start, end];
}

export async function readPidFilesInRange(
  startPort: number,
  endPort: number,
  userDataPath: string,
  deletePidFile: (pidFilePath: string) => Promise<void> = deletePidFilePath,
): Promise<PidFileRecord[]> {
  const mcpDir = path.join(userDataPath, "mcp");
  const entries = await fs.readdir(mcpDir).catch(() => [] as string[]);
  const records: PidFileRecord[] = [];

  for (const entry of entries) {
    const match = entry.match(/^super-mcp-(\d+)\.pid$/);
    if (!match) continue;
    const port = Number.parseInt(match[1], 10);
    if (port < startPort || port > endPort) continue;

    const pidFilePath = path.join(mcpDir, entry);
    const raw = await fs.readFile(pidFilePath, "utf8").catch(() => null);
    if (raw === null) continue;
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      await deletePidFile(pidFilePath);
      continue;
    }
    records.push({ pid, port, pidFilePath });
  }

  return records;
}

async function deletePidFilePath(pidFilePath: string): Promise<void> {
  try {
    await fs.unlink(pidFilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function getDefaultUserDataPath(): string {
  if (process.env.REBEL_USER_DATA && process.env.REBEL_USER_DATA.trim()) {
    return process.env.REBEL_USER_DATA.trim();
  }

  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "mindstone-rebel",
    );
  }

  if (process.platform === "win32") {
    const appDataBase =
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appDataBase, "mindstone-rebel");
  }

  const xdgConfig =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfig, "mindstone-rebel");
}

async function createRealDeps(): Promise<SweepDeps> {
  process.env.REBEL_USER_DATA = getDefaultUserDataPath();

  const [managerModule, classifierModule, dataPathsModule] = await Promise.all([
    import("../src/core/services/superMcpHttpManager"),
    import("../src/core/services/superMcpOwnershipClassifier"),
    import("../src/core/utils/dataPaths"),
  ]);

  const userDataPath = dataPathsModule.getDataPath();

  return {
    discoverPids: managerModule.discoverListeningPids,
    classifyByPid: classifierModule.classifyByPid,
    killWrapper: (pid, observedStartTimeMs) =>
      classifierModule.killProcessTreeIfStillIdentity(
        pid,
        observedStartTimeMs,
        managerModule.killProcessTree,
      ),
    readPidFiles: (startPort, endPort) =>
      readPidFilesInRange(startPort, endPort, userDataPath),
    deletePidFile: deletePidFilePath,
    outputWriter: {
      log: (message) => console.log(message),
      error: (message) => console.error(message),
    },
  };
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  let options: SweepOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    console.error("");
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  const deps = await createRealDeps();
  await runSweep(options, deps);
}

const invokedAsScript = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (invokedAsScript) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`sweep-supermcp failed: ${message}`);
    process.exitCode = 1;
  });
}
