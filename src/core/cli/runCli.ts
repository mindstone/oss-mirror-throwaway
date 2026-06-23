import { Builtins, Cli, Command, Option } from 'clipanion';
import * as t from 'typanion';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import readline from 'node:readline';
import type { AgentEvent, AgentSession, AgentSessionSummary, AppSettings } from '@shared/types';
import type { ActiveProvider, ThinkingEffort } from '@shared/types/settings';
import type { IncrementalSessionStore } from '@core/services/incrementalSessionStore';
import type { SessionLockManager } from '@core/utils/sessionFileLock';
import type { ApprovalHandler, HeadlessTurnOptions } from '@core/types/headlessTurnOptions';
import type { HeadlessRuntime } from '@core/services/headlessRuntime';
import { getCodexAuthProvider } from '@core/codexAuth';
import { normalizeFinishLine } from '@core/utils/finishLine';
import { hasValidAuth } from '@core/utils/authEnvUtils';
import { validateProviderCredentials } from '@core/utils/validateProviderCredentials';
import { buildSettingsWithOverride } from '@core/services/turnPipeline/turnAdmission';
import {
  CliSessionContentionError,
  CliSessionModifiedExternallyError,
  CliSessionPersistDroppedError,
} from '@core/services/turnPipeline/persistSessionFromCli';

type OutputMode = 'human' | 'json';

/**
 * Profiling metrics for a single agent turn.
 * All timestamps are Unix epoch milliseconds.
 */
interface TurnProfilingMetrics {
  // Timestamps (epoch ms)
  turnStartMs: number;
  firstEventMs: number | null;
  firstAssistantTokenMs: number | null; // First assistant_delta or assistant event (TTFT anchor)
  resultMs: number | null;

  // Computed durations (ms)
  timeToFirstEventMs: number | null; // firstEvent - turnStart (includes local setup)
  ttftMs: number | null; // firstAssistantToken - turnStart
  totalDurationMs: number | null; // result - turnStart

  // Cache metrics
  cacheReadTokens: number;
  cacheCreationTokens: number;
  cacheHitRatio: number; // cacheRead / (cacheRead + inputTokens) as percentage

  // Token metrics
  inputTokens: number;
  outputTokens: number;

  // Model info
  model: string | null;
}

/**
 * State for tracking profiling timestamps during a turn.
 */
interface ProfilingState {
  turnStartMs: number;
  firstEventMs: number | null;
  firstAssistantTokenMs: number | null;
  resultMs: number | null;
  resultEvent: AgentEvent | null;
  model: string | null;
}

/**
 * Compute profiling metrics from collected state.
 */
function computeProfilingMetrics(state: ProfilingState): TurnProfilingMetrics {
  const resultUsage = state.resultEvent?.type === 'result' ? state.resultEvent.usage : undefined;

  const inputTokens = resultUsage?.inputTokens ?? 0;
  const outputTokens = resultUsage?.outputTokens ?? 0;
  const cacheReadTokens = resultUsage?.cacheReadTokens ?? 0;
  const cacheCreationTokens = resultUsage?.cacheCreationTokens ?? 0;

  // Cache hit ratio: what % of input tokens came from cache
  // Denominator is cacheRead + inputTokens (inputTokens includes non-cached prompt tokens)
  const totalPromptTokens = cacheReadTokens + inputTokens;
  const cacheHitRatio = totalPromptTokens > 0 ? (cacheReadTokens / totalPromptTokens) * 100 : 0;

  return {
    turnStartMs: state.turnStartMs,
    firstEventMs: state.firstEventMs,
    firstAssistantTokenMs: state.firstAssistantTokenMs,
    resultMs: state.resultMs,

    timeToFirstEventMs:
      state.firstEventMs !== null ? state.firstEventMs - state.turnStartMs : null,
    ttftMs:
      state.firstAssistantTokenMs !== null
        ? state.firstAssistantTokenMs - state.turnStartMs
        : null,
    totalDurationMs: state.resultMs !== null ? state.resultMs - state.turnStartMs : null,

    cacheReadTokens,
    cacheCreationTokens,
    cacheHitRatio,

    inputTokens,
    outputTokens,

    model: state.model,
  };
}

type RunHeadlessTurnFn = (params: {
  prompt: string;
  onEvent: (event: AgentEvent) => void;
  options: HeadlessTurnOptions;
}) => Promise<void>;

export interface CliApprovalHandlerDeps {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: { isTTY?: boolean; write: (message: string) => unknown };
  stderr: { isTTY?: boolean; write: (message: string) => unknown };
  now: () => number;
  timeoutMs?: number;
  jsonMode: boolean;
}

type ProviderValidationResult = { ok: true } | { ok: false; reason: string };

export interface CliPlatformDeps {
  loadAttachmentsFromPaths: (paths: string[]) => Promise<HeadlessTurnOptions['attachments']>;
  createCliApprovalHandler: (deps: CliApprovalHandlerDeps) => ApprovalHandler;
  startMcpServer: (deps: {
    version: string;
    runHeadlessTurn: RunHeadlessTurnFn;
    getSettings: () => Promise<AppSettings> | AppSettings;
  }) => Promise<void>;
}

type InitCliRuntimeDeps = {
  runtime?: Pick<HeadlessRuntime, 'runTurn' | 'getSettings'>;
  runHeadlessTurn?: RunHeadlessTurnFn;
  getSettings?: () => Promise<AppSettings> | AppSettings;
  appVersion: string;
  getSessionStore?: () => IncrementalSessionStore;
  lockManager?: SessionLockManager;
  onSessionsSaved?: (sessions: AgentSession[]) => void | Promise<void>;
  onSessionsSavedLocally?: (sessions: AgentSession[]) => void | Promise<void>;
  tailAbortSignal?: AbortSignal;
};

type CliRuntimeDeps = {
  runHeadlessTurn: RunHeadlessTurnFn;
  getSettings: () => Promise<AppSettings> | AppSettings;
  appVersion: string;
  getSessionStore?: () => IncrementalSessionStore;
  lockManager?: SessionLockManager;
  onSessionsSaved?: (sessions: AgentSession[]) => void | Promise<void>;
  onSessionsSavedLocally?: (sessions: AgentSession[]) => void | Promise<void>;
  tailAbortSignal?: AbortSignal;
};

let runtimeDeps: CliRuntimeDeps | null = null;
let cliPlatformDeps: CliPlatformDeps | null = null;

const THINKING_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh'] as const;
const ACTIVE_PROVIDER_VALUES = ['anthropic', 'openrouter', 'codex'] as const;
const SAFETY_BYPASS_DISABLED_HOOKS = [
  'tool_safety',
  'memory_write',
  'auto_continue_safety',
] as const;

export interface CliPreRuntimeFlags {
  noMcp: boolean;
}

export const configureCliPlatformDeps = (deps: CliPlatformDeps): void => {
  cliPlatformDeps = deps;
};

