import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { initCliRuntime, parseCliFlagsBeforeRuntime, runCli } from '../cli';
import type { AppSettings, AgentEvent } from '@shared/types';
import {
  CliSessionContentionError,
  CliSessionModifiedExternallyError,
  CliSessionPersistDroppedError,
} from '@core/services/turnPipeline/persistSessionFromCli';

describe('Headless CLI', () => {
  // Capture stdout/stderr for assertions
  let stdoutWrites: string[];
  let stderrWrites: string[];

  beforeEach(() => {
    stdoutWrites = [];
    stderrWrites = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns non-zero exit code when coreDirectory or API key are missing (smoke-test)', async () => {
    const settings = {
      coreDirectory: null,
      claude: { apiKey: null }
    } as AppSettings;

    const runHeadlessTurn = vi.fn(async () => {
      throw new Error('runHeadlessTurn should not be called when configuration is invalid');
    });

    initCliRuntime({
      runHeadlessTurn,
      getSettings: () => settings,
      appVersion: 'test'
    });

    const exitCode = await runCli(['smoke-test']);

    expect(exitCode).toBe(1);
    expect(runHeadlessTurn).not.toHaveBeenCalled();
  });

  it('invokes runHeadlessTurn and returns 0 for a successful single run command', async () => {
    const settings = {
      coreDirectory: '/tmp/workspace',
      claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
    } as AppSettings;

    const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
      onEvent({
        // Minimal AgentEvent shape for the CLI to treat this as a successful turn
        type: 'result',
        text: 'ok',
        timestamp: Date.now()
      } as any);
    });

    initCliRuntime({
      runHeadlessTurn: runHeadlessTurn as any,
      getSettings: () => settings,
      appVersion: 'test'
    });

    const exitCode = await runCli(['run', '--prompt', 'Hello']);

    expect(exitCode).toBe(0);
    expect(runHeadlessTurn).toHaveBeenCalledTimes(1);
  });

  describe('CLI session persistence contention', () => {
    const validSettings = {
      coreDirectory: '/tmp/workspace',
      claude: { apiKey: 'test-key' },
      models: { apiKey: 'test-key' },
    } as AppSettings;

    const contentionError = () => new CliSessionContentionError({
      kind: 'session_persist_contention',
      sessionId: 'session-contended',
      lockPath: 'index.lock',
      existingPid: 1234,
      ageMs: 5010,
    });

    it('maps run-command contention to exit 3 with retryable human-readable stderr', async () => {
      const runHeadlessTurn = vi.fn(async () => {
        throw contentionError();
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => validSettings,
        appVersion: 'test',
      });

      const exitCode = await runCli(['run', '--prompt', 'Hello']);

      expect(exitCode).toBe(3);
      const fullStderr = stderrWrites.join('');
      expect(fullStderr).toContain('another process is writing this session store');
      expect(fullStderr).toContain('retry after it finishes');
      expect(fullStderr).toContain('session-contended');
      expect(fullStderr).toContain('index.lock');
    });

    it('emits a structured JSON contention event for run --json', async () => {
      const runHeadlessTurn = vi.fn(async () => {
        throw contentionError();
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => validSettings,
        appVersion: 'test',
      });

      const exitCode = await runCli(['run', '--prompt', 'Hello', '--json']);

      expect(exitCode).toBe(3);
      const lines = stdoutWrites.join('').trim().split('\n');
      const event = JSON.parse(lines[lines.length - 1]);
      expect(event.type).toBe('session_persist_contention');
      expect(event.event).toEqual({
        kind: 'session_persist_contention',
        sessionId: 'session-contended',
        lockPath: 'index.lock',
        existingPid: 1234,
        ageMs: 5010,
      });
    });

    it('maps chat reset contention to exit 3', async () => {
      mockReadlineQuestions([':reset']);
      const runHeadlessTurn = vi.fn(async () => {
        throw contentionError();
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => validSettings,
        appVersion: 'test',
      });

      const exitCode = await runCli(['chat', '--session', 'session-contended']);

      expect(exitCode).toBe(3);
      expect(stderrWrites.join('')).toContain('another process is writing this session store');
    });

    it('maps chat prompt contention to exit 3', async () => {
      mockReadlineQuestions(['hello']);
      const runHeadlessTurn = vi.fn(async () => {
        throw contentionError();
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => validSettings,
        appVersion: 'test',
      });

      const exitCode = await runCli(['chat', '--session', 'session-contended']);

      expect(exitCode).toBe(3);
      expect(stderrWrites.join('')).toContain('another process is writing this session store');
    });

    it('keeps session_modified_externally mapped to exit 3', async () => {
      const runHeadlessTurn = vi.fn(async () => {
        throw new CliSessionModifiedExternallyError({
          kind: 'session_modified_externally',
          sessionId: 'session-modified',
          expectedUpdatedAt: 100,
          currentUpdatedAt: 200,
          currentMessageCount: 3,
          deltaMessages: 1,
        });
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => validSettings,
        appVersion: 'test',
      });

      const exitCode = await runCli(['run', '--prompt', 'Hello']);

      expect(exitCode).toBe(3);
      expect(stderrWrites.join('')).toContain('modified externally');
    });

    it('emits a structured session_modified_externally JSON event for run --json (exit 3)', async () => {
      const runHeadlessTurn = vi.fn(async () => {
        throw new CliSessionModifiedExternallyError({
          kind: 'session_modified_externally',
          sessionId: 'session-modified',
          expectedUpdatedAt: 100,
          currentUpdatedAt: 200,
          currentMessageCount: 3,
          deltaMessages: 1,
        });
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => validSettings,
        appVersion: 'test',
      });

      const exitCode = await runCli(['run', '--prompt', 'Hello', '--json']);

      expect(exitCode).toBe(3);
      const lines = stdoutWrites.join('').trim().split('\n');
      const event = JSON.parse(lines[lines.length - 1]);
      expect(event.type).toBe('session_modified_externally');
      expect(event.event).toEqual({
        kind: 'session_modified_externally',
        sessionId: 'session-modified',
        expectedUpdatedAt: 100,
        currentUpdatedAt: 200,
        currentMessageCount: 3,
        deltaMessages: 1,
      });
    });

    // mapCliPersistError followup: a store-refused (dropped) write is now mapped
    // at the runCli seam to its own structured outcome (exit 1, non-retryable —
    // NOT promoted to the retryable exit 3), instead of re-throwing to a raw
    // Clipanion error. All three persist error classes now flow through the one
    // handleCliPersistError dispatcher.
    const droppedError = () => new CliSessionPersistDroppedError({
      kind: 'session_persist_dropped',
      sessionId: 'session-dropped',
      reason: 'read-only',
    });

    it('maps a store-dropped write to exit 1 with structured stderr', async () => {
      const runHeadlessTurn = vi.fn(async () => {
        throw droppedError();
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => validSettings,
        appVersion: 'test',
      });

      const exitCode = await runCli(['run', '--prompt', 'Hello']);

      expect(exitCode).toBe(1);
      const fullStderr = stderrWrites.join('');
      expect(fullStderr).toContain('the store dropped the write');
      expect(fullStderr).toContain('read-only');
      expect(fullStderr).toContain('session-dropped');
    });

    it('emits a structured session_persist_dropped JSON event for run --json (exit 1)', async () => {
      const runHeadlessTurn = vi.fn(async () => {
        throw droppedError();
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => validSettings,
        appVersion: 'test',
      });

      const exitCode = await runCli(['run', '--prompt', 'Hello', '--json']);

      expect(exitCode).toBe(1);
      const lines = stdoutWrites.join('').trim().split('\n');
      const event = JSON.parse(lines[lines.length - 1]);
      expect(event.type).toBe('session_persist_dropped');
      expect(event.event).toEqual({
        kind: 'session_persist_dropped',
        sessionId: 'session-dropped',
        reason: 'read-only',
      });
    });

    it('does not mis-map a non-persist error as a persist outcome (no structured persist event, not exit 3)', async () => {
      const runHeadlessTurn = vi.fn(async () => {
        throw new Error('unexpected boom');
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => validSettings,
        appVersion: 'test',
      });

      const exitCode = await runCli(['run', '--prompt', 'Hello', '--json']);

      // handleCliPersistError returns null for non-persist errors → caller
      // re-throws → general error code (Clipanion → non-zero). Assert non-zero so
      // a future change that accidentally SWALLOWED the error (returning 0) fails
      // here, and not exit 3 so it's never mis-mapped to the retryable persist path.
      expect(exitCode).toBeGreaterThan(0);
      expect(exitCode).not.toBe(3);
      // The unknown error must NOT be rendered as a structured persist event.
      const stdout = stdoutWrites.join('');
      expect(stdout).not.toContain('session_persist_contention');
      expect(stdout).not.toContain('session_persist_dropped');
      expect(stdout).not.toContain('session_modified_externally');
    });
  });

  describe('Stage 7: --no-mcp pre-runtime flag', () => {
    it('pre-parses --no-mcp before runtime construction for run/chat/smoke-test but not mcp-server', () => {
      expect(parseCliFlagsBeforeRuntime(['--headless-cli', 'run', '--no-mcp', '-p', 'Hello'])).toEqual({ noMcp: true });
      expect(parseCliFlagsBeforeRuntime(['--headless-cli', 'run', '--no-mcp=true', '-p', 'Hello'])).toEqual({ noMcp: true });
      expect(parseCliFlagsBeforeRuntime(['--headless-cli', 'run', '--no-mcp=false', '-p', 'Hello'])).toEqual({ noMcp: false });
      expect(parseCliFlagsBeforeRuntime(['--headless-cli', 'run', '--no-mcp', 'true', '-p', 'Hello'])).toEqual({ noMcp: true });
      expect(parseCliFlagsBeforeRuntime(['--headless-cli', 'run', '--no-mcp', 'false', '-p', 'Hello'])).toEqual({ noMcp: false });
      expect(parseCliFlagsBeforeRuntime(['--headless-cli', 'chat', '--no-mcp'])).toEqual({ noMcp: true });
      expect(parseCliFlagsBeforeRuntime(['--headless-cli', 'chat', '--no-mcp=true'])).toEqual({ noMcp: true });
      expect(parseCliFlagsBeforeRuntime(['--headless-cli', 'smoke-test', '--no-mcp'])).toEqual({ noMcp: true });
      expect(parseCliFlagsBeforeRuntime(['--headless-cli', 'smoke-test', '--no-mcp=true'])).toEqual({ noMcp: true });
      expect(parseCliFlagsBeforeRuntime(['--headless-cli', 'mcp-server', '--no-mcp'])).toEqual({ noMcp: false });
      expect(parseCliFlagsBeforeRuntime(['--headless-cli', 'mcp-server', '--no-mcp=true'])).toEqual({ noMcp: false });
    });

    it('accepts smoke-test --no-mcp=true and completes a tools-empty turn', async () => {
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as AppSettings;

      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        onEvent({
          type: 'result',
          text: 'ok',
          timestamp: Date.now()
        } as AgentEvent);
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => settings,
        appVersion: 'test'
      });

      const exitCode = await runCli(['smoke-test', '--no-mcp=true']);

      expect(exitCode).toBe(0);
      expect(runHeadlessTurn).toHaveBeenCalledTimes(1);
      expect(runHeadlessTurn.mock.calls[0]?.[0].options).toMatchObject({
        sessionType: 'cli',
        persistMode: { kind: 'none' },
      });
    });

    it('accepts mcp-server --no-mcp=true as a stripped pre-runtime flag', async () => {
      initCliRuntime({
        runHeadlessTurn: vi.fn() as any,
        getSettings: () => ({ coreDirectory: '/tmp/workspace' }) as AppSettings,
        appVersion: 'test'
      });

      const exitCode = await runCli(['mcp-server', '--no-mcp=true', '--help']);

      expect(exitCode).toBe(0);
      expect(stderrWrites.join('')).not.toContain('Unsupported option');
    });
  });

  describe('Stage 1: Duplicate output fix', () => {
    it('prints assistant text exactly once (not duplicated by result.text)', async () => {
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as unknown as AppSettings;

      const assistantText = 'Hello from the assistant!';
      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        // Simulate streaming assistant event (with the text)
        onEvent({
          type: 'assistant',
          text: assistantText,
          timestamp: Date.now()
        } as AgentEvent);
        // Simulate result event with the same text (which should NOT be printed again)
        onEvent({
          type: 'result',
          text: assistantText,
          timestamp: Date.now()
        } as AgentEvent);
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => settings,
        appVersion: 'test'
      });

      const exitCode = await runCli(['run', '--prompt', 'Hello']);

      expect(exitCode).toBe(0);
      // Count how many times the assistant text appears in stdout
      const fullOutput = stdoutWrites.join('');
      const occurrences = fullOutput.split(assistantText).length - 1;
      expect(occurrences).toBe(1);
    });

    it('prints result.text when no assistant event occurred', async () => {
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as unknown as AppSettings;

      const resultText = 'Result only text';
      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        // Only result event, no assistant event
        onEvent({
          type: 'result',
          text: resultText,
          timestamp: Date.now()
        } as AgentEvent);
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => settings,
        appVersion: 'test'
      });

      const exitCode = await runCli(['run', '--prompt', 'Hello']);

      expect(exitCode).toBe(0);
      const fullOutput = stdoutWrites.join('');
      expect(fullOutput).toContain(resultText);
    });
  });

  describe('Stage 3: Smoke-test fails on empty result', () => {
    it('returns exit code 1 when result event has empty text and no assistant events', async () => {
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as AppSettings;

      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        // Result event with empty text
        onEvent({
          type: 'result',
          text: '',
          timestamp: Date.now()
        } as AgentEvent);
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => settings,
        appVersion: 'test'
      });

      const exitCode = await runCli(['smoke-test']);

      expect(exitCode).toBe(1);
      const fullStderr = stderrWrites.join('');
      expect(fullStderr).toContain('no meaningful content produced');
    });

    it('returns exit code 1 when result event has whitespace-only text', async () => {
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as AppSettings;

      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        // Result event with whitespace-only text
        onEvent({
          type: 'result',
          text: '   \n   ',
          timestamp: Date.now()
        } as AgentEvent);
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => settings,
        appVersion: 'test'
      });

      const exitCode = await runCli(['smoke-test']);

      expect(exitCode).toBe(1);
      const fullStderr = stderrWrites.join('');
      expect(fullStderr).toContain('no meaningful content produced');
    });
  });

  describe('Stage 4: Chat command rejects --json flag', () => {
    it('returns exit code 1 with error message when --json is used with chat', async () => {
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as AppSettings;

      const runHeadlessTurn = vi.fn(async () => {
        throw new Error('runHeadlessTurn should not be called when --json is used with chat');
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => settings,
        appVersion: 'test'
      });

      const exitCode = await runCli(['chat', '--json']);

      expect(exitCode).toBe(1);
      expect(runHeadlessTurn).not.toHaveBeenCalled();
      const fullStderr = stderrWrites.join('');
      expect(fullStderr).toContain('--json is not supported with the interactive chat command');
    });
  });

  describe('Stage 5: New event types are handled', () => {
    it('handles context_overflow event without throwing', async () => {
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as AppSettings;

      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        onEvent({
          type: 'context_overflow',
          timestamp: Date.now()
        } as AgentEvent);
        onEvent({
          type: 'result',
          text: 'ok',
          timestamp: Date.now()
        } as AgentEvent);
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => settings,
        appVersion: 'test'
      });

      const exitCode = await runCli(['run', '--prompt', 'Hello']);

      expect(exitCode).toBe(0);
      const fullStderr = stderrWrites.join('');
      expect(fullStderr).toContain('[context_overflow]');
    });

    it('handles compaction events without throwing', async () => {
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as AppSettings;

      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        onEvent({
          type: 'compaction_started',
          depth: 1,
          timestamp: Date.now()
        } as AgentEvent);
        onEvent({
          type: 'compaction_summary_ready',
          timestamp: Date.now()
        } as AgentEvent);
        onEvent({
          type: 'compaction_retrying',
          timestamp: Date.now()
        } as AgentEvent);
        onEvent({
          type: 'compaction_completed',
          timestamp: Date.now()
        } as AgentEvent);
        onEvent({
          type: 'result',
          text: 'ok',
          timestamp: Date.now()
        } as AgentEvent);
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => settings,
        appVersion: 'test'
      });

      const exitCode = await runCli(['run', '--prompt', 'Hello']);

      expect(exitCode).toBe(0);
      const fullStderr = stderrWrites.join('');
      expect(fullStderr).toContain('[compaction] Starting context compaction');
      expect(fullStderr).toContain('[compaction] Summary ready');
      expect(fullStderr).toContain('[compaction] Retrying');
      expect(fullStderr).toContain('[compaction] Completed');
    });

    it('handles compaction_failed event without throwing', async () => {
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as AppSettings;

      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        onEvent({
          type: 'compaction_started',
          depth: 1,
          timestamp: Date.now()
        } as AgentEvent);
        onEvent({
          type: 'compaction_failed',
          error: 'Test compaction error',
          timestamp: Date.now()
        } as AgentEvent);
        onEvent({
          type: 'result',
          text: 'ok',
          timestamp: Date.now()
        } as AgentEvent);
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => settings,
        appVersion: 'test'
      });

      const exitCode = await runCli(['run', '--prompt', 'Hello']);

      expect(exitCode).toBe(0);
      const fullStderr = stderrWrites.join('');
      expect(fullStderr).toContain('[compaction] Failed: Test compaction error');
    });

    it('handles recovery events without throwing', async () => {
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as AppSettings;
      const baseRecoveryEvent = {
        turnId: 'turn-1',
        sessionId: 'session-1',
        originalSessionId: 'session-1',
        depth: 1,
        attempt: 1,
        totalCalls: 2,
        timestamp: Date.now()
      };

      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        onEvent({ type: 'recovery:started', ...baseRecoveryEvent, phase: 'post_activity' } as AgentEvent);
        onEvent({
          type: 'recovery:fallback_attempting',
          ...baseRecoveryEvent,
          target: { kind: 'model', modelName: 'Opus Recovery' }
        } as AgentEvent);
        onEvent({
          type: 'recovery:fallback_succeeded',
          ...baseRecoveryEvent,
          target: { kind: 'model', modelName: 'Opus Recovery' }
        } as AgentEvent);
        onEvent({ type: 'recovery:compacting', ...baseRecoveryEvent } as AgentEvent);
        onEvent({ type: 'recovery:summary_ready', ...baseRecoveryEvent, summary: 'Summary' } as AgentEvent);
        onEvent({ type: 'recovery:retrying', ...baseRecoveryEvent } as AgentEvent);
        onEvent({ type: 'recovery:skeleton_attempting', ...baseRecoveryEvent } as AgentEvent);
        onEvent({
          type: 'recovery:depth4_attempting',
          ...baseRecoveryEvent,
          profileId: 'profile-1',
          modelName: 'Opus Recovery',
          costEstimate: 'high'
        } as AgentEvent);
        onEvent({
          type: 'recovery:succeeded',
          ...baseRecoveryEvent,
          finalDepth: 3,
          totalDurationMs: 1234
        } as AgentEvent);
        onEvent({
          type: 'recovery:failed',
          ...baseRecoveryEvent,
          error: 'Nope',
          exhaustedReason: 'depth_limit_reached'
        } as AgentEvent);
        onEvent({
          type: 'recovery:last_resort_skipped',
          ...baseRecoveryEvent,
          reason: 'no_qualifying_profile',
          userFacingTitle: 'No recovery model available',
          userFacingMessage: 'Choose a recovery model, then try again.',
          action: 'Open settings'
        } as AgentEvent);
        onEvent({
          type: 'result',
          text: 'ok',
          timestamp: Date.now()
        } as AgentEvent);
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => settings,
        appVersion: 'test'
      });

      const exitCode = await runCli(['run', '--prompt', 'Hello']);

      expect(exitCode).toBe(0);
      const fullStderr = stderrWrites.join('');
      expect(fullStderr).toContain('[recovery] Recovery started');
      expect(fullStderr).toContain('[recovery] Trying fallback model: Opus Recovery');
      expect(fullStderr).toContain('[recovery] Fallback model succeeded: Opus Recovery');
      expect(fullStderr).toContain('[recovery] Compacting context');
      expect(fullStderr).toContain('[recovery] Summary ready');
      expect(fullStderr).toContain('[recovery] Retrying');
      expect(fullStderr).toContain('[recovery] Skeleton fallback');
      expect(fullStderr).toContain('[recovery] Last-resort recovery model');
      expect(fullStderr).toContain('[recovery] Succeeded');
      expect(fullStderr).toContain('[recovery] Failed: Nope');
      expect(fullStderr).toContain('[recovery] Last resort skipped');
    });
  });

  describe('Stage 6: Profiling with --profile flag', () => {
    it('outputs profiling metrics in human-readable mode with --profile', async () => {
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as AppSettings;

      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        // Simulate streaming delta (first assistant token)
        onEvent({
          type: 'assistant_delta',
          text: 'Hello',
          timestamp: Date.now() + 100 // Simulate 100ms after start
        } as AgentEvent);
        // Simulate result with usage metrics
        onEvent({
          type: 'result',
          text: 'Hello world',
          model: 'claude-sonnet-4-20250514',
          usage: {
            inputTokens: 1000,
            outputTokens: 50,
            cacheReadTokens: 800,
            cacheCreationTokens: 200,
            costUsd: 0.001
          },
          timestamp: Date.now() + 500 // Simulate 500ms total
        } as AgentEvent);
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => settings,
        appVersion: 'test'
      });

      const exitCode = await runCli(['run', '--prompt', 'Hello', '--profile']);

      expect(exitCode).toBe(0);
      const fullStderr = stderrWrites.join('');
      expect(fullStderr).toContain('[profile] TTFT:');
      expect(fullStderr).toContain('Total:');
      expect(fullStderr).toContain('Cache hit:');
      expect(fullStderr).toContain('[profile] First event:');
      expect(fullStderr).toContain('Model: claude-sonnet-4-20250514');
    });

    it('outputs profiling metrics as NDJSON with --profile --json', async () => {
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as AppSettings;

      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        onEvent({
          type: 'assistant_delta',
          text: 'Hi',
          timestamp: Date.now()
        } as AgentEvent);
        onEvent({
          type: 'result',
          text: 'Hi there',
          model: 'claude-sonnet-4-20250514',
          usage: {
            inputTokens: 500,
            outputTokens: 25,
            cacheReadTokens: 400,
            cacheCreationTokens: 100
          },
          timestamp: Date.now()
        } as AgentEvent);
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => settings,
        appVersion: 'test'
      });

      const exitCode = await runCli(['run', '--prompt', 'Hello', '--profile', '--json']);

      expect(exitCode).toBe(0);
      const fullOutput = stdoutWrites.join('');
      const lines = fullOutput.trim().split('\n');
      
      // Find the profile event
      const profileLine = lines.find(line => {
        try {
          const parsed = JSON.parse(line);
          return parsed.type === 'profile';
        } catch {
          return false;
        }
      });

      expect(profileLine).toBeDefined();
      const profileEvent = JSON.parse(profileLine!);
      expect(profileEvent.type).toBe('profile');
      expect(profileEvent.event.metrics).toBeDefined();
      expect(profileEvent.event.metrics.ttftMs).toBeDefined();
      expect(profileEvent.event.metrics.totalDurationMs).toBeDefined();
      expect(profileEvent.event.metrics.cacheHitRatio).toBeDefined();
      expect(profileEvent.event.metrics.inputTokens).toBe(500);
      expect(profileEvent.event.metrics.outputTokens).toBe(25);
    });

    it('calculates cache hit ratio correctly', async () => {
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as AppSettings;

      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        onEvent({
          type: 'result',
          text: 'ok',
          usage: {
            inputTokens: 200, // Non-cached input tokens
            outputTokens: 50,
            cacheReadTokens: 800, // Cached tokens
            cacheCreationTokens: 0
          },
          timestamp: Date.now()
        } as AgentEvent);
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => settings,
        appVersion: 'test'
      });

      const exitCode = await runCli(['run', '--prompt', 'Hello', '--profile', '--json']);

      expect(exitCode).toBe(0);
      const fullOutput = stdoutWrites.join('');
      const lines = fullOutput.trim().split('\n');
      const profileLine = lines.find(line => JSON.parse(line).type === 'profile');
      const profileEvent = JSON.parse(profileLine!);
      
      // Cache hit ratio = cacheRead / (cacheRead + inputTokens) = 800 / (800 + 200) = 80%
      expect(profileEvent.event.metrics.cacheHitRatio).toBeCloseTo(80, 1);
    });

    it('handles null TTFT when no assistant events occur (tool-only response)', async () => {
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as AppSettings;

      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        // Tool-only response - no assistant events
        onEvent({
          type: 'tool',
          toolName: 'read_file',
          detail: 'Reading file...',
          stage: 'start',
          timestamp: Date.now()
        } as AgentEvent);
        onEvent({
          type: 'tool',
          toolName: 'read_file',
          detail: 'File contents',
          stage: 'end',
          timestamp: Date.now()
        } as AgentEvent);
        onEvent({
          type: 'result',
          text: '',
          usage: { inputTokens: 100, outputTokens: 10 },
          timestamp: Date.now()
        } as AgentEvent);
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => settings,
        appVersion: 'test'
      });

      const exitCode = await runCli(['run', '--prompt', 'Read file', '--profile', '--json']);

      expect(exitCode).toBe(0);
      const fullOutput = stdoutWrites.join('');
      const lines = fullOutput.trim().split('\n');
      const profileLine = lines.find(line => JSON.parse(line).type === 'profile');
      const profileEvent = JSON.parse(profileLine!);
      
      // TTFT should be null when no assistant content was produced
      expect(profileEvent.event.metrics.ttftMs).toBeNull();
      // But firstEventMs should be set (tool events count)
      expect(profileEvent.event.metrics.timeToFirstEventMs).not.toBeNull();
    });
  });

  describe('Stage 1 CLI turn options', () => {
    it('propagates new run flags to runHeadlessTurn options', async () => {
      const settings = {
        coreDirectory: '/tmp/workspace',
        activeProvider: 'anthropic',
        claude: { apiKey: 'test-key' },
        models: { apiKey: 'test-key' },
        openRouter: { enabled: false, oauthToken: 'openrouter-token' },
        localModel: { profiles: [], activeProfileId: null },
      } as unknown as AppSettings;
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rebel-cli-test-'));
      const attachmentPath = path.join(tmpDir, 'note.txt');
      await fs.writeFile(attachmentPath, 'attached text');

      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        onEvent({
          type: 'result',
          text: 'ok',
          timestamp: Date.now()
        } as AgentEvent);
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => settings,
        appVersion: 'test'
      });

      const exitCode = await runCli([
        'run',
        '--prompt',
        'Hello',
        '--session',
        'session-1',
        '--model',
        'claude-sonnet-4-5',
        '--thinking',
        'claude-opus-4-5',
        '--working-profile',
        'working-profile',
        '--thinking-profile',
        'thinking-profile',
        '--effort',
        'high',
        '--council',
        '--unleashed',
        '--private',
        '--provider',
        'openrouter',
        '--attach',
        attachmentPath,
      ]);

      expect(exitCode).toBe(0);
      expect(runHeadlessTurn).toHaveBeenCalledTimes(1);
      expect(runHeadlessTurn.mock.calls[0]?.[0].options).toMatchObject({
        sessionType: 'cli',
        persistMode: { kind: 'cli-session' },
        sessionId: 'session-1',
        modelOverride: 'claude-sonnet-4-5',
        thinkingModelOverride: 'claude-opus-4-5',
        workingProfileOverrideId: 'working-profile',
        thinkingProfileOverrideId: 'thinking-profile',
        thinkingEffortOverride: 'high',
        councilMode: true,
        unleashedMode: true,
        privateMode: true,
        activeProviderOverride: 'openrouter',
      });
      expect(runHeadlessTurn.mock.calls[0]?.[0].options.attachments).toHaveLength(1);
    });

    it('maps --no-thinking to an empty thinkingModelOverride', async () => {
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as AppSettings;
      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        onEvent({ type: 'result', text: 'ok', timestamp: Date.now() } as AgentEvent);
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => settings,
        appVersion: 'test'
      });

      const exitCode = await runCli(['run', '--prompt', 'Hello', '--no-thinking']);

      expect(exitCode).toBe(0);
      expect(runHeadlessTurn.mock.calls[0]?.[0].options.thinkingModelOverride).toBe('');
    });

    it('keeps --session-id as a deprecated alias with a warning', async () => {
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as AppSettings;
      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        onEvent({ type: 'result', text: 'ok', timestamp: Date.now() } as AgentEvent);
      });

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => settings,
        appVersion: 'test'
      });

      const exitCode = await runCli(['run', '--prompt', 'Hello', '--session-id', 'LEGACY_ID']);

      expect(exitCode).toBe(0);
      expect(runHeadlessTurn.mock.calls[0]?.[0].options.sessionId).toBe('LEGACY_ID');
      expect(stderrWrites.join('')).toContain('--session-id is deprecated');
    });

    it('emits safety bypass notice and forwards env-controlled fields', async () => {
      const previousBypass = process.env.REBEL_CLI_BYPASS_SAFETY;
      process.env.REBEL_CLI_BYPASS_SAFETY = '1';
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as AppSettings;
      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        onEvent({ type: 'result', text: 'ok', timestamp: Date.now() } as AgentEvent);
      });

      try {
        initCliRuntime({
          runHeadlessTurn: runHeadlessTurn as any,
          getSettings: () => settings,
          appVersion: 'test'
        });

        const exitCode = await runCli(['run', '--prompt', 'Hello']);

        expect(exitCode).toBe(0);
        expect(runHeadlessTurn.mock.calls[0]?.[0].options).toMatchObject({
          bypassToolSafety: true,
        });
        expect(stderrWrites.join('')).toContain('REBEL_CLI_BYPASS_SAFETY=1');
      } finally {
        if (previousBypass === undefined) {
          delete process.env.REBEL_CLI_BYPASS_SAFETY;
        } else {
          process.env.REBEL_CLI_BYPASS_SAFETY = previousBypass;
        }
      }
    });

    it('accepts --bypass-safety and emits the stderr banner', async () => {
      const previousBypass = process.env.REBEL_CLI_BYPASS_SAFETY;
      delete process.env.REBEL_CLI_BYPASS_SAFETY;
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as AppSettings;
      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        onEvent({ type: 'result', text: 'ok', timestamp: Date.now() } as AgentEvent);
      });

      try {
        initCliRuntime({
          runHeadlessTurn: runHeadlessTurn as any,
          getSettings: () => settings,
          appVersion: 'test'
        });

        const exitCode = await runCli(['run', '--prompt', 'Hello', '--bypass-safety']);

        expect(exitCode).toBe(0);
        expect(runHeadlessTurn.mock.calls[0]?.[0].options.bypassToolSafety).toBe(true);
        expect(stderrWrites.join('')).toContain('--bypass-safety / REBEL_CLI_BYPASS_SAFETY=1');
      } finally {
        if (previousBypass === undefined) {
          delete process.env.REBEL_CLI_BYPASS_SAFETY;
        } else {
          process.env.REBEL_CLI_BYPASS_SAFETY = previousBypass;
        }
      }
    });

    it('uses --approval-timeout for the run approval handler', async () => {
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as AppSettings;
      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        onEvent({ type: 'result', text: 'ok', timestamp: Date.now() } as AgentEvent);
      });
      const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
      const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

      initCliRuntime({
        runHeadlessTurn: runHeadlessTurn as any,
        getSettings: () => settings,
        appVersion: 'test'
      });

      const exitCode = await runCli(['run', '--prompt', 'Hello', '--approval-timeout=5000']);
      expect(exitCode).toBe(0);
      const approvalHandler = runHeadlessTurn.mock.calls[0]?.[0].options.approvalHandler;
      expect(approvalHandler).toBeDefined();

      try {
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        vi.useFakeTimers();
        const decisionPromise = approvalHandler!(
          { kind: 'tool_safety', toolName: 'write_file', toolInput: {}, reason: 'test' },
          new AbortController().signal,
        );
        await vi.advanceTimersByTimeAsync(4_999);
        const settledEarly = await Promise.race([
          decisionPromise.then(() => true),
          Promise.resolve(false),
        ]);
        expect(settledEarly).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(decisionPromise).resolves.toEqual({ approved: false, reason: 'timeout' });
      } finally {
        if (stdinDescriptor) {
          Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
        }
        if (stdoutDescriptor) {
          Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
        }
      }
    });

    it('lets --bypass-safety override a non-enabling env-var value', async () => {
      const previousBypass = process.env.REBEL_CLI_BYPASS_SAFETY;
      process.env.REBEL_CLI_BYPASS_SAFETY = '0';
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as AppSettings;
      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        onEvent({ type: 'result', text: 'ok', timestamp: Date.now() } as AgentEvent);
      });

      try {
        initCliRuntime({
          runHeadlessTurn: runHeadlessTurn as any,
          getSettings: () => settings,
          appVersion: 'test'
        });

        const exitCode = await runCli(['run', '--prompt', 'Hello', '--bypass-safety']);

        expect(exitCode).toBe(0);
        expect(runHeadlessTurn.mock.calls[0]?.[0].options.bypassToolSafety).toBe(true);
      } finally {
        if (previousBypass === undefined) {
          delete process.env.REBEL_CLI_BYPASS_SAFETY;
        } else {
          process.env.REBEL_CLI_BYPASS_SAFETY = previousBypass;
        }
      }
    });

    it('keeps safety active when neither --bypass-safety nor env-var is set', async () => {
      const previousBypass = process.env.REBEL_CLI_BYPASS_SAFETY;
      delete process.env.REBEL_CLI_BYPASS_SAFETY;
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as AppSettings;
      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        onEvent({ type: 'result', text: 'ok', timestamp: Date.now() } as AgentEvent);
      });

      try {
        initCliRuntime({
          runHeadlessTurn: runHeadlessTurn as any,
          getSettings: () => settings,
          appVersion: 'test'
        });

        const exitCode = await runCli(['run', '--prompt', 'Hello']);

        expect(exitCode).toBe(0);
        expect(runHeadlessTurn.mock.calls[0]?.[0].options.bypassToolSafety).toBeUndefined();
        expect(stderrWrites.join('')).not.toContain('BYPASS_SAFETY');
      } finally {
        if (previousBypass === undefined) {
          delete process.env.REBEL_CLI_BYPASS_SAFETY;
        } else {
          process.env.REBEL_CLI_BYPASS_SAFETY = previousBypass;
        }
      }
    });

    it('emits BOTH stderr banner AND structured JSON event when bypass is set in --json mode', async () => {
      const previousBypass = process.env.REBEL_CLI_BYPASS_SAFETY;
      process.env.REBEL_CLI_BYPASS_SAFETY = '1';
      const settings = {
        coreDirectory: '/tmp/workspace',
        claude: { apiKey: 'test-key' }, models: { apiKey: 'test-key' }
      } as AppSettings;
      const runHeadlessTurn = vi.fn(async ({ onEvent }) => {
        onEvent({ type: 'result', text: 'ok', timestamp: Date.now() } as AgentEvent);
      });

      try {
        initCliRuntime({
          runHeadlessTurn: runHeadlessTurn as any,
          getSettings: () => settings,
          appVersion: 'test'
        });

        const exitCode = await runCli(['run', '--prompt', 'Hello', '--json']);

        expect(exitCode).toBe(0);
        expect(stderrWrites.join('')).toContain('REBEL_CLI_BYPASS_SAFETY=1');
        const stdoutJoined = stdoutWrites.join('');
        expect(stdoutJoined).toContain('"type":"safety_bypass_active"');
        expect(stdoutJoined).toContain('"disabled_hooks"');
      } finally {
        if (previousBypass === undefined) {
          delete process.env.REBEL_CLI_BYPASS_SAFETY;
        } else {
          process.env.REBEL_CLI_BYPASS_SAFETY = previousBypass;
        }
      }
    });
  });
});

function mockReadlineQuestions(questions: string[]): ReturnType<typeof vi.spyOn> {
  const pending = [...questions];
  return vi.spyOn(readline, 'createInterface').mockReturnValue({
    question: (_query: string, callback: (answer: string) => void) => {
      callback(pending.shift() ?? ':quit');
    },
    close: vi.fn(),
  } as unknown as readline.Interface);
}
