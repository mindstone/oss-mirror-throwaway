import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'rewrite-session-blobs.mjs');
const SCRIPT_URL = pathToFileURL(SCRIPT_PATH).href;

type MigrationSummary = {
  sessionId: string;
  backupPath: string | null;
  beforeBytes: number;
  afterBytes: number;
  eventsModified: number;
  blobsOffloaded: number;
};

type RunMigrationFn = (args: {
  sessionIds: string[];
  dataDir: string;
  dryRun?: boolean;
  thresholdBytes?: number;
  force?: boolean;
  verbose?: boolean;
  promptIfMissing?: boolean;
  hooks?: {
    beforeSessionRename?: (tmpPath: string, filePath: string) => Promise<void> | void;
  };
}) => Promise<{ summaries: MigrationSummary[] }>;

const kb = (n: number) => n * 1024;
const makeText = (bytes: number, ch = 'x') => ch.repeat(bytes);

function buildSession(sessionId: string, blocks: unknown[]) {
  return {
    id: sessionId,
    title: 'fixture',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    eventsByTurn: {
      'turn-1': [
        {
          type: 'tool',
          toolName: 'fixture-tool',
          toolUseId: 'tu-1',
          detail: 'fixture',
          stage: 'end',
          timestamp: 1,
          toolResult: {
            content: blocks,
          },
        },
      ],
    },
  };
}

async function writeSession(dataDir: string, sessionId: string, session: unknown) {
  const sessionsDir = path.join(dataDir, 'sessions');
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(path.join(sessionsDir, `${sessionId}.json`), JSON.stringify(session), 'utf8');
}