const requireCliPlatformDeps = (): CliPlatformDeps => {
  if (!cliPlatformDeps) {
    throw new Error('CLI platform deps not initialised');
  }
  return cliPlatformDeps;
};

function validateProviderFlag(args: {
  provider: ActiveProvider;
  rawSettings: AppSettings;
  codexConnected: boolean;
}): ProviderValidationResult {
  const settings = buildSettingsWithOverride(args.rawSettings, args.provider);
  const credentialState = validateProviderCredentials(settings, args.codexConnected);

  switch (credentialState.kind) {
    case 'anthropic':
      return credentialState.status === 'valid'
        ? { ok: true }
        : {
            ok: false,
            reason:
              'Anthropic is disconnected. Add an API key in Settings → AI & Models, or choose another provider.',
          };
    case 'openrouter':
      return credentialState.status === 'valid'
        ? { ok: true }
        : {
            ok: false,
            reason:
              'OpenRouter is disconnected. Reconnect it in Settings → AI & Models, or choose another provider.',
          };
    case 'codex':
      return credentialState.status === 'connected'
        ? { ok: true }
        : {
            ok: false,
            reason:
              'ChatGPT Pro is disconnected. Reconnect it in Settings → AI & Models, or choose another provider.',
          };
    case 'mindstone':
      return { ok: true };
    case 'local':
      return { ok: true };
    default: {
      const _exhaustive: never = credentialState;
      return {
        ok: false,
        reason: `Unsupported provider state. Check Settings → AI & Models. (${JSON.stringify(_exhaustive)})`,
      };
    }
  }
}

const normalizeCliArgs = (argv: string[]): string[] =>
  argv.filter((arg) => arg !== '--headless-cli');

const stripNoMcpFlags = (argv: string[]): { args: string[]; noMcp: boolean } => {
  let noMcp: boolean | undefined;
  const args: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-mcp') {
      const next = argv[index + 1];
      if (next === 'true' || next === 'false') {
        noMcp = next === 'true';
        index += 1;
      } else {
        noMcp = true;
      }
      continue;
    }

    const equalsMatch = arg.match(/^--no-mcp=(true|false)$/);
    if (equalsMatch) {
      noMcp = equalsMatch[1] === 'true';
      continue;
    }

    args.push(arg);
  }

  return { args, noMcp: noMcp === true };
};

const findCommandName = (args: string[]): string | null => {
  for (const arg of args) {
    if (!arg.startsWith('-')) {
      return arg;
    }
  }
  return null;
};

export const parseCliFlagsBeforeRuntime = (argv = process.argv.slice(2)): CliPreRuntimeFlags => {
  const { args, noMcp } = stripNoMcpFlags(normalizeCliArgs(argv));
  const commandName = findCommandName(args);
  return {
    noMcp: noMcp && commandName !== 'mcp-server',
  };
};

export const initCliRuntime = (deps: InitCliRuntimeDeps): void => {
  const runHeadlessTurn = deps.runtime?.runTurn ?? deps.runHeadlessTurn;
  const getSettings = deps.runtime?.getSettings ?? deps.getSettings;
  if (!runHeadlessTurn || !getSettings) {
    throw new Error('CLI runtime requires a headless runtime or explicit runHeadlessTurn/getSettings deps');
  }
  runtimeDeps = {
    runHeadlessTurn,
    getSettings,
    appVersion: deps.appVersion,
    ...(deps.getSessionStore ? { getSessionStore: deps.getSessionStore } : {}),
    ...(deps.lockManager ? { lockManager: deps.lockManager } : {}),
    ...(deps.onSessionsSaved ? { onSessionsSaved: deps.onSessionsSaved } : {}),
    ...(deps.onSessionsSavedLocally ? { onSessionsSavedLocally: deps.onSessionsSavedLocally } : {}),
    ...(deps.tailAbortSignal ? { tailAbortSignal: deps.tailAbortSignal } : {}),
  };
};

const requireDeps = (): CliRuntimeDeps => {
  if (!runtimeDeps) {
    throw new Error('CLI runtime not initialised');
  }
  return runtimeDeps;
};

const getCodexConnectedSnapshot = (): boolean => {
  try {
    return getCodexAuthProvider().isConnected();
  } catch {
    return false;
  }
};

const isStandaloneCli = (): boolean => process.env.REBEL_SURFACE === 'cli-standalone';

const standaloneAuthHint = (provider: ActiveProvider | undefined): string => {
  const envName = provider === 'openrouter'
    ? 'REBEL_OPENROUTER_API_KEY'
    : provider === 'codex'
      ? 'REBEL_CODEX_TOKEN'
      : 'REBEL_ANTHROPIC_API_KEY';
  return `set ${envName} or run \`rebel auth --print-env-vars\` inside the .app's CLI mode`;
};

const standaloneCodexChatError =
  'Codex/Claude Max provider in standalone CLI is short-session-only (token expires in ~1 hour with no refresh). Use Electron-backed CLI for long sessions.';

const emitSafetyBypassNotice = (args: {
  mode: OutputMode;
  turnId: string;
  stderr: { write: (message: string) => unknown };
}): void => {
  args.stderr.write(
    '⚠  --bypass-safety / REBEL_CLI_BYPASS_SAFETY=1 — tool safety, memory-write safety, and auto-continue gates are DISABLED for this process.\n',
  );
  if (args.mode === 'json') {
    const payload = {
      turnId: args.turnId,
      type: 'safety_bypass_active',
      timestamp: Date.now(),
      event: { disabled_hooks: SAFETY_BYPASS_DISABLED_HOOKS },
    };
    process.stdout.write(JSON.stringify(payload) + '\n');
  }
};

interface EventHandlerState {
  sawError: boolean;
  sawResult: boolean;
  printedAssistant: boolean;
  sawMeaningfulContent: boolean;
}

