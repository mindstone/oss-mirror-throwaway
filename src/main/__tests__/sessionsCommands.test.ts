import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, AgentSessionSummary, AppSettings } from '@shared/types';
import { initCliRuntime, runCli } from '../cli';

describe('sessions CLI commands', () => {
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let tempDir: string;

  beforeEach(async () => {
    stdoutWrites = [];
    stderrWrites = [];
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sessions-cli-'));
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('sessions list prints rows', async () => {
    const store = {
      listSessions: vi.fn((): AgentSessionSummary[] => [
        makeSummary('session-a', 'Alpha', 2),
        makeSummary('session-b', 'Beta', 1),
      ]),
    };
    initCliRuntime(makeRuntime(store));

    const exitCode = await runCli(['sessions', 'list', '--limit', '10']);

    expect(exitCode).toBe(0);
    const output = stdoutWrites.join('');
    expect(output).toContain('id\tupdatedAt\tmessageCount\ttitle');
    expect(output).toContain('session-a');
    expect(output).toContain('Alpha');
  });

  it('sessions show prints a transcript', async () => {
    const store = {
      getSession: vi.fn(async () => makeSession('session-show', [
        { role: 'user', text: 'Hello' },
        { role: 'assistant', text: 'Hi there' },
      ])),
    };
    initCliRuntime(makeRuntime(store));

    const exitCode = await runCli(['sessions', 'show', 'session-show']);

    expect(exitCode).toBe(0);
    const output = stdoutWrites.join('');
    expect(output).toContain('Session: session-show');
    expect(output).toContain('USER: Hello');
    expect(output).toContain('ASSISTANT: Hi there');
  });

  it('sessions tail prints new messages when the session file changes', async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const sessionPath = path.join(tempDir, 'tail.json');
    await fs.writeFile(sessionPath, 'initial');
    let session = makeSession('session-tail', [
      { role: 'user', text: 'Before tail' },
    ]);
    const store = {
      getSession: vi.fn(async () => session),
      getSessionFilePath: vi.fn(() => sessionPath),
    };
    initCliRuntime(makeRuntime(store, abortController.signal));

    const tailPromise = runCli(['sessions', 'tail', 'session-tail', '--interval-ms', '10']);
    await vi.advanceTimersByTimeAsync(0);

    session = makeSession('session-tail', [
      { role: 'user', text: 'Before tail' },
      { role: 'assistant', text: 'New tail output' },
    ]);
    await fs.writeFile(sessionPath, 'changed');
    await vi.advanceTimersByTimeAsync(10);

    abortController.abort();
    await vi.advanceTimersByTimeAsync(10);

    await expect(tailPromise).resolves.toBe(0);
    expect(stdoutWrites.join('')).toContain('ASSISTANT: New tail output');
    expect(stderrWrites.join('')).toBe('');
  });
});

function makeRuntime(store: unknown, tailAbortSignal?: AbortSignal): Parameters<typeof initCliRuntime>[0] {
  return {
    runHeadlessTurn: vi.fn(),
    getSettings: () => ({ coreDirectory: '/tmp/workspace', claude: { apiKey: 'test' } }) as AppSettings,
    appVersion: 'test',
    getSessionStore: () => store as never,
    ...(tailAbortSignal ? { tailAbortSignal } : {}),
  };
}

function makeSummary(id: string, title: string, messageCount: number): AgentSessionSummary {
  return {
    id,
    title,
    createdAt: 1_000,
    updatedAt: 2_000 + messageCount,
    resolvedAt: 2_000 + messageCount,
    doneAt: null,
    starredAt: null,
    deletedAt: null,
    origin: 'manual',
    isCorrupted: false,
    preview: `${title} preview`,
    messageCount,
    hasDraft: false,
    draftPreview: null,
    draftUpdatedAt: null,
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: messageCount },
    activeTurnId: null,
    isBusy: false,
    lastError: null,
  };
}

function makeSession(
  id: string,
  messages: Array<{ role: AgentSession['messages'][number]['role']; text: string }>,
): AgentSession {
  return {
    id,
    title: 'Tail session',
    createdAt: 1_000,
    updatedAt: 2_000 + messages.length,
    messages: messages.map((message, index) => ({
      id: `message-${index}`,
      turnId: `turn-${index}`,
      role: message.role,
      text: message.text,
      createdAt: 1_000 + index,
    })),
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
  };
}