async function readSession(dataDir: string, sessionId: string) {
  const raw = await fs.readFile(path.join(dataDir, 'sessions', `${sessionId}.json`), 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function findBackups(dataDir: string, sessionId: string) {
  return fs.readdir(path.join(dataDir, 'sessions')).then((entries) =>
    entries.filter((entry) => entry.startsWith(`${sessionId}.json.backup-`)),
  );
}

function runScript(args: string[]) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

async function getRunMigration(): Promise<RunMigrationFn> {
  const mod = await import(SCRIPT_URL) as { runMigration: RunMigrationFn };
  return mod.runMigration;
}

describe('rewrite-session-blobs.mjs', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rewrite-session-blobs-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('dry-run reports delta without writing files', async () => {
    const sessionId = 'dryrun-session';
    const largeText = makeText(kb(300), 'a');
    await writeSession(tempDir, sessionId, buildSession(sessionId, [{ type: 'text', text: largeText }]));

    const beforeRaw = await fs.readFile(path.join(tempDir, 'sessions', `${sessionId}.json`), 'utf8');
    const runMigration = await getRunMigration();
    const result = await runMigration({
      sessionIds: [sessionId],
      dataDir: tempDir,
      dryRun: true,
      promptIfMissing: false,
    });

    const summary = result.summaries[0];
    expect(summary.eventsModified).toBe(1);
    expect(summary.blobsOffloaded).toBe(1);
    expect(summary.afterBytes).toBeLessThan(summary.beforeBytes);

    const afterRaw = await fs.readFile(path.join(tempDir, 'sessions', `${sessionId}.json`), 'utf8');
    expect(afterRaw).toBe(beforeRaw);
    expect(existsSync(path.join(tempDir, 'contentStore'))).toBe(false);
    expect(await findBackups(tempDir, sessionId)).toEqual([]);
  });

  it('migrates oversized blob to content_ref and writes content bytes to ContentStore', async () => {
    const sessionId = 'migrate-session';
    const largeText = makeText(kb(300), 'b');
    await writeSession(tempDir, sessionId, buildSession(sessionId, [{ type: 'text', text: largeText }]));

    const runMigration = await getRunMigration();
    const result = await runMigration({
      sessionIds: [sessionId],
      dataDir: tempDir,
      promptIfMissing: false,
    });
    const summary = result.summaries[0];
    expect(summary.eventsModified).toBe(1);
    expect(summary.blobsOffloaded).toBe(1);

    const session = await readSession(tempDir, sessionId);
    const event = (session.eventsByTurn as Record<string, unknown[]>)['turn-1'][0] as Record<string, unknown>;
    const block = ((event.toolResult as { content: unknown[] }).content[0]) as Record<string, unknown>;
    expect(block.type).toBe('content_ref');
    const contentRef = block.contentRef as Record<string, unknown>;
    expect(typeof contentRef.contentId).toBe('string');
    expect(contentRef.byteSize).toBe(kb(300));

    const contentPath = path.join(
      tempDir,
      'contentStore',
      sessionId,
      `${String(contentRef.contentId)}.bin`,
    );
    const bytes = await fs.readFile(contentPath);
    expect(bytes.equals(Buffer.from(largeText, 'utf8'))).toBe(true);
  });

  it('is idempotent on re-run', async () => {
    const sessionId = 'idempotent-session';
    await writeSession(
      tempDir,
      sessionId,
      buildSession(sessionId, [{ type: 'text', text: makeText(kb(300), 'c') }]),
    );

    const runMigration = await getRunMigration();
    await runMigration({
      sessionIds: [sessionId],
      dataDir: tempDir,
      promptIfMissing: false,
    });
    const firstSession = await readSession(tempDir, sessionId);

    const second = await runMigration({
      sessionIds: [sessionId],
      dataDir: tempDir,
      promptIfMissing: false,
    });
    const secondSummary = second.summaries[0];
    expect(secondSummary.eventsModified).toBe(0);
    expect(secondSummary.blobsOffloaded).toBe(0);

    const secondSession = await readSession(tempDir, sessionId);
    expect(secondSession).toEqual(firstSession);
  });

  it('respects threshold boundary: 199KB inline, 201KB offloaded', async () => {
    const sessionId = 'threshold-session';
    const session = buildSession(sessionId, [
      { type: 'text', text: makeText(kb(199), 'd') },
      { type: 'text', text: makeText(kb(201), 'e') },
    ]);
    await writeSession(tempDir, sessionId, session);

    const runMigration = await getRunMigration();
    await runMigration({
      sessionIds: [sessionId],
      dataDir: tempDir,
      promptIfMissing: false,
    });

    const after = await readSession(tempDir, sessionId);
    const event = (after.eventsByTurn as Record<string, unknown[]>)['turn-1'][0] as Record<string, unknown>;
    const blocks = (event.toolResult as { content: unknown[] }).content as Array<Record<string, unknown>>;
    expect(blocks[0].type).toBe('text');
    expect(blocks[1].type).toBe('content_ref');
  });

  it('creates backup file with timestamp suffix before write', async () => {
    const sessionId = 'backup-session';
    await writeSession(
      tempDir,
      sessionId,
      buildSession(sessionId, [{ type: 'text', text: makeText(kb(300), 'f') }]),
    );

    const runMigration = await getRunMigration();
    const result = await runMigration({
      sessionIds: [sessionId],
      dataDir: tempDir,
      promptIfMissing: false,
    });

    const backupPath = result.summaries[0].backupPath;
    expect(backupPath).not.toBeNull();
    expect(existsSync(backupPath!)).toBe(true);
    expect(backupPath).toMatch(
      new RegExp(`${sessionId}\\.json\\.backup-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z$`),
    );
  });

  it('crash simulation: tmp write + rename failure keeps original session uncorrupted, then rerun succeeds', async () => {
    const sessionId = 'rename-fail-session';
    const originalText = makeText(kb(300), 'g');
    await writeSession(
      tempDir,
      sessionId,
      buildSession(sessionId, [{ type: 'text', text: originalText }]),
    );

    const runMigration = await getRunMigration();
    let injectedFailure = false;
    await expect(
      runMigration({
        sessionIds: [sessionId],
        dataDir: tempDir,
        promptIfMissing: false,
        hooks: {
          beforeSessionRename: () => {
            injectedFailure = true;
            throw new Error('injected rename failure');
          },
        },
      }),
    ).rejects.toThrow(/injected rename failure/);
    expect(injectedFailure).toBe(true);

    const sessionsDir = path.join(tempDir, 'sessions');
    const entries = await fs.readdir(sessionsDir);
    expect(entries.some((entry) => entry.startsWith(`${sessionId}.json.`) && entry.endsWith('.tmp'))).toBe(true);

    const afterFailedRun = await readSession(tempDir, sessionId);
    const failedEvent = (afterFailedRun.eventsByTurn as Record<string, unknown[]>)['turn-1'][0] as Record<string, unknown>;
    const failedBlock = ((failedEvent.toolResult as { content: unknown[] }).content[0]) as Record<string, unknown>;
    expect(failedBlock.type).toBe('text');

    await runMigration({
      sessionIds: [sessionId],
      dataDir: tempDir,
      promptIfMissing: false,
    });
    const afterRetry = await readSession(tempDir, sessionId);
    const retryEvent = (afterRetry.eventsByTurn as Record<string, unknown[]>)['turn-1'][0] as Record<string, unknown>;
    const retryBlock = ((retryEvent.toolResult as { content: unknown[] }).content[0]) as Record<string, unknown>;
    expect(retryBlock.type).toBe('content_ref');
  });

  it('aborts with clear error when outbox lock is present', async () => {
    const sessionId = 'lock-abort-session';
    await writeSession(
      tempDir,
      sessionId,
      buildSession(sessionId, [{ type: 'text', text: makeText(kb(300), 'h') }]),
    );
    await fs.mkdir(path.join(tempDir, 'outbox'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'outbox', 'lock'), 'locked', 'utf8');

    const result = await runScript([
      '--session-id',
      sessionId,
      '--data-dir',
      tempDir,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Pause the outbox or wait for it to drain. Run with --force only if you know what you\'re doing.');
  });

  it('--force overrides outbox lock preflight guard', async () => {
    const sessionId = 'lock-force-session';
    await writeSession(
      tempDir,
      sessionId,
      buildSession(sessionId, [{ type: 'text', text: makeText(kb(300), 'i') }]),
    );
    await fs.mkdir(path.join(tempDir, 'outbox'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'outbox', 'lock'), 'locked', 'utf8');

    const result = await runScript([
      '--session-id',
      sessionId,
      '--data-dir',
      tempDir,
      '--force',
    ]);
    expect(result.exitCode).toBe(0);

    const after = await readSession(tempDir, sessionId);
    const event = (after.eventsByTurn as Record<string, unknown[]>)['turn-1'][0] as Record<string, unknown>;
    const block = ((event.toolResult as { content: unknown[] }).content[0]) as Record<string, unknown>;
    expect(block.type).toBe('content_ref');
  });
});