const createEventHandler = (
  turnId: string,
  mode: OutputMode,
  state: EventHandlerState,
  profilingState?: ProfilingState
): ((event: AgentEvent) => void) => {
  return (event: AgentEvent) => {
    const eventTimestamp = (event as { timestamp?: number }).timestamp ?? Date.now();

    // Update profiling timestamps if profiling is enabled
    if (profilingState) {
      // Track first event of any type
      if (profilingState.firstEventMs === null) {
        profilingState.firstEventMs = eventTimestamp;
      }

      // Track first assistant content (TTFT anchor) - either streaming delta or complete message
      if (
        profilingState.firstAssistantTokenMs === null &&
        (event.type === 'assistant_delta' || event.type === 'assistant')
      ) {
        profilingState.firstAssistantTokenMs = eventTimestamp;
      }

      // Track result timing and capture the event for metrics extraction
      if (event.type === 'result') {
        profilingState.resultMs = eventTimestamp;
        profilingState.resultEvent = event;
        profilingState.model = event.model ?? null;
      }
    }

    // Don't output assistant_delta events in human mode (they would duplicate assistant output)
    // In JSON mode, we DO output them for full event stream visibility
    if (mode === 'json') {
      const payload = {
        turnId,
        type: event.type,
        timestamp: eventTimestamp,
        event
      };
      process.stdout.write(JSON.stringify(payload) + '\n');
    } else if ((event as { type: string }).type === 'session_persisted') {
      const persisted = event as unknown as { sessionId?: string };
      process.stderr.write(`Saved to session ${persisted.sessionId ?? 'unknown'}\n`);
    } else {
      // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- AgentEvent is open at runtime (events stream from the agent turn); the CLI renders a subset and no-ops the rest — an exhaustive assertNever would crash the CLI mid-turn on unknown/future events.
      switch (event.type) {
        case 'status': {
          process.stderr.write(`[status] ${event.message}\n`);
          break;
        }
        case 'assistant': {
          if (event.text && event.text.length > 0) {
            process.stdout.write(event.text);
            if (!event.text.endsWith('\n')) {
              process.stdout.write('\n');
            }
            state.printedAssistant = true;
            state.sawMeaningfulContent = true;
          }
          break;
        }
        case 'assistant_delta': {
          // Streaming deltas - print incrementally in human mode
          if (event.text && event.text.length > 0) {
            process.stdout.write(event.text);
            state.printedAssistant = true;
            state.sawMeaningfulContent = true;
          }
          break;
        }
        case 'tool': {
          const stageLabel = event.stage === 'start' ? 'start' : 'end';
          process.stderr.write(
            `[tool:${stageLabel}] ${event.toolName}: ${event.detail ?? ''}\n`
          );
          break;
        }
        case 'result': {
          // Only print result.text if no assistant text was printed (handles edge case
          // where result has text but no assistant events occurred)
          if (!state.printedAssistant && event.text && event.text.trim().length > 0) {
            process.stdout.write(event.text);
            if (!event.text.endsWith('\n')) {
              process.stdout.write('\n');
            }
            state.sawMeaningfulContent = true;
          } else if (event.text && event.text.trim().length > 0) {
            // Even if we didn't print (because assistant already printed), track that content exists
            state.sawMeaningfulContent = true;
          }
          // Ensure newline after streaming output
          if (state.printedAssistant) {
            process.stdout.write('\n');
          }
          // Always print usage regardless of whether text was printed
          if (event.usage) {
            const { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, costUsd } =
              event.usage;
            const usageParts: string[] = [];
            if (inputTokens != null) usageParts.push(`in=${inputTokens}`);
            if (outputTokens != null) usageParts.push(`out=${outputTokens}`);
            if (cacheCreationTokens != null)
              usageParts.push(`cache_create=${cacheCreationTokens}`);
            if (cacheReadTokens != null) usageParts.push(`cache_read=${cacheReadTokens}`);
            if (costUsd != null) usageParts.push(`cost=$${costUsd.toFixed(6)}`);
            if (usageParts.length > 0) {
              process.stderr.write(`[usage] ${usageParts.join(' ')}\n`);
            }
          }
          break;
        }
        case 'error': {
          process.stderr.write(`Error: ${event.error}\n`);
          break;
        }
        case 'context_overflow': {
          process.stderr.write(`[context_overflow] Conversation context is full\n`);
          break;
        }
        // @deprecated Stage 4 retires compaction_* in favour of recovery:* events.
        case 'compaction_started': {
          process.stderr.write(`[compaction] Starting context compaction (depth ${event.depth})\n`);
          break;
        }
        case 'compaction_summary_ready': {
          process.stderr.write(`[compaction] Summary ready\n`);
          break;
        }
        case 'compaction_retrying': {
          process.stderr.write(`[compaction] Retrying...\n`);
          break;
        }
        case 'compaction_completed': {
          process.stderr.write(`[compaction] Completed\n`);
          break;
        }
        case 'compaction_failed': {
          process.stderr.write(`[compaction] Failed: ${event.error}\n`);
          break;
        }
        case 'recovery:started': {
          process.stderr.write(`[recovery] Recovery started (phase=${event.phase})\n`);
          break;
        }
        case 'recovery:fallback_attempting': {
          process.stderr.write(`[recovery] Trying fallback model: ${event.target.modelName ?? event.target.profileName ?? event.target.profileId ?? event.target.kind}\n`);
          break;
        }
        case 'recovery:fallback_succeeded': {
          process.stderr.write(`[recovery] Fallback model succeeded: ${event.target.modelName ?? event.target.profileName ?? event.target.profileId ?? event.target.kind}\n`);
          break;
        }
        case 'recovery:compacting': {
          process.stderr.write(`[recovery] Compacting context (depth ${event.depth}, attempt ${event.attempt})\n`);
          break;
        }
        case 'recovery:summary_ready': {
          process.stderr.write(`[recovery] Summary ready (depth ${event.depth})\n`);
          break;
        }
        case 'recovery:retrying': {
          process.stderr.write(`[recovery] Retrying (depth ${event.depth})\n`);
          break;
        }
        case 'recovery:skeleton_attempting': {
          process.stderr.write(`[recovery] Skeleton fallback (attempt ${event.attempt})\n`);
          break;
        }
        case 'recovery:depth4_attempting': {
          process.stderr.write(`[recovery] Last-resort recovery model (${event.profileId})\n`);
          break;
        }
        case 'recovery:succeeded': {
          process.stderr.write(`[recovery] Succeeded (totalCalls=${event.totalCalls})\n`);
          break;
        }
        case 'recovery:failed': {
          process.stderr.write(`[recovery] Failed: ${event.error} (${event.exhaustedReason})\n`);
          break;
        }
        case 'recovery:last_resort_skipped': {
          process.stderr.write(`[recovery] Last resort skipped: ${event.reason}\n`);
          break;
        }
        // AgentEvent is open at runtime (events stream from the agent turn); the
        // CLI renders a subset and no-ops the rest — unknown/future types must
        // not throw. An exhaustive assertNever would crash the CLI mid-turn.
        // (Guard suppressed at the switch above.)
        default:
          // eslint-disable-next-line rebel-switch-exhaustiveness/no-bare-default-bypass -- AgentEvent is open at runtime; default tolerates unknown/future event types (assertNever would throw -- see comment above).
          break;
      }
    }

    // State tracking (must happen regardless of output mode)
    if (event.type === 'error') {
      state.sawError = true;
    }
    if (event.type === 'result') {
      state.sawResult = true;
    }
    // Track meaningful content for smoke-test acceptance criteria
    if (
      (event.type === 'assistant' && event.text && event.text.length > 0) ||
      (event.type === 'assistant_delta' && event.text && event.text.length > 0) ||
      (event.type === 'result' && event.text && event.text.trim().length > 0)
    ) {
      state.sawMeaningfulContent = true;
    }
  };
};

abstract class BaseCommand extends Command {
  json = Option.Boolean('--json', false, {
    description: 'Emit newline-delimited JSON events instead of human-readable output'
  });

