import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseArgs,
  readPidFilesInRange,
  runSweep,
  type KillOutcome,
  type PidFileRecord,
  type SweepDeps,
  type SweepOptions,
} from "../sweep-supermcp";
import type { ClassifierResult } from "../../src/core/services/superMcpOwnershipClassifier";

const FIXED_DATE = new Date("2026-04-30T12:34:56.000Z");

function result(
  decision: ClassifierResult["decision"],
  reason: ClassifierResult["reason"],
  pid: number,
  ownerSnapshot: ClassifierResult["ownerSnapshot"] = null,
): ClassifierResult {
  return {
    decision,
    reason,
    identity: { pid, observedStartTimeMs: 100_000 + pid },
    ownerSnapshot,
  };
}

function options(overrides: Partial<SweepOptions> = {}): SweepOptions {
  return {
    startPort: 3000,
    endPort: 3300,
    kill: false,
    includeUnknown: false,
    json: false,
    help: false,
    ...overrides,
  };
}

function makeDeps(
  overrides: {
    pidFiles?: PidFileRecord[];
    listeningPids?: number[];
    results?: Map<number, ClassifierResult>;
    killResult?: (
      pid: number,
    ) => Promise<{ killed: boolean; reason: KillOutcome["reason"] }>;
  } = {},
): {
  deps: SweepDeps;
  logs: string[];
  errors: string[];
  killedPids: number[];
  deletedPidFiles: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  const killedPids: number[] = [];
  const deletedPidFiles: string[] = [];
  const results = overrides.results ?? fixtureResults();

  const deps: SweepDeps = {
    discoverPids: vi.fn(
      async () => overrides.listeningPids ?? [12345, 22340, 22341],
    ),
    readPidFiles: vi.fn(async () => overrides.pidFiles ?? fixturePidFiles()),
    classifyByPid: vi.fn(async (pid) => {
      const found = results.get(pid);
      if (!found) {
        throw new Error(`Missing fixture result for pid ${pid}`);
      }
      return found;
    }),
    killWrapper: vi.fn(async (pid) => {
      killedPids.push(pid);
      if (overrides.killResult) {
        return overrides.killResult(pid);
      }
      return { killed: true, reason: "killed" as const };
    }),
    deletePidFile: vi.fn(async (pidFilePath) => {
      deletedPidFiles.push(pidFilePath);
    }),
    outputWriter: {
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    },
    now: () => FIXED_DATE,
  };

  return { deps, logs, errors, killedPids, deletedPidFiles };
}

function fixturePidFiles(): PidFileRecord[] {
  return [
    {
      pid: 12345,
      port: 3100,
      pidFilePath: "/tmp/userData/mcp/super-mcp-3100.pid",
    },
    {
      pid: 22340,
      port: 3105,
      pidFilePath: "/tmp/userData/mcp/super-mcp-3105.pid",
    },
    {
      pid: 22341,
      port: 3110,
      pidFilePath: "/tmp/userData/mcp/super-mcp-3110.pid",
    },
  ];
}

function fixtureResults(): Map<number, ClassifierResult> {
  return new Map([
    [
      12345,
      result("protected", "owner-alive-via-cmdline-tag", 12345, {
        ownerKind: "eval-orchestrator",
        ownerPid: 23456,
      }),
    ],
    [
      22340,
      result("killable", "owner-dead-via-cmdline-tag", 22340, {
        ownerKind: "desktop",
        ownerPid: 98765,
      }),
    ],
    [22341, result("unknown", "untagged-no-mtime-evidence", 22341)],
  ]);
}