  protected get outputMode(): OutputMode {
    return this.json ? 'json' : 'human';
  }

  protected async ensureSettings(): Promise<AppSettings> {
    const { getSettings } = requireDeps();
    const settings = await Promise.resolve(getSettings());
    return settings;
  }

  protected get runtime(): CliRuntimeDeps {
    return requireDeps();
  }

  protected get sessionStore(): IncrementalSessionStore | null {
    return this.runtime.getSessionStore?.() ?? null;
  }

  /**
   * Render a CLI session-persist outcome consistently: a structured NDJSON event
   * on stdout in `--json` mode, else a human stderr message + the JSON details.
   * Shared by every persist-error branch in `handleCliPersistError`.
   */
  private renderCliPersistEvent(
    type: string,
    details: unknown,
    humanMessage: string,
    turnId?: string,
  ): void {
    if (this.outputMode === 'json') {
      const payload = { turnId, type, timestamp: Date.now(), event: details };
      process.stdout.write(JSON.stringify(payload) + '\n');
      return;
    }
    this.context.stderr.write(`Error: ${humanMessage}\n`);
    this.context.stderr.write(JSON.stringify(details) + '\n');
  }

  /**
   * Single source of truth for mapping a CLI session-persist error to its exit
   * code + observable rendering. Returns the exit code for a known
   * `CliSession*Error`, or `null` when the error is not a persist error (the
   * caller must re-throw). Adding a new persist error class means adding one
   * branch HERE — not re-deriving the mapping at each `runHeadlessTurn` catch
   * site. NOTE: `instanceof` is not compile-time exhaustive, so a new class added
   * without a branch falls through to `null` and is re-thrown as a general error
   * (exit 1) — never silently mis-mapped, but not auto-flagged either. `cli.test.ts`
   * covers each known class individually; add the new branch and its test together.
   * Exit-code contract: contention + modified-externally are retryable → 3; a
   * store-refused (dropped) write is non-retryable → 1.
   */
  protected handleCliPersistError(error: unknown, turnId?: string): number | null {
    if (error instanceof CliSessionContentionError) {
      this.renderCliPersistEvent(
        'session_persist_contention',
        error.details,
        `another process is writing this session store; retry after it finishes (session ${error.details.sessionId}).`,
        turnId,
      );
      return 3;
    }
    if (error instanceof CliSessionModifiedExternallyError) {
      this.renderCliPersistEvent(
        'session_modified_externally',
        error.details,
        `session ${error.details.sessionId} was modified externally.`,
        turnId,
      );
      return 3;
    }
    if (error instanceof CliSessionPersistDroppedError) {
      this.renderCliPersistEvent(
        'session_persist_dropped',
        error.details,
        `session ${error.details.sessionId} was not persisted — the store dropped the write (${error.details.reason}).`,
        turnId,
      );
      return 1;
    }
    return null;
  }

  protected createApprovalHandler(args: {
    timeoutMs?: number;
    onDenied?: () => void;
  } = {}): ApprovalHandler {
    const { createCliApprovalHandler } = requireCliPlatformDeps();
    const handler = createCliApprovalHandler({
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      now: Date.now,
      jsonMode: this.json,
      ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
    });
    return async (request, signal) => {
      const decision = await handler(request, signal);
      if (!decision.approved) {
        args.onDenied?.();
      }
      return decision;
    };
  }

  protected buildEnvTurnOptions(turnId: string, args: { bypassSafety?: boolean } = {}): Pick<
    HeadlessTurnOptions,
    'bypassToolSafety'
  > | null {
    const bypassToolSafety = args.bypassSafety === true || process.env.REBEL_CLI_BYPASS_SAFETY === '1';
    if (bypassToolSafety) {
      emitSafetyBypassNotice({ mode: this.outputMode, turnId, stderr: this.context.stderr });
    }

    return {
      ...(bypassToolSafety ? { bypassToolSafety: true } : {}),
    };
  }
}

class SmokeTestCommand extends BaseCommand {
  static paths = [['smoke-test']];

  static usage = Command.Usage({
    category: 'Commands',
    description: 'Run a quick health check to verify the agent is working',
    details: `
      Verifies that Rebel can run a simple agent turn with your current settings.
      Checks workspace access and MCP configuration without starting a full session.

      Exit codes:
        0 - Smoke test passed (agent responded successfully)
        1 - Configuration error or runtime failure
    `,
    examples: [
      ['Run the default smoke test', 'rebel smoke-test'],
      ['Run with a custom prompt', 'rebel smoke-test --prompt "List files in my workspace"'],
      ['Get JSON output for CI/automation', 'rebel smoke-test --json']
    ]
  });

  prompt = Option.String('--prompt', {
    description: 'Custom prompt to use (default: checks workspace and MCP access)'
  });

  async execute(): Promise<number> {
    if (isStandaloneCli() && process.env.REBEL_STANDALONE_SMOKE_TEST === '1') {
      this.context.stdout.write('OK\n');
      return 0;
    }

    const { runHeadlessTurn } = this.runtime;
    const settings = await this.ensureSettings();

    if (!settings.coreDirectory) {
      this.context.stderr.write('Core directory is not configured.\n');
      return 1;
    }
    if (!hasValidAuth(settings)) {
      this.context.stderr.write(
        isStandaloneCli()
          ? `Authentication is missing: ${standaloneAuthHint(settings.activeProvider)}.\n`
          : 'Claude authentication is missing.\n',
      );
      return 1;
    }

    const prompt =
      this.prompt ??
      `Say "OK" if you can access the workspace at "${settings.coreDirectory}" and your MCP configuration.`;

    const turnId = `smoke-${randomUUID()}`;
    const state = { sawError: false, sawResult: false, printedAssistant: false, sawMeaningfulContent: false };
    const onEvent = createEventHandler(turnId, this.outputMode, state);
    const envOptions = this.buildEnvTurnOptions(turnId);
    if (!envOptions) {
      return 1;
    }

    await runHeadlessTurn({
      prompt,
      onEvent,
      options: {
        sessionType: 'cli',
        persistMode: { kind: 'none' },
        sessionId: `cli-smoke-${Date.now()}`,
        resetConversation: true,
        ...envOptions,
      },
    });

    if (state.sawError) {
      this.context.stderr.write('Smoke test failed: an error occurred.\n');
      return 1;
    }
    if (!state.sawResult) {
      this.context.stderr.write('Smoke test failed: no result event received.\n');
      return 1;
    }
    if (!state.sawMeaningfulContent) {
      this.context.stderr.write('Smoke test failed: no meaningful content produced.\n');
      return 1;
    }
    return 0;
  }
}

class RunCommand extends BaseCommand {
  static paths = [['run']];

  static usage = Command.Usage({
    category: 'Commands',
    description: 'Run a single agent turn and exit',
    details: `
      Sends a prompt to the agent, waits for the response, and exits.
      This is the primary command for scripting and automation.

      Output modes:
        Default - Human-readable: status/tool events on stderr, response on stdout
        --json  - Machine-readable: NDJSON events on stdout for parsing

      Profiling (--profile):
        Outputs timing metrics for performance analysis:
        - TTFT (Time To First Token): Time until first assistant content
        - Total duration: Full turn completion time
        - Cache metrics: Cache hit ratio and token counts

      Exit codes:
        0 - Turn completed successfully
        1 - Configuration error or agent error during turn
    `,
    examples: [
      ['Ask a simple question', 'rebel run -p "What files are in my workspace?"'],
      ['Summarize a file', 'rebel run --prompt "Summarize README.md"'],
      ['Get JSON output for scripting', 'rebel run -p "List my tasks" --json'],
      ['Profile turn performance', 'rebel run -p "Hello" --profile'],
      ['Profile with JSON output', 'rebel run -p "Hello" --profile --json'],
      ['Pipe output to another command', 'rebel run -p "Generate a haiku" 2>/dev/null | pbcopy']
    ]
  });

  prompt = Option.String('-p,--prompt', {
    description: 'The prompt to send to the agent',
    required: true
  });

  session = Option.String('--session', {
    description: 'Session ID for this turn'
  });

  legacySessionId = Option.String('--session-id', {
    description: 'Deprecated alias for --session'
  });

  reset = Option.Boolean('--reset', false, {
    description: 'Force a fresh conversation context'
  });

  profile = Option.Boolean('--profile', false, {
    description: 'Output timing and cache metrics for performance profiling'
  });

  model = Option.String('--model', {
    description: 'Override the working model for this turn'
  });

  thinking = Option.String('--thinking', {
    description: 'Override the thinking model for this turn'
  });

  noThinking = Option.Boolean('--no-thinking', false, {
    description: 'Suppress thinking model usage for this turn'
  });

  workingProfile = Option.String('--working-profile', {
    description: 'Override the working profile ID for this turn'
  });

  thinkingProfile = Option.String('--thinking-profile', {
    description: 'Override the thinking profile ID for this turn'
  });

  effort = Option.String<ThinkingEffort>('--effort', {
    description: 'Override thinking effort: low, medium, high, or xhigh',
    validator: t.isEnum(THINKING_EFFORT_VALUES)
  });

  council = Option.Boolean('--council', false, {
    description: 'Activate council mode for this turn'
  });

  unleashed = Option.Boolean('--unleashed', false, {
    description: 'Activate unleashed mode for this turn'
  });

  finishLine = Option.String('--finish-line', {
    description: 'Stop when this criterion is met. Example: --finish-line "the draft is ready to send"'
  });

  privateMode = Option.Boolean('--private', false, {
    description: 'Force cautious tool and memory safety for this turn'
  });

  bypassSafety = Option.Boolean('--bypass-safety', false, {
    description: 'Disable tool-safety, memory-write, and auto-continue safety hooks for this turn'
  });

  approvalTimeout = Option.String('--approval-timeout', {
    description: 'Timeout in milliseconds for interactive approval prompts'
  });

  provider = Option.String<ActiveProvider>('--provider', {
    description: 'Override provider for this turn: anthropic, openrouter, or codex',
    validator: t.isEnum(ACTIVE_PROVIDER_VALUES)
  });

  noMcp = Option.Boolean('--no-mcp', false, {
    description: 'Skip MCP/Super-MCP startup for this invocation'
  });

  attach = Option.Array('--attach', [], {
    description: 'Attach a file path to the turn; repeat for multiple files'
  });

  async execute(): Promise<number> {
    const { runHeadlessTurn } = this.runtime;
    const { loadAttachmentsFromPaths } = requireCliPlatformDeps();
    const settings = await this.ensureSettings();

    if (!settings.coreDirectory) {
      this.context.stderr.write('Core directory is not configured.\n');
      return 1;
    }
    if (this.session && this.legacySessionId) {
      this.context.stderr.write('Error: use either --session or --session-id, not both.\n');
      return 1;
    }
    if (this.thinking && this.noThinking) {
      this.context.stderr.write('Error: use either --thinking or --no-thinking, not both.\n');
      return 1;
    }
    if (this.council && this.provider === 'codex') {
      this.context.stderr.write('Error: --council cannot be combined with --provider codex.\n');
      return 1;
    }

    if (this.provider) {
      const validation = validateProviderFlag({
        provider: this.provider,
        rawSettings: settings,
        codexConnected: getCodexConnectedSnapshot(),
      });
      if (!validation.ok) {
        this.context.stderr.write(
          `Error: ${isStandaloneCli() ? standaloneAuthHint(this.provider) : validation.reason}\n`,
        );
        return 1;
      }
    } else if (!hasValidAuth(settings)) {
      this.context.stderr.write(
        isStandaloneCli()
          ? `Authentication is missing: ${standaloneAuthHint(settings.activeProvider)}.\n`
          : 'Claude authentication is missing.\n',
      );
      return 1;
    }

    if (this.legacySessionId) {
      this.context.stderr.write('Warning: --session-id is deprecated; use --session instead.\n');
    }

    const turnId = randomUUID();
    const state: EventHandlerState = {
      sawError: false,
      sawResult: false,
      printedAssistant: false,
      sawMeaningfulContent: false
    };

    // Initialize profiling state if --profile flag is set
    const profilingState: ProfilingState | undefined = this.profile
      ? {
          turnStartMs: Date.now(),
          firstEventMs: null,
          firstAssistantTokenMs: null,
          resultMs: null,
          resultEvent: null,
          model: null,
        }
      : undefined;

    const onEvent = createEventHandler(turnId, this.outputMode, state, profilingState);
    const envOptions = this.buildEnvTurnOptions(turnId, { bypassSafety: this.bypassSafety });
    if (!envOptions) {
      return 1;
    }
    const parsedApprovalTimeout = parseOptionalPositiveInteger(this.approvalTimeout);
    if (!parsedApprovalTimeout.ok) {
      this.context.stderr.write(`Error: --approval-timeout ${parsedApprovalTimeout.reason}\n`);
      return 2;
    }
    let approvalDenied = false;
    const approvalHandler = this.createApprovalHandler({
      timeoutMs: parsedApprovalTimeout.value,
      onDenied: () => {
        approvalDenied = true;
      },
    });

    let attachments: HeadlessTurnOptions['attachments'] | undefined;
    if (this.attach.length > 0) {
      try {
        attachments = await loadAttachmentsFromPaths(this.attach);
      } catch (error) {
        this.context.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }

    const sessionId = this.session ?? this.legacySessionId ?? `cli-session-${Date.now()}`;

    try {
      await runHeadlessTurn({
        prompt: this.prompt,
        onEvent,
        options: {
          sessionType: 'cli',
          persistMode: { kind: 'cli-session' },
          sessionId,
          resetConversation: this.reset,
          ...(attachments ? { attachments } : {}),
          ...(this.privateMode ? { privateMode: true } : {}),
          ...(this.model ? { modelOverride: this.model } : {}),
          ...(this.noThinking ? { thinkingModelOverride: '' } : {}),
          ...(!this.noThinking && this.thinking ? { thinkingModelOverride: this.thinking } : {}),
          ...(this.workingProfile ? { workingProfileOverrideId: this.workingProfile } : {}),
          ...(this.thinkingProfile ? { thinkingProfileOverrideId: this.thinkingProfile } : {}),
          ...(this.effort ? { thinkingEffortOverride: this.effort } : {}),
          ...(this.council ? { councilMode: true } : {}),
          ...(this.unleashed ? { unleashedMode: true } : {}),
          ...(this.finishLine ? { finishLine: normalizeFinishLine(this.finishLine) } : {}),
          ...(this.provider ? { activeProviderOverride: this.provider } : {}),
          approvalHandler,
          ...envOptions,
        },
      });
    } catch (error) {
      const exitCode = this.handleCliPersistError(error, turnId);
      if (exitCode !== null) return exitCode;
      throw error;
    }

    // Output profiling metrics if enabled
    if (this.profile && profilingState) {
      const metrics = computeProfilingMetrics(profilingState);

      if (this.outputMode === 'json') {
        // Output as NDJSON event consistent with other events
        const payload = {
          turnId,
          type: 'profile',
          timestamp: Date.now(),
          event: { metrics }
        };
        process.stdout.write(JSON.stringify(payload) + '\n');
      } else {
        // Human-readable profiling output
        const ttftStr = metrics.ttftMs !== null ? `${metrics.ttftMs}ms` : 'N/A';
        const totalStr = metrics.totalDurationMs !== null ? `${metrics.totalDurationMs}ms` : 'N/A';
        const cacheStr = `${metrics.cacheHitRatio.toFixed(1)}%`;
        const firstEventStr =
          metrics.timeToFirstEventMs !== null ? `${metrics.timeToFirstEventMs}ms` : 'N/A';

        process.stderr.write(
          `[profile] TTFT: ${ttftStr} | Total: ${totalStr} | Cache hit: ${cacheStr}\n`
        );
        process.stderr.write(
          `[profile] First event: ${firstEventStr} | In: ${metrics.inputTokens} | Out: ${metrics.outputTokens}\n`
        );
        if (metrics.model) {
          process.stderr.write(`[profile] Model: ${metrics.model}\n`);
        }
      }
    }

    return approvalDenied ? 2 : state.sawError ? 1 : 0;
  }
}

class ChatCommand extends BaseCommand {
  static paths = [['chat']];