describe("parseArgs", () => {
  it("parses kill, range, json, include-unknown, and help flags", () => {
    expect(
      parseArgs([
        "--kill",
        "--range",
        "3000-3300",
        "--json",
        "--include-unknown",
        "--help",
      ]),
    ).toEqual({
      startPort: 3000,
      endPort: 3300,
      kill: true,
      includeUnknown: true,
      json: true,
      help: true,
    });
  });

  it("accepts -h as help", () => {
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("rejects invalid ranges", () => {
    expect(() => parseArgs(["--range", "3300-3000"])).toThrow(
      "--range start must be less than or equal to end",
    );
    expect(() => parseArgs(["--range", "nope"])).toThrow(
      "--range must be formatted",
    );
    expect(() => parseArgs(["--range"])).toThrow("--range requires a value");
  });
});

describe("runSweep output", () => {
  it("prints a decision table for protected, killable, and unknown fixture decisions", async () => {
    const { deps, logs } = makeDeps();

    await runSweep(options(), deps);

    const output = logs.join("\n");
    expect(output).toContain("Found 3 super-mcp processes in 3000-3300:");
    expect(output).toContain(
      "PROTECTED  pid=12345  port=3100  owner=eval-orchestrator (pid 23456)",
    );
    expect(output).toContain(
      "KILLABLE   pid=22340  port=3105  owner=desktop (pid 98765)",
    );
    expect(output).toContain("UNKNOWN    pid=22341  port=3110  owner=untagged");
    expect(output).toContain("reason=untagged-no-mtime-evidence");
    expect(output).toContain("Summary: 1 protected, 1 killable, 1 unknown.");
    expect(output).toContain("Run with --kill to kill the 1 killable process.");
  });

  it("prints machine-readable JSON for the same fixture decisions", async () => {
    const { deps, logs } = makeDeps();

    await runSweep(options({ json: true }), deps);

    const parsed = JSON.parse(logs.join("\n")) as {
      range: [number, number];
      scannedAt: string;
      decisions: Array<{
        pid: number;
        port: number;
        decision: string;
        reason: string;
        ownerKind?: string;
        ownerPid?: number;
      }>;
      summary: { protected: number; killable: number; unknown: number };
      killed: unknown[];
    };
    expect(parsed.range).toEqual([3000, 3300]);
    expect(parsed.scannedAt).toBe("2026-04-30T12:34:56.000Z");
    expect(parsed.decisions).toEqual([
      {
        pid: 12345,
        port: 3100,
        decision: "protected",
        reason: "owner-alive-via-cmdline-tag",
        ownerKind: "eval-orchestrator",
        ownerPid: 23456,
      },
      {
        pid: 22340,
        port: 3105,
        decision: "killable",
        reason: "owner-dead-via-cmdline-tag",
        ownerKind: "desktop",
        ownerPid: 98765,
      },
      {
        pid: 22341,
        port: 3110,
        decision: "unknown",
        reason: "untagged-no-mtime-evidence",
      },
    ]);
    expect(parsed.summary).toEqual({ protected: 1, killable: 1, unknown: 1 });
    expect(parsed.killed).toEqual([]);
  });

  it("renders owner-alive-heartbeat-stale with operator guidance text", async () => {
    const staleHeartbeatResult = result(
      "unknown",
      "owner-alive-heartbeat-stale",
      33333,
      {
        ownerKind: "eval-orchestrator",
        ownerPid: 44444,
      },
    );
    const { deps, logs } = makeDeps({
      pidFiles: [
        {
          pid: 33333,
          port: 3120,
          pidFilePath: "/tmp/userData/mcp/super-mcp-3120.pid",
        },
      ],
      listeningPids: [],
      results: new Map([[33333, staleHeartbeatResult]]),
    });

    await runSweep(options(), deps);

    const output = logs.join("\n");
    expect(output).toContain("reason=owner-alive-heartbeat-stale");
    expect(output).toContain(
      "owner alive but registry heartbeat stale; check if orchestrator is paused or registry I/O is degraded",
    );
  });

  it("renders identity-changed-during-classification with PID-reuse guidance text", async () => {
    const identityChangedResult = result(
      "unknown",
      "identity-changed-during-classification",
      33334,
    );
    const { deps, logs } = makeDeps({
      pidFiles: [
        {
          pid: 33334,
          port: 3121,
          pidFilePath: "/tmp/userData/mcp/super-mcp-3121.pid",
        },
      ],
      listeningPids: [],
      results: new Map([[33334, identityChangedResult]]),
    });

    await runSweep(options(), deps);

    const output = logs.join("\n");
    expect(output).toContain("reason=identity-changed-during-classification");
    expect(output).toContain(
      "process identity changed during classification (PID-reuse race detected); not killable",
    );
  });

  it("prints a friendly empty message and exits without kills when nothing is discovered", async () => {
    const { deps, logs, killedPids } = makeDeps({
      pidFiles: [],
      listeningPids: [],
      results: new Map(),
    });

    const sweep = await runSweep(options(), deps);

    expect(sweep.decisions).toEqual([]);
    expect(killedPids).toEqual([]);
    expect(logs.join("\n")).toContain(
      "No super-mcp processes found in 3000-3300.",
    );
    expect(logs.join("\n")).toContain(
      "Summary: 0 protected, 0 killable, 0 unknown.",
    );
  });
});

describe("runSweep kill mode", () => {
  it("kills only killable decisions by default", async () => {
    const { deps, killedPids, deletedPidFiles } = makeDeps();

    await runSweep(options({ kill: true }), deps);

    expect(killedPids).toEqual([22340]);
    expect(deletedPidFiles).toEqual(["/tmp/userData/mcp/super-mcp-3105.pid"]);
  });

  it("--kill mode deletes PID file for pid-dead decisions without invoking kill wrapper", async () => {
    const pidDeadResult: ClassifierResult = {
      decision: "killable",
      reason: "pid-dead",
      identity: { pid: 33333, observedStartTimeMs: null },
      ownerSnapshot: null,
    };
    const pidFilePath = "/tmp/userData/mcp/super-mcp-3120.pid";
    const { deps, killedPids, deletedPidFiles } = makeDeps({
      pidFiles: [{ pid: 33333, port: 3120, pidFilePath }],
      listeningPids: [],
      results: new Map([[33333, pidDeadResult]]),
    });

    const sweep = await runSweep(options({ kill: true }), deps);

    expect(killedPids).toEqual([]);
    expect(deps.killWrapper).not.toHaveBeenCalled();
    expect(deletedPidFiles).toEqual([pidFilePath]);
    expect(sweep.killed).toEqual([
      {
        pid: 33333,
        port: 3120,
        status: "killed",
        reason: "pid-gone",
      },
    ]);
  });

  it("kills unknown decisions too when include-unknown is set", async () => {
    const { deps, killedPids, deletedPidFiles } = makeDeps();

    await runSweep(options({ kill: true, includeUnknown: true }), deps);

    expect(killedPids).toEqual([22340, 22341]);
    expect(deletedPidFiles).toEqual([
      "/tmp/userData/mcp/super-mcp-3105.pid",
      "/tmp/userData/mcp/super-mcp-3110.pid",
    ]);
  });

  it("counts pre-kill identity mismatches as aborted", async () => {
    const { deps, logs, killedPids, deletedPidFiles } = makeDeps({
      killResult: async () => ({ killed: false, reason: "no-longer-matches" }),
    });

    const sweep = await runSweep(options({ kill: true }), deps);

    expect(killedPids).toEqual([22340]);
    expect(deletedPidFiles).toEqual([]);
    expect(sweep.killed).toEqual([
      {
        pid: 22340,
        port: 3105,
        status: "aborted",
        reason: "no-longer-matches",
      },
    ]);
    expect(logs.join("\n")).toContain(
      "ABORTED  pid=22340  port=3105  reason=no-longer-matches",
    );
    expect(logs.join("\n")).toContain("Killed 0 / 1.");
  });
});

describe("readPidFilesInRange", () => {
  it("invalid PID file content is deleted during scan", async () => {
    const userDataPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "sweep-supermcp-"),
    );
    const mcpDir = path.join(userDataPath, "mcp");
    await fs.mkdir(mcpDir);

    const invalidPidFilePath = path.join(mcpDir, "super-mcp-3100.pid");
    const validPidFilePath = path.join(mcpDir, "super-mcp-3101.pid");
    await fs.writeFile(invalidPidFilePath, "not-a-pid", "utf8");
    await fs.writeFile(validPidFilePath, "4321", "utf8");

    try {
      const records = await readPidFilesInRange(3100, 3101, userDataPath);

      expect(records).toEqual([
        { pid: 4321, port: 3101, pidFilePath: validPidFilePath },
      ]);
      await expect(fs.access(invalidPidFilePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.unlink(validPidFilePath).catch(() => undefined);
      await fs.unlink(invalidPidFilePath).catch(() => undefined);
      await fs.rmdir(mcpDir).catch(() => undefined);
      await fs.rmdir(userDataPath).catch(() => undefined);
    }
  });
});