  static usage = Command.Usage({
    category: 'Commands',
    description: 'Start an interactive multi-turn chat session',
    details: `
      Opens a REPL for back-and-forth conversation with Rebel.
      Conversation context is maintained within the session.

      REPL commands:
        :quit, :q  - Exit the chat session
        :reset     - Clear conversation context and start fresh

      Note: This command is interactive and will not exit until you type :quit.
      For automation, use the "run" command instead.
      The --json flag is not supported (would corrupt readline prompts).
    `,
    examples: [
      ['Start an interactive chat', 'rebel chat'],
      ['Chat with a named session', 'rebel chat --session my-project']
    ]
  });

  session = Option.String('--session', {
    description: 'Session ID for this chat (context maintained within session)'
  });

  legacySessionId = Option.String('--session-id', {
    description: 'Deprecated alias for --session'
  });

  model = Option.String('--model', {
    description: 'Override the working model for this chat'
  });

  thinking = Option.String('--thinking', {
    description: 'Override the thinking model for this chat'
  });

  noThinking = Option.Boolean('--no-thinking', false, {
    description: 'Suppress thinking model usage for this chat'
  });

  workingProfile = Option.String('--working-profile', {
    description: 'Override the working profile ID for this chat'
  });

  thinkingProfile = Option.String('--thinking-profile', {
    description: 'Override the thinking profile ID for this chat'
  });

  effort = Option.String<ThinkingEffort>('--effort', {
    description: 'Override thinking effort: low, medium, high, or xhigh',
    validator: t.isEnum(THINKING_EFFORT_VALUES)
  });

  council = Option.Boolean('--council', false, {
    description: 'Activate council mode for chat turns'
  });

  unleashed = Option.Boolean('--unleashed', false, {
    description: 'Activate unleashed mode for chat turns'
  });

  finishLine = Option.String('--finish-line', {
    description: 'Stop when this criterion is met. Persists across the chat session. Example: --finish-line "the draft is ready to send"'
  });

  privateMode = Option.Boolean('--private', false, {
    description: 'Force cautious tool and memory safety for chat turns'
  });

  bypassSafety = Option.Boolean('--bypass-safety', false, {
    description: 'Disable tool-safety, memory-write, and auto-continue safety hooks for chat turns'
  });

  approvalTimeout = Option.String('--approval-timeout', {
    description: 'Timeout in milliseconds for interactive approval prompts'
  });

  provider = Option.String<ActiveProvider>('--provider', {
    description: 'Override provider for chat turns: anthropic, openrouter, or codex',
    validator: t.isEnum(ACTIVE_PROVIDER_VALUES)
  });

  noMcp = Option.Boolean('--no-mcp', false, {
    description: 'Skip MCP/Super-MCP startup for this invocation'
  });

  attach = Option.Array('--attach', [], {
    description: 'Attach file paths to every chat turn; repeat for multiple files'
  });

  async execute(): Promise<number> {
    // Disallow --json for interactive chat (prompts would interleave with NDJSON)
    if (this.json) {
      this.context.stderr.write(
        'Error: --json is not supported with the interactive chat command\n'
      );
      return 1;
    }

    const { runHeadlessTurn } = this.runtime;
    const { loadAttachmentsFromPaths } = requireCliPlatformDeps();
    const settings = await this.ensureSettings();

    if (!settings.coreDirectory) {
      this.context.stderr.write('Core directory is not configured.\n');
      return 1;
    }
    if (this.session && this.legacySessionId) {
      this.context.stderr.write('Error: use either --session or --session-id, not both.\n');
      return 1;
    }
    if (this.thinking && this.noThinking) {
      this.context.stderr.write('Error: use either --thinking or --no-thinking, not both.\n');
      return 1;
    }
    if (this.council && this.provider === 'codex') {
      this.context.stderr.write('Error: --council cannot be combined with --provider codex.\n');
      return 1;
    }
    if (isStandaloneCli() && (this.provider ?? settings.activeProvider) === 'codex') {
      this.context.stderr.write(`Error: ${standaloneCodexChatError}\n`);
      return 1;
    }

    if (this.provider) {
      const validation = validateProviderFlag({
        provider: this.provider,
        rawSettings: settings,
        codexConnected: getCodexConnectedSnapshot(),
      });
      if (!validation.ok) {
        this.context.stderr.write(
          `Error: ${isStandaloneCli() ? standaloneAuthHint(this.provider) : validation.reason}\n`,
        );
        return 1;
      }
    } else if (!hasValidAuth(settings)) {
      this.context.stderr.write(
        isStandaloneCli()
          ? `Authentication is missing: ${standaloneAuthHint(settings.activeProvider)}.\n`
          : 'Claude authentication is missing.\n',
      );
      return 1;
    }

    if (this.legacySessionId) {
      this.context.stderr.write('Warning: --session-id is deprecated; use --session instead.\n');
    }

    let attachments: HeadlessTurnOptions['attachments'] | undefined;
    if (this.attach.length > 0) {
      try {
        attachments = await loadAttachmentsFromPaths(this.attach);
      } catch (error) {
        this.context.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      }
    }

    const sessionId = this.session ?? this.legacySessionId ?? `cli-chat-${randomUUID()}`;
    const envOptions = this.buildEnvTurnOptions(`chat-${sessionId}`, { bypassSafety: this.bypassSafety });
    if (!envOptions) {
      return 1;
    }
    const parsedApprovalTimeout = parseOptionalPositiveInteger(this.approvalTimeout);
    if (!parsedApprovalTimeout.ok) {
      this.context.stderr.write(`Error: --approval-timeout ${parsedApprovalTimeout.reason}\n`);
      return 2;
    }
    let approvalDenied = false;
    const approvalHandler = this.createApprovalHandler({
      timeoutMs: parsedApprovalTimeout.value,
      onDenied: () => {
        approvalDenied = true;
      },
    });
    const turnOptions = (resetConversation: boolean): HeadlessTurnOptions => {
      return {
        sessionType: 'cli',
        persistMode: { kind: 'cli-session' },
        sessionId,
        resetConversation,
        approvalHandler,
        ...(attachments ? { attachments } : {}),
        ...(this.privateMode ? { privateMode: true } : {}),
        ...(this.model ? { modelOverride: this.model } : {}),
        ...(this.noThinking ? { thinkingModelOverride: '' } : {}),
        ...(!this.noThinking && this.thinking ? { thinkingModelOverride: this.thinking } : {}),
        ...(this.workingProfile ? { workingProfileOverrideId: this.workingProfile } : {}),
        ...(this.thinkingProfile ? { thinkingProfileOverrideId: this.thinkingProfile } : {}),
        ...(this.effort ? { thinkingEffortOverride: this.effort } : {}),
        ...(this.council ? { councilMode: true } : {}),
        ...(this.unleashed ? { unleashedMode: true } : {}),
        ...(this.finishLine ? { finishLine: normalizeFinishLine(this.finishLine) } : {}),
        ...(this.provider ? { activeProviderOverride: this.provider } : {}),
        ...envOptions,
      };
    };

    this.context.stdout.write(
      `Starting chat session ${sessionId}. Type :quit to exit, :reset to reset the conversation.\n`
    );

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });

    const ask = (query: string) =>
      new Promise<string>((resolve) => {
        rl.question(query, resolve);
      });

    try {
       
      while (true) {
        const line = (await ask('rebel> ')).trim();
        if (!line) {
          continue;
        }
        if (line === ':quit' || line === ':q') {
          break;
        }
        if (line === ':reset') {
          this.context.stdout.write('Resetting conversation state.\n');
          const turnId = randomUUID();
          const state = { sawError: false, sawResult: false, printedAssistant: false, sawMeaningfulContent: false };
          const onEvent = createEventHandler(turnId, this.outputMode, state);
          approvalDenied = false;
          try {
            await runHeadlessTurn({
              prompt: 'Reset the conversation context but keep this session ID.',
              onEvent,
              options: turnOptions(true),
            });
          } catch (error) {
            const exitCode = this.handleCliPersistError(error, turnId);
            if (exitCode !== null) return exitCode;
            throw error;
          }
          if (approvalDenied) {
            this.context.stderr.write('Reset turn ended because approval was denied.\n');
          }
          continue;
        }

        const turnId = randomUUID();
        const state = { sawError: false, sawResult: false, printedAssistant: false, sawMeaningfulContent: false };
        const onEvent = createEventHandler(turnId, this.outputMode, state);
        approvalDenied = false;
        try {
          await runHeadlessTurn({
            prompt: line,
            onEvent,
            options: turnOptions(false),
          });
        } catch (error) {
          const exitCode = this.handleCliPersistError(error, turnId);
          if (exitCode !== null) return exitCode;
          throw error;
        }

        if (approvalDenied) {
          this.context.stderr.write('Last turn ended because approval was denied.\n');
        }
        if (state.sawError) {
          this.context.stderr.write('Last turn ended with an error.\n');
        }
      }
    } finally {
      rl.close();
    }

    return 0;
  }
}

class SessionsListCommand extends BaseCommand {
  static paths = [['sessions', 'list']];

  limit = Option.String('--limit', {
    description: 'Maximum number of sessions to print',
  });

  filter = Option.String('--filter', {
    description: 'Filter sessions by ID, title, or preview text',
  });

  async execute(): Promise<number> {
    const store = this.sessionStore;
    if (!store) {
      this.context.stderr.write('Session store is not available.\n');
      return 1;
    }

    const parsedLimit = parsePositiveInteger(this.limit, 50);
    if (!parsedLimit.ok) {
      this.context.stderr.write(`Error: ${parsedLimit.reason}\n`);
      return 1;
    }

    const query = this.filter?.trim().toLowerCase();
    const sessions = store
      .listSessions()
      .filter((session) => !query || sessionMatchesFilter(session, query))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, parsedLimit.value);

    if (this.json) {
      this.context.stdout.write(JSON.stringify(sessions) + '\n');
      return 0;
    }

    this.context.stdout.write(formatSessionsTable(sessions));
    return 0;
  }
}

class SessionsShowCommand extends BaseCommand {
  static paths = [['sessions', 'show']];

  id = Option.String({ required: true });

  async execute(): Promise<number> {
    const store = this.sessionStore;
    if (!store) {
      this.context.stderr.write('Session store is not available.\n');
      return 1;
    }

    const session = await store.getSession(this.id);
    if (!session) {
      this.context.stderr.write(`Session not found: ${this.id}\n`);
      return 1;
    }

    if (this.json) {
      this.context.stdout.write(JSON.stringify(session) + '\n');
      return 0;
    }

    this.context.stdout.write(formatSessionTranscript(session));
    return 0;
  }
}

class SessionsTailCommand extends BaseCommand {
  static paths = [['sessions', 'tail']];

  id = Option.String({ required: true });

  intervalMs = Option.String('--interval-ms', {
    description: 'Polling interval in milliseconds',
  });

  async execute(): Promise<number> {
    const store = this.sessionStore;
    if (!store) {
      this.context.stderr.write('Session store is not available.\n');
      return 1;
    }

    const parsedInterval = parsePositiveInteger(this.intervalMs, 1_000);
    if (!parsedInterval.ok) {
      this.context.stderr.write(`Error: ${parsedInterval.reason}\n`);
      return 1;
    }

    let session = await store.getSession(this.id);
    if (!session) {
      this.context.stderr.write(`Session not found: ${this.id}\n`);
      return 1;
    }

    let lastMessageCount = session.messages.length;
    let lastUpdatedAt = session.updatedAt ?? 0;
    let lastMtimeMs = await getSessionMtimeMs(store, this.id);
    let stopped = false;
    const stop = (): void => {
      stopped = true;
    };
    const tailAbortSignal = this.runtime.tailAbortSignal;
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    tailAbortSignal?.addEventListener('abort', stop, { once: true });

    try {
      while (!stopped) {
        await delay(parsedInterval.value);
        if (stopped) break;
        const nextMtimeMs = await getSessionMtimeMs(store, this.id);
        // mtime is a cheap hint only; coarse filesystems can repeat the same mtime
        // across two writes. Always re-read and compare updatedAt + messageCount so
        // sub-second writes are not missed.
        const fastPath = nextMtimeMs === lastMtimeMs;
        session = await store.getSession(this.id);
        if (!session) {
          this.context.stderr.write(`Session not found: ${this.id}\n`);
          return 1;
        }
        const nextUpdatedAt = session.updatedAt ?? 0;
        const nextMessageCount = session.messages.length;
        if (fastPath && nextUpdatedAt === lastUpdatedAt && nextMessageCount === lastMessageCount) {
          continue;
        }
        lastMtimeMs = nextMtimeMs;
        lastUpdatedAt = nextUpdatedAt;
        const newMessages = session.messages.slice(lastMessageCount);
        lastMessageCount = nextMessageCount;
        if (newMessages.length === 0) {
          continue;
        }
        if (this.json) {
          for (const message of newMessages) {
            this.context.stdout.write(JSON.stringify(message) + '\n');
          }
        } else {
          this.context.stdout.write(formatMessages(newMessages));
        }
      }
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      tailAbortSignal?.removeEventListener('abort', stop);
    }

    return 0;
  }
}

/**
 * MCP Server Command
 *
 * CRITICAL: This extends Command directly (NOT BaseCommand) to avoid
 * the --json flag which could pollute stdout. MCP protocol requires
 * stdout to be ONLY JSON-RPC messages.
 */
class McpServerCommand extends Command {
  static paths = [['mcp-server']];

  static usage = Command.Usage({
    category: 'Commands',
    description: 'Run Rebel as an MCP server for external tool integration',
    details: `
      Starts Rebel as a long-running MCP server using stdio transport.
      This allows external MCP clients (Cursor, Claude Desktop, VS Code)
      to invoke Rebel's agent capabilities.

      Prerequisites:
        1. Enable "Allow external MCP access" in Rebel Settings > Connectors
        2. Configure your MCP client to spawn this command

      This command is designed to be spawned by MCP clients - you typically
      won't run it directly. Tool/memory safety prompts are auto-approved
      since the user has opted in by enabling MCP server mode.

      Exit codes:
        0 - Server shut down gracefully (SIGTERM/SIGINT)
        1 - Configuration error (missing settings or MCP not enabled)
    `,
    examples: [
      ['Start MCP server (usually spawned by client)', 'rebel mcp-server'],
      [
        'Example MCP client config (Claude Desktop)',
        '{"command": "/Applications/Rebel.app/Contents/MacOS/Rebel", "args": ["--headless-cli", "mcp-server"]}'
      ]
    ]
  });

  async execute(): Promise<number> {
    const { appVersion, runHeadlessTurn, getSettings } = requireDeps();
    const { startMcpServer } = requireCliPlatformDeps();

    // Set MCP server mode environment variable BEFORE starting the server.
    // This is checked by tool safety and memory safety hooks to auto-approve
    // all operations (user has opted in by enabling MCP server mode).
    process.env.REBEL_MCP_SERVER_MODE = '1';

    try {
      // startMcpServer never returns normally - it runs until SIGTERM/SIGINT
      await startMcpServer({
        version: appVersion,
        runHeadlessTurn,
        getSettings
      });
      return 0;
    } catch (error) {
      // CRITICAL: Log only to stderr
      process.stderr.write(
        `[rebel-mcp-server] Fatal error: ${error instanceof Error ? error.message : String(error)}\n`
      );
      return 1;
    }
  }
}

function parsePositiveInteger(
  raw: string | undefined,
  fallback: number,
): { ok: true; value: number } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true, value: fallback };
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return { ok: false, reason: 'expected a positive integer' };
  }
  return { ok: true, value };
}

function parseOptionalPositiveInteger(
  raw: string | undefined,
): { ok: true; value?: number } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true };
  const parsed = parsePositiveInteger(raw, 1);
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value };
}

function sessionMatchesFilter(session: AgentSessionSummary, query: string): boolean {
  return [
    session.id,
    session.title,
    session.preview,
  ].some((value) => value?.toLowerCase().includes(query));
}

function formatSessionsTable(sessions: AgentSessionSummary[]): string {
  const lines = ['id\tupdatedAt\tmessageCount\ttitle'];
  for (const session of sessions) {
    lines.push([
      session.id,
      new Date(session.updatedAt).toISOString(),
      String(session.messageCount),
      (session.title ?? 'Untitled').replace(/\s+/g, ' '),
    ].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

function formatSessionTranscript(session: AgentSession): string {
  return [
    `Session: ${session.id}`,
    `Title: ${session.title}`,
    '',
    formatMessages(session.messages),
  ].join('\n');
}

function formatMessages(messages: AgentSession['messages']): string {
  return messages
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
    .join('\n\n') + (messages.length > 0 ? '\n' : '');
}

async function getSessionMtimeMs(store: IncrementalSessionStore, sessionId: string): Promise<number | null> {
  try {
    const stat = await fs.stat(store.getSessionFilePath(sessionId));
    return stat.mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const runCli = async (argv?: string[]): Promise<number> => {
  const { appVersion } = requireDeps();

  const cli = new Cli({
    binaryLabel: 'Mindstone Rebel CLI',
    binaryName: 'rebel',
    binaryVersion: appVersion
  });

  // Register built-in help and version commands
  cli.register(Builtins.HelpCommand);
  cli.register(Builtins.VersionCommand);

  // Register application commands
  cli.register(SmokeTestCommand);
  cli.register(RunCommand);
  cli.register(ChatCommand);
  cli.register(SessionsListCommand);
  cli.register(SessionsShowCommand);
  cli.register(SessionsTailCommand);
  cli.register(McpServerCommand);

  const { args } = stripNoMcpFlags(normalizeCliArgs(argv ?? process.argv.slice(2)));

  const exitCode = await cli.run(args);
  return exitCode;
};
