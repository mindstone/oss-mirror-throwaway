import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getAssetStore } from '@core/assetStore';
import { createScopedLogger } from '@core/logger';
import { materializeImageRefsForEvent } from '@core/services/imageAssetMaterialization';
import {
  APP_NAVIGATION_DESTINATIONS,
  APP_NAVIGATION_DESTINATION_SURFACES,
  type AppNavigationErrorCode,
} from '@core/appNavigationService';
import { getSettings, updateSettings } from '@core/services/settingsStore';
import type { CaptureErrorCode, CaptureMode } from '@core/screenshotCaptureService';
import { killProcessTreeGracefully } from '@core/utils/processKill';
import {
  MATERIALIZATION_SIZE_CAP_BYTES,
  MATERIALIZATION_THRESHOLD_CHARS,
  materializeBuiltinBashOutput,
  materializeBuiltinToolOutput,
} from '@core/utils/builtinToolMaterialization';
import {
  FILE_TYPE_HEADER_BYTES,
  detectImageMimeType,
  isBinaryHeader,
  parseImageDimensions,
} from '@core/utils/fileTypeDetection';
import { sliceHeadByUtf8Bytes } from '@core/services/contentTruncation';
import {
  ANTHROPIC_IMAGE_BYTE_LIMIT,
  IMAGE_HARD_DIMENSION_LIMIT,
} from '@shared/attachmentLimits';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { SETTINGS_TABS, type SettingsTabId } from '@shared/navigation/types';
import { redactSensitiveString } from '@shared/utils/sentryRedaction';
import type {
  BuiltinToolContext,
  BuiltinToolName,
  ToolExecutionResult,
} from './types';
import type { ToolDefinition } from './modelTypes';
import type {
  RebelCoreTask,
  RebelCoreTaskStatus,
  RebelCoreTaskStoreInternal,
} from './taskState';
import { WEB_FETCH_TOOL_DEFINITION, executeWebFetch } from './tools/webFetchTool';
import { WEB_SEARCH_TOOL_DEFINITION, executeWebSearch } from './tools/webSearchTool';
import { SEARCH_FILES_TOOL_DEFINITION, executeSearchFiles } from './tools/searchFilesTool';
import { GLOB_TOOL_DEFINITION, executeGlob } from './tools/globTool';
import { LS_TOOL_DEFINITION, executeLs } from './tools/lsTool';
import { canonicalizeZoneRoot, verifyNoSymlinkEscape } from './tools/zoneSafety';

export { canonicalizeZoneRoot, verifyNoSymlinkEscape };
import {
  REBEL_MEETINGS_LIVE_TRANSCRIPT_TOOL_DEFINITION,
  executeLiveMeetingTranscriptTool,
} from './tools/liveMeetingTranscriptTool';
import {
  GET_TOOL_CALL_TOOL_DEFINITION,
  INSPECT_PRIOR_TURNS_TOOL_DEFINITION,
  executeGetToolCall,
  executeInspectPriorTurns,
} from '@core/services/priorTurnsTools';
import { runOperatorConsultTool } from './operatorConsultTool';
import {
  resolveToolPath,
  type ToolKind,
  type ToolPathResolution,
} from './toolPathResolver';
import { detectProtectedMcpConfigAccess } from '@core/services/safety/bashProtectedPathGuard';

const DEFAULT_BASH_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 100_000;
const MISSION_OWNER = 'mission';
const MAIN_NAMESPACE = 'main';

export type MissionContextKey = 'goal' | 'done_criteria' | 'constraints';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value);

const formatError = (toolName: BuiltinToolName, error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return `${toolName} failed: ${message}`;
};

const getRequiredString = (
  input: Record<string, unknown>,
  key: string,
  options: { allowEmpty?: boolean } = {},
): string => {
  const value = input[key];
  if (typeof value !== 'string') {
    throw new Error(`Missing required string field: ${key}`);
  }

  if (!options.allowEmpty && value.trim().length === 0) {
    throw new Error(`Missing required string field: ${key}`);
  }

  return value;
};

const getOptionalInteger = (input: Record<string, unknown>, key: string): number | undefined => {
  const value = input[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
};

const getOptionalString = (input: Record<string, unknown>, key: string): string | undefined => {
  const value = input[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${key} must be a string`);
  }
  return value;
};

const getOptionalPositiveInteger = (input: Record<string, unknown>, key: string): number | undefined => {
  const value = input[key];
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
};

const getOptionalStringArray = (input: Record<string, unknown>, key: string): string[] | undefined => {
  const value = input[key];
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value;
};

const getOptionalTaskStatus = (input: Record<string, unknown>, key: string): RebelCoreTaskStatus | undefined => {
  const value = input[key];
  if (value == null) {
    return undefined;
  }
  if (value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'blocked') {
    return value;
  }
  throw new Error(`${key} must be one of: pending, in_progress, completed, blocked`);
};

const getOptionalPriority = (
  input: Record<string, unknown>,
  key: string,
): RebelCoreTask['priority'] | undefined => {
  const value = input[key];
  if (value == null) {
    return undefined;
  }
  if (value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }
  throw new Error(`${key} must be one of: high, medium, low`);
};

const resolveWorkspaceRoot = (cwd?: string): string => path.resolve(cwd ?? process.cwd());

const fileToolLog = createScopedLogger({ service: 'builtin-file-tool' });
const visualVerificationToolLog = createScopedLogger({ service: 'builtin-visual-verification-tools' });
const imageMaterializationLog = createScopedLogger({ service: 'builtin-image-materialization' });

/**
 * Resolve and validate a file path for Read / Write / Edit built-ins.
 * Delegates to {@link resolveToolPath} and emits structured observability
 * logs so that mcp-project-exception allows and allowlist misses are
 * visible in diagnostics. On rejection, throws with the resolver's
 * human-readable error message so the tool returns isError=true with
 * a clear explanation the agent can surface to the user.
 */
const resolveValidatedPath = (
  filePath: string,
  cwd: string | undefined,
  tool: ToolKind,
  homePath?: string,
): string => {
  const resolution: ToolPathResolution = resolveToolPath(filePath, {
    ...(cwd ? { cwd } : {}),
    ...(homePath ? { homePath } : {}),
    tool,
  });

  if (!resolution.ok) {
    if (resolution.reason === 'mcp-allowlist-miss') {
      fileToolLog.warn(
        { tool, filePath, reason: resolution.reason },
        'Rejected file-tool write inside ~/mcp-servers/ — path did not match MCP project shape allowlist',
      );
    }
    throw new Error(resolution.error);
  }

  if (resolution.allowReason === 'mcp-project') {
    fileToolLog.debug(
      { tool, resolvedPath: resolution.resolvedPath, reason: 'mcp-project-exception' },
      'File-tool path allowed via MCP project sandbox exception',
    );
  }

  return resolution.resolvedPath;
};

const truncateOutput = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) {
    return text;
  }
  const hiddenChars = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[output truncated: ${hiddenChars} more characters]`;
};

const sliceFileByLines = (content: string, offset?: number, limit?: number): string => {
  if (offset == null && limit == null) {
    return content;
  }

  const lines = content.split('\n');
  const safeOffset = offset ?? 0;
  const endIndex = limit == null ? lines.length : safeOffset + limit;
  return lines.slice(safeOffset, endIndex).join('\n');
};

/**
 * Friendly per-tool byte cap for large TEXT reads. Below Stage 1's universal
 * 200 KiB backstop so Read produces the helpful offset/limit guidance (and a
 * recoverable materialised file) BEFORE the deterministic boundary cap kicks in.
 */
const READ_TEXT_BYTE_CAP = 128 * 1024;

/**
 * Per-image guard, measured on the ENCODED base64 string (NOT decoded file
 * bytes). Anthropic's documented limit (`ANTHROPIC_IMAGE_BYTE_LIMIT`, 5 MiB) is
 * enforced on `image.source.base64`, and base64 inflates ~33%, so a ~3.75 MiB
 * decoded image already exceeds it. Gating on decoded size (the previous bug)
 * let a 4–5 MiB image through as oversized base64, which the provider rejects.
 *
 * We cheaply PRE-CHECK the decoded size against this derived threshold to avoid
 * base64-encoding obviously-oversized files, then enforce the real limit on the
 * actual encoded length. Above the limit (or over the dimension ceiling) we
 * return a placeholder + a recoverable on-disk reference instead of a vision
 * block.
 */
const READ_IMAGE_ENCODED_BYTE_CAP = ANTHROPIC_IMAGE_BYTE_LIMIT;
/** Decoded bytes that base64-encode to exactly the encoded cap (4/3 ratio). */
const READ_IMAGE_DECODED_PRECHECK_BYTES = Math.floor((READ_IMAGE_ENCODED_BYTE_CAP * 3) / 4);
/** Exact encoded length of `n` decoded bytes (base64 incl. `=` padding). */
const base64EncodedByteLength = (decodedBytes: number): number =>
  4 * Math.ceil(decodedBytes / 3);

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
};

const runReadTool = async (
  input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> => {
  try {
    if (!isRecord(input)) {
      throw new Error('Input must be an object');
    }

    const filePath = getRequiredString(input, 'file_path');
    const offset = getOptionalInteger(input, 'offset');
    const limit = getOptionalInteger(input, 'limit');

    const resolvedPath = resolveValidatedPath(filePath, context.cwd, 'Read', context.homePath);
    await verifyNoSymlinkEscape(resolvedPath, { cwd: context.cwd, homePath: context.homePath, allowedSymlinkTargets: context.allowedSymlinkTargets });

    const baseName = path.basename(resolvedPath);

    // Open a handle and read ONLY a small header first, so we never fully decode
    // a multi-MB binary/image just to classify it.
    const handle = await fs.open(resolvedPath, 'r');
    let fileSizeBytes: number;
    let headerLength: number;
    const headerBuf = Buffer.alloc(FILE_TYPE_HEADER_BYTES);
    try {
      const stat = await handle.stat();
      fileSizeBytes = stat.size;
      const { bytesRead } = await handle.read(headerBuf, 0, FILE_TYPE_HEADER_BYTES, 0);
      headerLength = bytesRead;
    } finally {
      await handle.close();
    }
    const header = headerBuf.subarray(0, headerLength);

    // ── (a) IMAGE ─────────────────────────────────────────────────────────
    const imageMimeType = detectImageMimeType(header);
    if (imageMimeType) {
      const oversizePlaceholder = (reason: string): ToolExecutionResult => ({
        output:
          `[image file: ${baseName}, ${imageMimeType}, ${formatBytes(fileSizeBytes)}; `
          + `${reason} — the image remains on disk at the path you read]`,
        isError: false,
        outputChars: fileSizeBytes,
      });

      // Pre-check on DECODED size: skip base64-encoding a file that cannot
      // possibly fit under the encoded limit. (This is cheap and avoids a big
      // allocation; the authoritative check below is on the encoded length.)
      if (fileSizeBytes > READ_IMAGE_DECODED_PRECHECK_BYTES) {
        return oversizePlaceholder(
          `too large to view inline (base64 would exceed the `
          + `${formatBytes(READ_IMAGE_ENCODED_BYTE_CAP)} provider limit)`,
        );
      }

      // Read the full bytes once: needed both for dimension parsing and the
      // (in-cap) base64 payload.
      const imageBytes = await fs.readFile(resolvedPath);

      // Dimension guard: an image past the provider's hard pixel ceiling is
      // rejected regardless of byte size. Best-effort parse from the header —
      // null (unparseable) is treated as "unknown", NOT a hard fail (the byte
      // cap remains the primary guard). See attachmentLimits.IMAGE_HARD_DIMENSION_LIMIT.
      const dimensions = parseImageDimensions(imageBytes, imageMimeType);
      if (
        dimensions
        && (dimensions.width > IMAGE_HARD_DIMENSION_LIMIT
          || dimensions.height > IMAGE_HARD_DIMENSION_LIMIT)
      ) {
        return oversizePlaceholder(
          `dimensions ${dimensions.width}x${dimensions.height}px exceed the `
          + `${IMAGE_HARD_DIMENSION_LIMIT}px provider limit`,
        );
      }

      // Authoritative ENCODED-size guard: Anthropic enforces its limit on the
      // base64 string, which inflates ~33% over the decoded bytes. Gate on the
      // encoded length so a 4–5 MiB image is never sent as oversized base64.
      const encodedBytes = base64EncodedByteLength(imageBytes.length);
      if (encodedBytes > READ_IMAGE_ENCODED_BYTE_CAP) {
        return oversizePlaceholder(
          `base64-encoded size ${formatBytes(encodedBytes)} exceeds the `
          + `${formatBytes(READ_IMAGE_ENCODED_BYTE_CAP)} provider limit`,
        );
      }

      // Return a vision content block. The agentLoop boundary gates this on the
      // active model's `supportsImageContent`: a vision model SEES the image; a
      // non-vision model gets a text placeholder substituted
      // (buildModelFacingToolResultContent) — never raw bytes, never a provider
      // error. So Read does not need to know vision capability.
      return {
        output: `[image file: ${baseName}, ${imageMimeType}, ${formatBytes(fileSizeBytes)}]`,
        isError: false,
        imageContent: [
          {
            type: 'image',
            data: imageBytes.toString('base64'),
            mimeType: imageMimeType,
          },
        ],
      };
    }

    // ── (b) OTHER BINARY ──────────────────────────────────────────────────
    if (isBinaryHeader(header)) {
      return {
        output:
          `[binary file: ${baseName}, ${formatBytes(fileSizeBytes)}; `
          + `not a UTF-8 text file and not a supported image — raw bytes omitted; `
          + `the file remains on disk at the path you read]`,
        isError: false,
        outputChars: fileSizeBytes,
      };
    }

    // ── (c) TEXT ──────────────────────────────────────────────────────────
    const fileContents = await fs.readFile(resolvedPath, 'utf8');
    const sliced = sliceFileByLines(fileContents, offset, limit);
    const slicedBytes = Buffer.byteLength(sliced, 'utf8');

    if (slicedBytes <= READ_TEXT_BYTE_CAP) {
      return {
        output: sliced,
        isError: false,
      };
    }

    // Large text: return a UTF-8-safe head slice + offset/limit guidance, and
    // materialise the full sliced content (best-effort) so it is recoverable.
    const head = sliceHeadByUtf8Bytes(sliced, READ_TEXT_BYTE_CAP);
    const omittedBytes = slicedBytes - Buffer.byteLength(head, 'utf8');
    const materialised = context.cwd
      ? await materializeBuiltinToolOutput({
        filenamePrefix: 'read',
        content: sliced,
        ext: path.extname(baseName).replace(/^\./, '') || 'txt',
        workspacePath: context.cwd,
      }).catch((error: unknown) => {
        ignoreBestEffortCleanup(error, {
          operation: 'runReadTool.materializeLargeText',
          reason: 'Recoverable-file write is optional; fall back to offset/limit guidance.',
        });
        return null;
      })
      : null;
    const recoveryHint = materialised
      ? ` Full content saved to ${materialised.relativePath} — Read it with offset/limit or Grep it.`
      : ` Re-read with offset/limit to page through the rest.`;
    return {
      output:
        `${head}\n\n[output truncated: ${omittedBytes} bytes omitted of ${slicedBytes} total.`
        + `${recoveryHint}]`,
      isError: false,
      outputChars: slicedBytes,
    };
  } catch (error) {
    return {
      output: formatError('Read', error),
      isError: true,
    };
  }
};

const runWriteTool = async (
  input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> => {
  try {
    if (!isRecord(input)) {
      throw new Error('Input must be an object');
    }

    const filePath = getRequiredString(input, 'file_path');
    const content = getRequiredString(input, 'content', { allowEmpty: true });
    const resolvedPath = resolveValidatedPath(filePath, context.cwd, 'Write', context.homePath);
    await verifyNoSymlinkEscape(resolvedPath, { cwd: context.cwd, homePath: context.homePath, allowedSymlinkTargets: context.allowedSymlinkTargets });
    const existedBeforeWrite = await fs.access(resolvedPath)
      .then(() => true, () => false);

    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, content, 'utf8');
    context.onFileChanged?.(resolvedPath);

    return {
      output: `${existedBeforeWrite ? 'Updated' : 'Created'} ${content.length} characters to ${resolvedPath}`,
      isError: false,
    };
  } catch (error) {
    return {
      output: formatError('Write', error),
      isError: true,
    };
  }
};

const countOccurrences = (haystack: string, needle: string): number => {
  if (needle.length === 0) {
    return 0;
  }

  let count = 0;
  let startIndex = 0;

  while (true) {
    const index = haystack.indexOf(needle, startIndex);
    if (index === -1) {
      return count;
    }
    count += 1;
    startIndex = index + needle.length;
  }
};

const runEditTool = async (
  input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> => {
  try {
    if (!isRecord(input)) {
      throw new Error('Input must be an object');
    }

    const filePath = getRequiredString(input, 'file_path');
    const oldString = getRequiredString(input, 'old_str');
    const newString = getRequiredString(input, 'new_str', { allowEmpty: true });

    if (oldString.length === 0) {
      throw new Error('old_str must not be empty');
    }

    const resolvedPath = resolveValidatedPath(filePath, context.cwd, 'Edit', context.homePath);
    await verifyNoSymlinkEscape(resolvedPath, { cwd: context.cwd, homePath: context.homePath, allowedSymlinkTargets: context.allowedSymlinkTargets });
    const fileContents = await fs.readFile(resolvedPath, 'utf8');
    const occurrences = countOccurrences(fileContents, oldString);

    if (occurrences === 0) {
      throw new Error('old_str was not found in file');
    }
    if (occurrences > 1) {
      throw new Error('old_str must match exactly once');
    }

    const updatedContents = fileContents.replace(oldString, newString);
    await fs.writeFile(resolvedPath, updatedContents, 'utf8');
    context.onFileChanged?.(resolvedPath);

    return {
      output: `Edited ${resolvedPath}`,
      isError: false,
    };
  } catch (error) {
    return {
      output: formatError('Edit', error),
      isError: true,
    };
  }
};

interface BashOutputParts {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  totalChars: number;
}

const formatBashOutput = (
  stdout: string,
  stderr: string,
  exitCode: number | null,
): BashOutputParts => ({
  stdout,
  stderr,
  exitCode,
  totalChars: stdout.length + stderr.length,
});

const formatBashOutputAsString = (
  parts: BashOutputParts,
  maxChars: number,
): string => {
  const sections: string[] = [];

  if (parts.stdout.length > 0) {
    sections.push(`stdout:\n${parts.stdout}`);
  }

  if (parts.stderr.length > 0) {
    sections.push(`stderr:\n${parts.stderr}`);
  }

  sections.push(`exit_code: ${parts.exitCode ?? 'null'}`);

  return truncateOutput(sections.join('\n\n'), maxChars);
};

const BASH_CLOSE_AFTER_KILL_MS = 5_000;
const BASH_COMMAND_PREVIEW_LENGTH = 120;
const bashLog = createScopedLogger({ service: 'bash-tool' });
const bashMaterializationLog = createScopedLogger({ service: 'rebelCore.bash.materialization' });

/**
 * Extract structural flags from a shell command for safe diagnostic logging.
 * These are approximate character-level heuristics — they reveal the command's
 * shape without exposing secrets or content. Not a shell parser.
 */
function getBashCommandFlags(command: string): {
  hasPipe: boolean;
  hasRedirect: boolean;
  hasBackground: boolean;
  hasFindExec: boolean;
  hasSubshell: boolean;
} {
  return {
    hasPipe: /(^|[^|])\|([^|]|$)/.test(command),
    hasRedirect: /[<>]/.test(command),
    hasBackground: /(?<![&\d])&\s*$/.test(command),
    hasFindExec: /find\b.*-exec\b/.test(command),
    hasSubshell: command.includes('$(') || command.includes('`'),
  };
}

/**
 * Create a redacted command preview safe for logging.
 * Uses the shared redactSensitiveString() as baseline (covers 13+ credential formats),
 * then applies shell-specific patterns and truncates.
 */
function redactCommandForLog(command: string): string {
  let redacted = redactSensitiveString(command);
  // Shell-specific: CLI auth flags (--password value, -u user:pass)
  redacted = redacted.replace(/--(password|passwd|token|secret)\s+\S+/gi, '--$1 [REDACTED]');
  redacted = redacted.replace(/-u\s+\S+:\S+/g, '-u [REDACTED]');
  // Shell-specific: env var assignments with secret-like names
  redacted = redacted.replace(/\b\w*(?:TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL)\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '[ENV_REDACTED]');
  // Truncate to first line, then to max length
  const firstLine = redacted.split('\n')[0];
  if (firstLine.length > BASH_COMMAND_PREVIEW_LENGTH) {
    return firstLine.slice(0, BASH_COMMAND_PREVIEW_LENGTH) + '...';
  }
  return firstLine + (redacted.includes('\n') ? ' [multiline]' : '');
}

const runBashTool = async (
  input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> => {
  if (context.signal?.aborted) {
    return {
      output: 'Bash failed: command aborted before execution',
      isError: true,
    };
  }

  try {
    if (!isRecord(input)) {
      throw new Error('Input must be an object');
    }

    const command = getRequiredString(input, 'command');

    // Pre-spawn guard: block commands that reference MCP config/credential files.
    // See docs-private/investigations/260502_mailchimp_unauthorized_campaign_creation.md
    const protectedPathResult = detectProtectedMcpConfigAccess(command, {
      homePath: context.homePath,
      userDataPath: context.userDataPath,
    });
    if (protectedPathResult.blocked) {
      bashLog.warn(
        { matchedPattern: protectedPathResult.matchedPattern },
        'Bash command blocked by protected path guard',
      );
      return {
        output: `Bash failed: ${protectedPathResult.reason}. ` +
          'Access to MCP configuration and credential files is not permitted from Bash commands.',
        isError: true,
      };
    }

    const timeoutSeconds = getOptionalInteger(input, 'timeout');
    const timeoutMs = timeoutSeconds != null
      ? Math.max(1_000, timeoutSeconds * 1_000)
      : context.defaultTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS;
    const maxOutputChars = context.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;

    const workspaceRoot = resolveWorkspaceRoot(context.cwd);
    const isWindows = process.platform === 'win32';
    const child = spawn(command, {
      cwd: workspaceRoot,
      env: process.env,
      shell: true,
      windowsHide: true,
      // Explicitly ignore stdin and pipe stdout/stderr. Without this, spawn
      // defaults to inheriting/duplicating the parent's fd0, which can throw
      // `spawn EBADF` when the parent's stdin descriptor is in a bad state at
      // fork time (e.g. headless/packaged main process). Every other spawn
      // callsite in the repo sets stdio explicitly for the same reason. The
      // command never reads stdin, and stdout/stderr stay piped so the
      // child.stdout/stderr handlers below still capture output. (REBEL-66M)
      stdio: ['ignore', 'pipe', 'pipe'],
      // On POSIX, detached creates a new process group (setsid), enabling
      // process.kill(-pid) to terminate the entire tree including children
      // that survive shell SIGTERM (e.g., commands with redirects or pipes).
      detached: !isWindows,
    });

    const pid = child.pid;
    const cmdFlags = getBashCommandFlags(command);
    bashLog.debug(
      { pid, commandLength: command.length, timeoutMs, ...cmdFlags, preview: redactCommandForLog(command) },
      'Bash command started',
    );

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let killed = false;

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    // Track both exit and close events. The close event is preferred (waits
    // for stdio), but exit is used as a fallback after kill to prevent hangs
    // when surviving descendants hold stdio FDs open.
    let exitFired = false;
    let closeFired = false;
    const exitPromise = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        exitFired = true;
        resolve(code);
      });
    });

    let killedAt: number | undefined;
    const killTree = async () => {
      if (killed || !pid) return;
      killed = true;
      killedAt = Date.now();
      await killProcessTreeGracefully(pid, {
        gracePeriodMs: 3_000,
        onEscalated: () => bashLog.debug({ pid }, 'Escalated to SIGKILL'),
      });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      fireAndForget(killTree(), 'builtinTools.bash.timeoutKillTree');
    }, timeoutMs);

    const abortHandler = () => {
      aborted = true;
      fireAndForget(killTree(), 'builtinTools.bash.abortKillTree');
    };

    context.signal?.addEventListener('abort', abortHandler, { once: true });

    let exitCode: number | null;
    try {
      exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => {
          closeFired = true;
          resolve(code);
        });

        // Safety net: after the process tree is killed, wait BASH_CLOSE_AFTER_KILL_MS
        // for close to fire (allows stdio to drain). If close doesn't arrive within
        // that window after kill, fall back to the exit code. This prevents the
        // infinite hang caused by surviving descendants holding stdio FDs open.
        if (pid) {
          const checkStuck = setInterval(() => {
            if (killed && exitFired && !closeFired && killedAt) {
              const elapsed = Date.now() - killedAt;
              if (elapsed >= BASH_CLOSE_AFTER_KILL_MS) {
                clearInterval(checkStuck);
                bashLog.warn(
                  { pid, timedOut, aborted, elapsedSinceKill: elapsed },
                  'Bash close event not received after kill — resolving via exit event (stdio leak)',
                );
                exitPromise.then(resolve, reject);
              }
            }
          }, 1_000);
          child.once('close', () => clearInterval(checkStuck));
        }
      });
    } finally {
      clearTimeout(timeout);
      context.signal?.removeEventListener('abort', abortHandler);
    }

    if (aborted || context.signal?.aborted) {
      return {
        output: 'Bash failed: command aborted',
        isError: true,
      };
    }

    const bashOutput = formatBashOutput(stdout, stderr, exitCode);
    const materializedOutput = await materializeBuiltinBashOutput({
      command,
      stdout: bashOutput.stdout,
      stderr: bashOutput.stderr,
      exitCode: bashOutput.exitCode,
      workspacePath: context.cwd,
      threshold: MATERIALIZATION_THRESHOLD_CHARS,
      sizeCap: MATERIALIZATION_SIZE_CAP_BYTES,
      log: bashMaterializationLog,
    });
    const output = materializedOutput?.output ?? formatBashOutputAsString(bashOutput, maxOutputChars);
    // Structured signal for the Stage 1 universal output cap (executeToolUse):
    // when Bash has already materialised to a file and returned a bounded
    // preview, mark the result so the cap does not re-wrap a preview-of-a-
    // preview. See docs/plans/260529_guard-large-tool-outputs/PLAN.md § Stage 1.
    const materialized = materializedOutput?.materialized === true;
    if (timedOut) {
      bashLog.warn(
        { pid, exitFired, closeFired, killed, stdoutLength: stdout.length, stderrLength: stderr.length, ...cmdFlags, preview: redactCommandForLog(command) },
        'Bash command timed out',
      );
      return {
        output: `Command timed out after ${timeoutMs}ms\n\n${output}`,
        isError: true,
        outputChars: bashOutput.totalChars,
        ...(materialized ? { materialized: true } : {}),
      };
    }

    return {
      output,
      isError: (exitCode ?? 1) !== 0,
      outputChars: bashOutput.totalChars,
      ...(materialized ? { materialized: true } : {}),
    };
  } catch (error) {
    return {
      output: formatError('Bash', error),
      isError: true,
    };
  }
};

const requireTaskStore = (context: BuiltinToolContext) => {
  if (!context.taskStore) {
    throw new Error('Task store is not available in this execution context');
  }
  return context.taskStore;
};

const requireTaskStoreInternal = (context: BuiltinToolContext) => {
  if (!context.taskStoreInternal) {
    throw new Error('Internal task store is not available in this execution context');
  }
  return context.taskStoreInternal;
};

const normalizeNonEmptyString = (value: string, fieldName: string): string => {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return normalized;
};

const findMissionTask = (
  tasks: Iterable<RebelCoreTask>,
  key: MissionContextKey,
): RebelCoreTask | undefined => {
  for (const task of tasks) {
    if (task.owner === MISSION_OWNER && task.notes === key) {
      return task;
    }
  }
  return undefined;
};

export const extractMissionContext = (tasks: RebelCoreTask[]) => {
  const goal = findMissionTask(tasks, 'goal')?.title;
  const doneCriteria = findMissionTask(tasks, 'done_criteria')?.title;
  const constraints = findMissionTask(tasks, 'constraints')?.title;

  return {
    goal,
    done_criteria: doneCriteria,
    constraints,
  };
};

export const upsertMissionTaskDirect = (
  taskStoreInternal: RebelCoreTaskStoreInternal,
  key: MissionContextKey,
  value: string,
): RebelCoreTask => {
  const now = Date.now();
  const allTasks = taskStoreInternal._getAllTasks();
  const existing = findMissionTask(allTasks.values(), key);

  if (existing) {
    const updated: RebelCoreTask = {
      ...existing,
      owner: MISSION_OWNER,
      notes: key,
      title: value,
      updatedAt: now,
    };
    taskStoreInternal._setRawTask(existing.id, updated);
    return updated;
  }

  const nextTaskId = taskStoreInternal._getNextTaskId();
  const taskId = String(nextTaskId);
  const created: RebelCoreTask = {
    id: taskId,
    title: value,
    owner: MISSION_OWNER,
    status: 'pending',
    notes: key,
    createdAt: now,
    updatedAt: now,
  };

  taskStoreInternal._setRawTask(taskId, created);
  taskStoreInternal._setNextTaskId(nextTaskId + 1);
  return created;
};

const upsertMissionTask = (
  context: BuiltinToolContext,
  key: MissionContextKey,
  value: string,
): RebelCoreTask => {
  const taskStoreInternal = requireTaskStoreInternal(context);
  return upsertMissionTaskDirect(taskStoreInternal, key, normalizeNonEmptyString(value, key));
};

const stringifyJson = (value: unknown): string => JSON.stringify(value, null, 2);

const runTaskCreateTool = async (
  input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> => {
  try {
    if (!isRecord(input)) {
      throw new Error('Input must be an object');
    }

    const taskStore = requireTaskStore(context);
    const title = getOptionalString(input, 'subject')
      ?? getOptionalString(input, 'title')
      ?? getOptionalString(input, 'content');

    if (!title || title.trim().length === 0) {
      throw new Error('TaskCreate requires subject, title, or content');
    }

    const task = taskStore.createTask({
      title,
      description: getOptionalString(input, 'description'),
      status: getOptionalTaskStatus(input, 'status'),
      priority: getOptionalPriority(input, 'priority'),
      blockers: getOptionalStringArray(input, 'blocked_by') ?? getOptionalStringArray(input, 'blockers'),
      activeForm: getOptionalString(input, 'activeForm'),
      notes: getOptionalString(input, 'notes'),
    });

    return {
      output: stringifyJson({
        summary: `Task #${task.id} created successfully`,
        task,
        tasks: taskStore.listTasks(),
      }),
      isError: false,
    };
  } catch (error) {
    return {
      output: formatError('TaskCreate', error),
      isError: true,
    };
  }
};

const runTaskListTool = async (
  _input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> => {
  try {
    const taskStore = requireTaskStore(context);
    const tasks = taskStore.listTasks();

    return {
      output: stringifyJson({
        tasks,
        summary: `${tasks.length} task${tasks.length === 1 ? '' : 's'} in task list`,
      }),
      isError: false,
    };
  } catch (error) {
    return {
      output: formatError('TaskList', error),
      isError: true,
    };
  }
};

const resolveTaskId = (input: Record<string, unknown>): string => {
  const taskId = getOptionalString(input, 'taskId')
    ?? getOptionalString(input, 'id');

  if (!taskId || taskId.trim().length === 0) {
    throw new Error('Task identifier is required');
  }

  return taskId;
};

const runTaskGetTool = async (
  input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> => {
  try {
    if (!isRecord(input)) {
      throw new Error('Input must be an object');
    }

    const taskStore = requireTaskStore(context);
    const taskId = resolveTaskId(input);
    const task = taskStore.getTask(taskId);

    if (!task) {
      throw new Error(`Task #${taskId} was not found`);
    }

    return {
      output: stringifyJson({ task }),
      isError: false,
    };
  } catch (error) {
    return {
      output: formatError('TaskGet', error),
      isError: true,
    };
  }
};

const runTaskUpdateTool = async (
  input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> => {
  try {
    if (!isRecord(input)) {
      throw new Error('Input must be an object');
    }

    const taskStore = requireTaskStore(context);
    const taskId = resolveTaskId(input);
    const task = taskStore.updateTask(taskId, {
      title: getOptionalString(input, 'subject')
        ?? getOptionalString(input, 'title')
        ?? getOptionalString(input, 'content'),
      description: getOptionalString(input, 'description'),
      status: getOptionalTaskStatus(input, 'status'),
      priority: getOptionalPriority(input, 'priority'),
      blockers: getOptionalStringArray(input, 'blocked_by') ?? getOptionalStringArray(input, 'blockers'),
      activeForm: getOptionalString(input, 'activeForm'),
      notes: getOptionalString(input, 'notes'),
    });

    if (!task) {
      throw new Error(`Task #${taskId} was not found`);
    }

    return {
      output: stringifyJson({
        summary: `Updated task #${task.id}`,
        task,
        tasks: taskStore.listTasks(),
      }),
      isError: false,
    };
  } catch (error) {
    return {
      output: formatError('TaskUpdate', error),
      isError: true,
    };
  }
};

const runMissionSetTool = async (
  input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> => {
  try {
    if (!isRecord(input)) {
      throw new Error('Input must be an object');
    }

    if ((context.depth ?? 0) > 0) {
      throw new Error('MissionSet is only available to the main agent');
    }

    const taskStoreInternal = requireTaskStoreInternal(context);

    const goal = normalizeNonEmptyString(getRequiredString(input, 'goal'), 'goal');
    const doneCriteria = getOptionalString(input, 'done_criteria');
    const constraints = getOptionalString(input, 'constraints');

    const updatedKinds: MissionContextKey[] = ['goal'];
    upsertMissionTask(context, 'goal', goal);

    if (doneCriteria !== undefined) {
      upsertMissionTask(context, 'done_criteria', doneCriteria);
      updatedKinds.push('done_criteria');
    }

    if (constraints !== undefined) {
      upsertMissionTask(context, 'constraints', constraints);
      updatedKinds.push('constraints');
    }

    taskStoreInternal._refreshBlockedTasks();
    const mission = extractMissionContext(taskStoreInternal.listTasks());

    return {
      output: stringifyJson({
        summary: `Mission context updated (${updatedKinds.join(', ')})`,
        mission,
      }),
      isError: false,
    };
  } catch (error) {
    return {
      output: formatError('MissionSet', error),
      isError: true,
    };
  }
};

const DEFAULT_MAX_PREVIOUS_TURNS = 3;

const runGetPreviousTasksTool = async (
  input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> => {
  try {
    const taskStoreInternal = requireTaskStoreInternal(context);
    const maxTurns = isRecord(input) ? getOptionalInteger(input, 'max_turns') : undefined;
    const effectiveMaxTurns = maxTurns ?? DEFAULT_MAX_PREVIOUS_TURNS;

    const archivedTurns = taskStoreInternal.getArchivedTurns();
    const limitedTurns = archivedTurns.slice(0, effectiveMaxTurns);

    const formattedTurns = limitedTurns.map((turn) => {
      const mission = extractMissionContext(turn.tasks);
      const displayTasks = turn.tasks.filter((t) => t.owner !== MISSION_OWNER);

      return {
        turn_number: turn.turnNumber,
        mission,
        tasks: displayTasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          ...(t.description ? { description: t.description } : {}),
          ...(t.priority ? { priority: t.priority } : {}),
          ...(t.notes ? { notes: t.notes } : {}),
        })),
      };
    });

    return {
      output: stringifyJson({
        previous_turns: formattedTurns,
        total_archived_turns: archivedTurns.length,
        showing: limitedTurns.length,
      }),
      isError: false,
    };
  } catch (error) {
    return {
      output: formatError('GetPreviousTasks', error),
      isError: true,
    };
  }
};

const runGetMissionContextTool = async (
  _input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> => {
  try {
    const taskStore = requireTaskStore(context);
    const tasks = taskStore.listTasks();

    return {
      output: stringifyJson({
        mission: extractMissionContext(tasks),
        tasks,
      }),
      isError: false,
    };
  } catch (error) {
    return {
      output: formatError('GetMissionContext', error),
      isError: true,
    };
  }
};

const runSummarizeResultTool = async (
  input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> => {
  try {
    if (!isRecord(input)) {
      throw new Error('Input must be an object');
    }

    const taskStore = requireTaskStore(context);
    const summary = getRequiredString(input, 'summary');
    const isSubAgentSummary = (context.depth ?? 0) > 0
      || (typeof context.agentNamespace === 'string' && context.agentNamespace !== MAIN_NAMESPACE);

    taskStore.createTask({
      title: 'Result Summary',
      notes: summary,
      status: 'completed',
      ...(isSubAgentSummary ? { kind: 'orchestration' as const } : {}),
    });

    return {
      output: stringifyJson({
        summary: 'Result summary recorded successfully',
      }),
      isError: false,
    };
  } catch (error) {
    return {
      output: formatError('SummarizeResult', error),
      isError: true,
    };
  }
};

const runTodoWriteTool = async (
  input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> => {
  try {
    if (!isRecord(input)) {
      throw new Error('Input must be an object');
    }

    const todos = input.todos;
    if (!Array.isArray(todos)) {
      throw new Error('todos must be an array');
    }

    const normalizedTodos = todos.map((todo, index) => {
      if (!isRecord(todo)) {
        throw new Error(`todos[${index}] must be an object`);
      }

      const content = getRequiredString(todo, 'content');
      return {
        id: getOptionalString(todo, 'id'),
        content,
        status: getOptionalTaskStatus(todo, 'status') ?? 'pending',
        priority: getOptionalPriority(todo, 'priority'),
      };
    });

    const taskStore = requireTaskStore(context);
    const tasks = taskStore.replaceWithTodos(normalizedTodos);

    return {
      output: stringifyJson({
        summary: `Stored ${tasks.length} todo item${tasks.length === 1 ? '' : 's'}`,
        tasks,
        todos: tasks.map((task) => ({
          id: task.id,
          content: task.title,
          status: task.status,
          ...(task.priority ? { priority: task.priority } : {}),
        })),
      }),
      isError: false,
    };
  } catch (error) {
    return {
      output: formatError('TodoWrite', error),
      isError: true,
    };
  }
};

const runTodoReadTool = async (
  _input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> => {
  try {
    const taskStore = requireTaskStore(context);
    const tasks = taskStore.listTasks();

    return {
      output: stringifyJson({
        todos: tasks.map((task) => ({
          id: task.id,
          content: task.title,
          status: task.status,
          ...(task.priority ? { priority: task.priority } : {}),
        })),
      }),
      isError: false,
    };
  } catch (error) {
    return {
      output: formatError('TodoRead', error),
      isError: true,
    };
  }
};

const REBEL_GET_APP_SCREENSHOT_THEMES = ['current', 'light', 'dark'] as const;

const APP_NAVIGATION_DESTINATION_ALIASES: Record<string, (typeof APP_NAVIGATION_DESTINATIONS)[number]> = {
  action: 'actions',
  actions: 'actions',
  'action page': 'actions',
  'actions page': 'actions',
  task: 'actions',
  tasks: 'actions',
  inbox: 'actions',
  home: 'home',
  homepage: 'home',
  'home page': 'home',
  conversation: 'conversations',
  conversations: 'conversations',
  chats: 'conversations',
  automation: 'automations',
  automations: 'automations',
  spark: 'spark',
  'the spark': 'spark',
  library: 'library',
  settings: 'settings',
  'settings page': 'settings',
};

const normalizeAppNavigationDestination = (
  value: string,
): (typeof APP_NAVIGATION_DESTINATIONS)[number] | null => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
  return APP_NAVIGATION_DESTINATION_ALIASES[normalized] ?? null;
};

const isAppNavigationDestination = (
  value: string,
): value is (typeof APP_NAVIGATION_DESTINATIONS)[number] =>
  APP_NAVIGATION_DESTINATIONS.includes(value as (typeof APP_NAVIGATION_DESTINATIONS)[number]);

const isSettingsTab = (value: string): value is SettingsTabId =>
  SETTINGS_TABS.includes(value as SettingsTabId);

const isRebelGetAppScreenshotTheme = (
  value: string,
): value is (typeof REBEL_GET_APP_SCREENSHOT_THEMES)[number] =>
  REBEL_GET_APP_SCREENSHOT_THEMES.includes(
    value as (typeof REBEL_GET_APP_SCREENSHOT_THEMES)[number],
  );

const createScreenshotErrorResult = (
  errorCode: CaptureErrorCode,
  detail?: unknown,
): ToolExecutionResult => ({
  output: stringifyJson({
    errorCode,
    ...(detail !== undefined ? { detail } : {}),
  }),
  isError: true,
});

const createAppNavigationErrorResult = (
  errorCode: AppNavigationErrorCode,
  detail?: unknown,
): ToolExecutionResult => ({
  output: stringifyJson({
    errorCode,
    ...(detail !== undefined ? { detail } : {}),
  }),
  isError: true,
});

const runRebelNavigateAppTool = async (
  input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> => {
  try {
    if (!isRecord(input)) {
      throw new Error('Input must be an object');
    }

    const rawDestination = getRequiredString(input, 'destination');
    const destination = normalizeAppNavigationDestination(rawDestination);
    if (!destination || !isAppNavigationDestination(destination)) {
      return createAppNavigationErrorResult('invalid-destination', {
        destination: rawDestination,
        allowed: APP_NAVIGATION_DESTINATIONS,
      });
    }
    const rawSettingsTab = getOptionalString(input, 'settings_tab');
    const settingsSection = getOptionalString(input, 'settings_section');
    if ((rawSettingsTab !== undefined || settingsSection !== undefined) && destination !== 'settings') {
      return createAppNavigationErrorResult('invalid-destination-modifiers', {
        reason: 'settings_tab and settings_section can only be used when destination is settings',
        destination,
        ...(rawSettingsTab !== undefined ? { settings_tab: rawSettingsTab } : {}),
        ...(settingsSection !== undefined ? { settings_section: settingsSection } : {}),
      });
    }

    let settingsTab: SettingsTabId | undefined;
    if (rawSettingsTab !== undefined) {
      if (!isSettingsTab(rawSettingsTab)) {
        return createAppNavigationErrorResult('invalid-destination', {
          settings_tab: rawSettingsTab,
          allowed: SETTINGS_TABS,
        });
      }
      settingsTab = rawSettingsTab;
    }

    if (!context.navigateApp) {
      return createAppNavigationErrorResult('navigation-not-supported-on-this-surface');
    }

    const result = await context.navigateApp({
      destination,
      ...(settingsTab !== undefined ? { settingsTab } : {}),
      ...(settingsSection !== undefined ? { settingsSection } : {}),
    });
    if (result.kind === 'error') {
      return createAppNavigationErrorResult(result.errorCode, result.detail);
    }

    const navigationProvenance = {
      destination: result.destination,
      expectedSurface: APP_NAVIGATION_DESTINATION_SURFACES[result.destination],
      ...(result.settingsTab !== undefined ? { settingsTab: result.settingsTab } : {}),
      ...(result.settingsSection !== undefined ? { settingsSection: result.settingsSection } : {}),
    };
    context.visualVerificationNavigation = navigationProvenance;
    if (context.visualVerificationNavigationState) {
      context.visualVerificationNavigationState.current = navigationProvenance;
    }

    return {
      output: stringifyJson({
        destination: result.destination,
        ...(result.settingsTab !== undefined ? { settings_tab: result.settingsTab } : {}),
        ...(result.settingsSection !== undefined ? { settings_section: result.settingsSection } : {}),
      }),
      isError: false,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return createAppNavigationErrorResult('navigation-failed', detail);
  }
};

const runRebelGetAppScreenshotTool = async (
  input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> => {
  try {
    if (!isRecord(input)) {
      throw new Error('Input must be an object');
    }

    const theme = getRequiredString(input, 'theme');
    if (!isRebelGetAppScreenshotTheme(theme)) {
      throw new Error('theme must be one of: current, light, dark');
    }
    const label = getOptionalString(input, 'label');
    const rawCaptureMode = getOptionalString(input, 'capture_mode');
    if (rawCaptureMode !== undefined && rawCaptureMode !== 'viewport' && rawCaptureMode !== 'scroll') {
      throw new Error('capture_mode must be one of: viewport, scroll');
    }
    const captureMode: CaptureMode = rawCaptureMode ?? 'scroll';
    const maxScreenshots = getOptionalPositiveInteger(input, 'max_screenshots');
    if (maxScreenshots !== undefined && maxScreenshots > 6) {
      throw new Error('max_screenshots must be between 1 and 6');
    }

    if (!context.captureRebelWindow) {
      return createScreenshotErrorResult('screenshot-not-supported-on-this-surface');
    }

    const result = await context.captureRebelWindow({
      theme,
      ...(label !== undefined ? { label } : {}),
      captureMode,
      ...(maxScreenshots !== undefined ? { maxScreenshots } : {}),
    });

    if (result.kind === 'error') {
      return createScreenshotErrorResult(result.errorCode, result.detail);
    }

    const lastNavigation = context.visualVerificationNavigationState?.current
      ?? context.visualVerificationNavigation;
    if (lastNavigation && result.currentSurface !== lastNavigation.expectedSurface) {
      visualVerificationToolLog.warn(
        {
          currentSurface: result.currentSurface,
          expectedSurface: lastNavigation.expectedSurface,
          destination: lastNavigation.destination,
          settingsTab: lastNavigation.settingsTab,
          settingsSection: lastNavigation.settingsSection,
        },
        'Captured Rebel screenshot surface does not match the most recent successful app navigation',
      );
      return createScreenshotErrorResult('surface-mismatch', {
        current_surface: result.currentSurface,
        expected_surface: lastNavigation.expectedSurface,
        destination: lastNavigation.destination,
        ...(lastNavigation.settingsTab !== undefined ? { settings_tab: lastNavigation.settingsTab } : {}),
        ...(lastNavigation.settingsSection !== undefined ? { settings_section: lastNavigation.settingsSection } : {}),
      });
    }

    const captures = result.captures ?? [{
      path: result.path,
      width: result.width,
      height: result.height,
      bytes: result.bytes,
      base64Data: result.base64Data,
      mimeType: result.mimeType,
    }];

    return {
      output: stringifyJson({
        path: result.path,
        width: result.width,
        height: result.height,
        theme: result.theme,
        bytes: result.bytes,
        current_surface: result.currentSurface,
        capture_mode: captureMode,
        ...(captures.length > 1
          ? {
              captures: captures.map((capture, index) => ({
                path: capture.path,
                width: capture.width,
                height: capture.height,
                bytes: capture.bytes,
                index: capture.index ?? index,
                ...(capture.scrollTop !== undefined ? { scroll_top: capture.scrollTop } : {}),
              })),
            }
          : {}),
        ...(result.label !== undefined ? { label: result.label } : {}),
      }),
      isError: false,
      imageContent: captures.map((capture) => ({
        type: 'image',
        data: capture.base64Data,
        mimeType: capture.mimeType,
      })),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return createScreenshotErrorResult('capture-failed', detail);
  }
};

const REBEL_GET_APP_SCREENSHOT_TOOL: ToolDefinition = {
  name: 'rebel_get_app_screenshot',
  description:
    'Capture a screenshot of the Rebel app window and return metadata plus image content.',
  input_schema: {
    type: 'object',
    properties: {
      theme: {
        type: 'string',
        enum: [...REBEL_GET_APP_SCREENSHOT_THEMES],
        description: 'Theme to capture. Use current to keep the active theme.',
      },
      label: {
        type: 'string',
        description: 'Optional capture label for screenshot metadata.',
      },
      capture_mode: {
        type: 'string',
        enum: ['viewport', 'scroll'],
        description: 'Use scroll to capture multiple viewport screenshots of long surfaces, or viewport for one screenshot. Defaults to scroll.',
      },
      max_screenshots: {
        type: 'integer',
        minimum: 1,
        maximum: 6,
        description: 'Maximum screenshots to capture in scroll mode. Defaults to 4.',
      },
    },
    required: ['theme'],
  },
};

const REBEL_NAVIGATE_APP_TOOL: ToolDefinition = {
  name: 'rebel_navigate_app',
  description:
    'Navigate the Rebel app to a safe built-in surface before visual review. Use this before rebel_get_app_screenshot when the user asks to inspect a different app page such as Actions. Only pass settings_tab or settings_section when destination is settings; for all other destinations call with destination only.',
  input_schema: {
    type: 'object',
    properties: {
      destination: {
        type: 'string',
        enum: [...APP_NAVIGATION_DESTINATIONS],
        description: 'App surface to open before taking a screenshot.',
      },
      settings_tab: {
        type: 'string',
        enum: [...SETTINGS_TABS],
        description: 'Optional Settings tab to open when destination is settings, e.g. meetings.',
      },
      settings_section: {
        type: 'string',
        description: 'Optional Settings section anchor to scroll to when destination is settings.',
      },
    },
    required: ['destination'],
  },
};

const REBEL_OPERATOR_CONSULT_TOOL: ToolDefinition = {
  name: 'rebel_operator__consult',
  description:
    'Ask one activated Operator for a focused advisory perspective. Use this only when the Operator is relevant to the user request; pass the Operator id exactly as provided in the system prompt and a concise focus for the consult. If the consult returns an error (isError: true), briefly tell the user you could not reach that Operator (use its name from operatorName) and continue without its input — never silently drop a failed consult.',
  input_schema: {
    type: 'object',
    properties: {
      operatorId: {
        type: 'string',
        description: 'Stable Operator id from the Operators availability block.',
      },
      focus: {
        type: 'string',
        description: 'The specific question or angle this Operator should address.',
      },
    },
    required: ['operatorId', 'focus'],
  },
};

const READ_TOOL: ToolDefinition = {
  name: 'Read',
  description:
    'Read a file. UTF-8 text files return their contents (with optional line offset/limit). '
    + 'Image files (PNG/JPEG/GIF/WEBP) are returned as viewable image content for vision-capable '
    + 'models; other binary files return a short placeholder with metadata. Very large text is '
    + 'returned as a head slice with guidance to page through the rest via offset/limit.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute or workspace-relative path to the file.',
      },
      offset: {
        type: 'integer',
        minimum: 0,
        description: 'Optional 0-based starting line offset.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        description: 'Optional maximum number of lines to return.',
      },
    },
    required: ['file_path'],
  },
};

const WRITE_TOOL: ToolDefinition = {
  name: 'Write',
  description: 'Write UTF-8 text content to a file, creating parent directories when needed.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute or workspace-relative path to the file.',
      },
      content: {
        type: 'string',
        description: 'Content to write to the target file.',
      },
    },
    required: ['file_path', 'content'],
  },
};

const EDIT_TOOL: ToolDefinition = {
  name: 'Edit',
  description: 'Replace a unique old_str occurrence in a file with new_str.',
  input_schema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute or workspace-relative path to the file.',
      },
      old_str: {
        type: 'string',
        description: 'Exact text to replace. Must appear exactly once.',
      },
      new_str: {
        type: 'string',
        description: 'Replacement text.',
      },
    },
    required: ['file_path', 'old_str', 'new_str'],
  },
};

const BASH_TOOL: ToolDefinition = {
  name: 'Bash',
  description: 'Execute a shell command in the workspace with an optional timeout in seconds.',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to execute.',
      },
      timeout: {
        type: 'integer',
        minimum: 1,
        description: 'Optional timeout in seconds (default 60).',
      },
    },
    required: ['command'],
  },
};

const TASK_CREATE_TOOL: ToolDefinition = {
  name: 'TaskCreate',
  description: 'Create a task in the active execution task list.',
  input_schema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Short task title.' },
      title: { type: 'string', description: 'Alias for subject.' },
      content: { type: 'string', description: 'Legacy alias for subject.' },
      description: { type: 'string', description: 'Optional extra task detail.' },
      activeForm: { type: 'string', description: 'Optional progressive form, e.g. "Reviewing tests".' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] },
      priority: { type: 'string', enum: ['high', 'medium', 'low'] },
      blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task IDs that must complete before this task can start.' },
      blockers: { type: 'array', items: { type: 'string' }, description: 'Alias for blocked_by.' },
      notes: { type: 'string', description: 'Internal implementation notes (not shown to user).' },
    },
    required: [],
  },
};

const TASK_LIST_TOOL: ToolDefinition = {
  name: 'TaskList',
  description: 'Return the current task list as structured JSON.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const TASK_GET_TOOL: ToolDefinition = {
  name: 'TaskGet',
  description: 'Return a single task from the current task list.',
  input_schema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task identifier.' },
      id: { type: 'string', description: 'Alias for taskId.' },
    },
    required: [],
  },
};

const TASK_UPDATE_TOOL: ToolDefinition = {
  name: 'TaskUpdate',
  description: 'Update fields on an existing task in the current task list.',
  input_schema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Task identifier.' },
      id: { type: 'string', description: 'Alias for taskId.' },
      subject: { type: 'string', description: 'Replacement task title.' },
      title: { type: 'string', description: 'Alias for subject.' },
      content: { type: 'string', description: 'Legacy alias for subject.' },
      description: { type: 'string', description: 'Replacement task detail.' },
      activeForm: { type: 'string', description: 'Updated progressive form.' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] },
      priority: { type: 'string', enum: ['high', 'medium', 'low'] },
      blocked_by: { type: 'array', items: { type: 'string' }, description: 'Task IDs that must complete before this task can start.' },
      blockers: { type: 'array', items: { type: 'string' }, description: 'Alias for blocked_by.' },
      notes: { type: 'string', description: 'Internal implementation notes (not shown to user).' },
    },
    required: [],
  },
};

export const MISSION_SET_TOOL_DEFINITION: ToolDefinition = {
  name: 'MissionSet',
  description: 'Set or update the mission context for the current task. Only available to the main agent.',
  input_schema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'The high-level goal for this mission.' },
      done_criteria: { type: 'string', description: 'Criteria for when the mission is complete.' },
      constraints: { type: 'string', description: 'Any constraints or requirements to respect.' },
    },
    required: ['goal'],
  },
};

export const GET_MISSION_CONTEXT_TOOL_DEFINITION: ToolDefinition = {
  name: 'GetMissionContext',
  description: 'Retrieve the full mission context and task board. Useful for understanding the bigger picture.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const GET_PREVIOUS_TASKS_TOOL_DEFINITION: ToolDefinition = {
  name: 'GetPreviousTasks',
  description: 'Retrieve tasks and mission context from previous turns in this conversation. Use when the user asks you to continue prior work or you need context about what was done before.',
  input_schema: {
    type: 'object',
    properties: {
      max_turns: {
        type: 'integer',
        minimum: 1,
        description: 'Maximum number of previous turns to retrieve (most recent first). Defaults to 3.',
      },
    },
    required: [],
  },
};

export const SUMMARIZE_RESULT_TOOL_DEFINITION: ToolDefinition = {
  name: 'SummarizeResult',
  description: 'Write a structured summary of your work results. Call this before completing your task to share findings with the broader team.',
  input_schema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'A 2-3 sentence summary of key findings, decisions, and outcomes.',
      },
    },
    required: ['summary'],
  },
};

const TODO_WRITE_TOOL: ToolDefinition = {
  name: 'TodoWrite',
  description: 'Legacy compatibility wrapper that writes the current todo list.',
  input_schema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['content'],
        },
      },
    },
    required: ['todos'],
  },
};

const TODO_READ_TOOL: ToolDefinition = {
  name: 'TodoRead',
  description: 'Legacy compatibility wrapper that returns the current todo list.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

const UPDATE_MODEL_PROFILE_NOTES_TOOL: ToolDefinition = {
  name: 'UpdateModelProfileNotes',
  description: 'Update the notes/description for a model profile. Use this to record what a model is good at, what to avoid, and any quirks. These notes are used by the planner for adaptive routing decisions.',
  input_schema: {
    type: 'object',
    properties: {
      profile_id: {
        type: 'string',
        description: 'The ID of the model profile to update.',
      },
      notes: {
        type: 'string',
        description: 'The new notes for the model profile. Should describe the model\'s strengths, weaknesses, and any relevant observations.',
      },
    },
    required: ['profile_id', 'notes'],
  },
};

async function runUpdateModelProfileNotesTool(
  input: unknown,
  _context: BuiltinToolContext,
): Promise<ToolExecutionResult> {
  try {
    if (!isRecord(input)) {
      throw new Error('Input must be an object');
    }

    const profileId = getRequiredString(input, 'profile_id');
    const notes = getRequiredString(input, 'notes', { allowEmpty: true });
    const settings = getSettings();
    const profiles = settings.localModel?.profiles ?? [];
    const profile = profiles.find((entry) => entry.id === profileId);

    if (!profile) {
      return {
        output: `UpdateModelProfileNotes failed: profile '${profileId}' was not found.`,
        isError: true,
      };
    }

    const updatedProfiles = profiles.map((entry) =>
      entry.id === profileId ? { ...entry, modelNotes: notes } : entry,
    );

    updateSettings({
      localModel: {
        ...settings.localModel!,
        profiles: updatedProfiles,
      },
    });

    return {
      output: `Updated notes for profile '${profile.name}' (ID: ${profileId}).`,
      isError: false,
    };
  } catch (error) {
    return {
      output: formatError('UpdateModelProfileNotes', error),
      isError: true,
    };
  }
}

const runSuggestConnectorSetupTool = async (
  input: unknown,
  _context: BuiltinToolContext,
): Promise<ToolExecutionResult> => {
  try {
    if (!isRecord(input)) {
      throw new Error('Input must be an object');
    }

    const connectorName = getRequiredString(input, 'connectorName');
    const intent = getOptionalString(input, 'intent') ?? 'build';
    if (intent !== 'build' && intent !== 'extend') {
      throw new Error('intent must be one of: build, extend');
    }

    const payload: Record<string, unknown> = {
      connectorName: connectorName.trim(),
      intent,
    };

    const connectorId = getOptionalString(input, 'connectorId');
    if (connectorId?.trim()) {
      payload.connectorId = connectorId.trim();
    }

    const reason = getOptionalString(input, 'reason');
    if (reason?.trim()) {
      payload.reason = reason.trim();
    }

    return {
      output: stringifyJson(payload),
      isError: false,
    };
  } catch (error) {
    return {
      output: formatError('suggest_connector_setup', error),
      isError: true,
    };
  }
};

const SUGGEST_CONNECTOR_SETUP_TOOL: ToolDefinition = {
  name: 'suggest_connector_setup',
  description: 'Surface the in-chat connector setup card for the open-source MCP flow. Call this when the user wants to use, connect, or set up a service that is not in Rebel\'s built-in connector catalog, so Rebel can guide them into the OSS/custom connector flow instead of only explaining the catalog miss in prose. Also use it when the user wants to add tools to an existing open-source connector. Set `intent` to `build` for a new connector or `extend` for adding tools to an existing connector. Do not use this for ordinary built-in connector installation or other built-in catalog connectors Rebel already supports. Call at most once per turn. ENTRY-POINT ONLY — this card is the *entry trigger* into the build-custom-mcp-server / extend-mcp-server skills from outside (vanilla chat catalog miss). Do NOT call it from inside those skills: it is not a checkpoint, deliverable, or handoff — calling it mid-build is a no-op that produces no files and risks being mistaken for completion. If a build skill is already running (skillAttachment loaded, or a "Build it" / equivalent confirmation has been received this conversation), continue executing the skill\'s next phase directly without invoking this tool.',
  input_schema: {
    type: 'object',
    properties: {
      connectorName: {
        type: 'string',
        description: 'Human-readable connector name to show in the card, e.g. "Zendesk".',
      },
      intent: {
        type: 'string',
        enum: ['build', 'extend'],
        description: 'Whether the card should start the build-new flow or the extend-existing flow.',
      },
      connectorId: {
        type: 'string',
        description: 'Optional connector identifier for extend flows when known.',
      },
      reason: {
        type: 'string',
        description: 'Optional short explanation for why this connector should be surfaced.',
      },
    },
    required: ['connectorName'],
  },
};

const ASK_USER_QUESTION_TOOL: ToolDefinition = {
  name: 'AskUserQuestion',
  description: [
    'Ask the user structured inline questions. Use 1-4 questions per batch. Default to 2-4 concrete options for each decision because clicking is easier than typing; an "Other" free-text option is provided automatically. Use `options: []` only when the user must author or paste an exact value, such as message text, an API key, ID, URL, or file-specific detail that you cannot sensibly enumerate.',
    'If the user needs to answer multiple distinct decisions, create multiple questions in the same batch instead of combining them into one broad text field. For example, "what should I send, and where?" should normally be two questions: one for the exact message if needed, and one for the destination/recipient with any plausible options you found.',
    'For message/note requests, "edit first", "change it", or any custom text the user provides is only a way to collect the exact message body. After the edited text is provided, continue the request: if the destination/medium is still unclear, ask that focused question (for example Slack vs email vs something else); if all details are known, use the normal send/post tool path so approval can happen there. Do not stop at a chat-only "send this exact message or edit again" decision point.',
    'When an option directs the user to fetch something elsewhere (e.g. a provider API key), the option **MUST** set both `url` (the page they should open) AND `requiresInput: true` with a clear `inputPlaceholder` (so the user has somewhere to paste the value back). Setting `url` without `requiresInput` strands the user — the card auto-completes and they have no way to bring the value back. Example: `{label: "Need to get it", description: "Open the API keys page", url: "https://example.com/keys", requiresInput: true, inputPlaceholder: "Paste your API key here"}`. Keep question text SHORT and scannable (1-2 sentences). Use the optional context field for background, reasoning, or details — it appears in a collapsible section the user can expand if needed.',
    'PRE-APPROVAL CLARIFICATION — when to use this tool before a sensitive action: if the user asked for something sensitive (sending, posting, scheduling, paying, deleting, modifying memory, or anything else that visibly changes their world) AND there is one or more NAMED MISSING DECISIONS that would change which approval to surface (e.g. which calendar, which account, which recipient or channel, which save destination, which memory boundary like private vs shared vs do-not-save), ask focused question(s) about those specific missing decision(s) before proposing the action. For requests like "send a note/message to <person>" where the user did not specify the medium, the delivery channel is a named missing decision whenever more than one plausible channel exists (for example Slack DM vs email). Do not silently default to email or Slack; ask the channel/content clarification together, then use the selected channel\'s normal action-tool path after the answer. Phrase each question as the missing decision in plain words (e.g. "Which calendar should hold this?" or "Should this go by Slack DM or email?"), not as permission ("Should I add it?" / "Should I send it?"). Use choice options to enumerate the concrete plausible answers you found; use free text only for exact user-authored content. Every question in this pre-approval clarification batch **MUST** set `purpose: "approval_clarification"` so Rebel can render the non-approval UI and keep cancellation semantics tied to trusted question provenance.',
    'CRITICAL — clarification is NOT approval. The answer to this question resolves intent only. It does NOT authorise Rebel to execute the sensitive action, and it does NOT bypass any later approval surface. After the answer arrives, and once the sensitive action is fully specified, use the normal action-tool path with the resolved inputs so the host Safety Rules / approval layer can review, stage, block, or execute it. Do NOT ask the user to type a chat confirmation like "reply send", "reply approve", "go ahead", or similar instead of using the tool path. Even an emphatic free-text answer like "yes, send it now", "approve it", "go ahead and do it", or "use this and post it" must be treated as clarification data only — it tells you which option to pick, it does NOT grant execution permission, and you must not claim the action happened unless the action tool returns success. Do NOT save the answer as a Safety Rule, preference, or persistent permission; these answers are per-case continuation context only.',
    'DO NOT use this tool for pre-approval clarification when: (a) the requested action is clear and just sensitive (single recipient / single channel / single calendar / single document / single boundary) — use the normal action-tool path directly without inserting an extra question; (b) you feel vague uncertainty but cannot name a specific missing decision the user has to pick — think harder, look at the available context, and either proceed or ask a more focused question, but do not ask a broad "what do you want me to do?" question in front of an approval; (c) you (or the user) already answered or skipped this question earlier in the session.',
    'IMPORTANT — do NOT re-ask: before calling this tool, check the conversation for answers the user already provided (previous answers, user messages, or context). Never ask a question whose answer is already known or was previously answered/skipped in this session.',
  ].join('\n\n'),
  input_schema: {
    type: 'object' as const,
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question to ask. Keep it short and scannable (1-2 sentences).' },
            header: { type: 'string', description: 'Short label (max 12 chars). E.g. "Library", "Approach".' },
            context: { type: 'string', description: 'Optional background, reasoning, or details shown in a collapsible section below the question.' },
            options: {
              type: 'array',
              minItems: 0,
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Concise option text (1-5 words).' },
                  description: { type: 'string', description: 'What this option means.' },
                  requiresInput: { type: 'boolean', description: 'When true, selecting this option reveals an inline text input so the user can paste or type a value (e.g. an API key). The answer will include the typed text.' },
                  inputPlaceholder: { type: 'string', description: 'Placeholder text for the inline input when requiresInput is true. E.g. "Paste your API key here".' },
                  url: { type: 'string', description: 'URL to open in the browser when this option is selected. Useful when the user needs to visit a page to retrieve something (e.g. an API key dashboard).' },
                },
                required: ['label', 'description'],
              },
            },
            multiSelect: { type: 'boolean', description: 'Allow selecting multiple options.' },
            purpose: {
              type: 'string',
              enum: ['approval_clarification'],
              description:
                'Optional semantic/display discriminator. Set to `approval_clarification` ONLY when this question asks for one named missing decision before a sensitive action (sending, posting, scheduling, paying, deleting, modifying memory). The UI renders a calmer, non-approval card with a neutral answered receipt. The answer is intent context only: it never approves execution, never bypasses the later approval surface, and must not be saved as a rule or preference. All questions in a single batch must share the same purpose — mixed batches are rejected. Omit this field for generic questions (credentials, format choices, MCP build flow, etc.).',
            },
          },
          required: ['question', 'header', 'options'],
        },
      },
    },
    required: ['questions'],
  },
};

type WiredBuiltinToolName = BuiltinToolName;
type BuiltinToolExecutor = (input: unknown, context: BuiltinToolContext) => Promise<ToolExecutionResult>;

const BUILTIN_TOOL_EXECUTORS: Partial<Record<WiredBuiltinToolName, BuiltinToolExecutor>> = {
  Read: runReadTool,
  Write: runWriteTool,
  Edit: runEditTool,
  Bash: runBashTool,
  suggest_connector_setup: runSuggestConnectorSetupTool,
  AskUserQuestion: async (): Promise<ToolExecutionResult> => ({
    output:
      'AskUserQuestion is not available in this session type. ' +
      'For sensitive actions (sending, posting, scheduling, paying, deleting, or modifying memory) where you needed to clarify a missing decision, ' +
      'STOP. Do not guess the missing decision and do not execute the sensitive action. ' +
      'Instead, explain to the user (in your text response) what specific decision is missing, list the plausible options you considered, ' +
      'and ask them to clarify in their next message before you take the action. ' +
      'For non-sensitive clarifications (read-only research, drafting, exploration), it is acceptable to proceed using your best judgment ' +
      'based on the context available, while clearly stating the assumption you made.',
    isError: true,
  }),
  TaskCreate: runTaskCreateTool,
  TaskList: runTaskListTool,
  TaskGet: runTaskGetTool,
  TaskUpdate: runTaskUpdateTool,
  MissionSet: runMissionSetTool,
  GetMissionContext: runGetMissionContextTool,
  GetPreviousTasks: runGetPreviousTasksTool,
  SummarizeResult: runSummarizeResultTool,
  TodoWrite: runTodoWriteTool,
  TodoRead: runTodoReadTool,
  UpdateModelProfileNotes: runUpdateModelProfileNotesTool,
  WebFetch: executeWebFetch,
  WebSearch: executeWebSearch,
  SearchFiles: executeSearchFiles,
  Glob: executeGlob,
  LS: executeLs,
  inspect_prior_turns: executeInspectPriorTurns,
  get_tool_call: executeGetToolCall,
  rebel_operator__consult: runOperatorConsultTool,
  rebel_navigate_app: runRebelNavigateAppTool,
  rebel_get_app_screenshot: runRebelGetAppScreenshotTool,
};

// NOTE: When changing user-facing built-in tools here, also update the tool list
// in rebel-system/prompts/agent/planning-instructions.md so the planner knows about them.
export const BUILTIN_TOOL_DEFINITIONS: ToolDefinition[] = [
  READ_TOOL,
  WRITE_TOOL,
  EDIT_TOOL,
  BASH_TOOL,
  SUGGEST_CONNECTOR_SETUP_TOOL,
  ASK_USER_QUESTION_TOOL,
  REBEL_OPERATOR_CONSULT_TOOL,
  REBEL_NAVIGATE_APP_TOOL,
  REBEL_GET_APP_SCREENSHOT_TOOL,
  TASK_CREATE_TOOL,
  TASK_LIST_TOOL,
  TASK_GET_TOOL,
  TASK_UPDATE_TOOL,
  TODO_WRITE_TOOL,
  TODO_READ_TOOL,
  UPDATE_MODEL_PROFILE_NOTES_TOOL,
  WEB_FETCH_TOOL_DEFINITION,
  WEB_SEARCH_TOOL_DEFINITION,
  SEARCH_FILES_TOOL_DEFINITION,
  GLOB_TOOL_DEFINITION,
  LS_TOOL_DEFINITION,
  INSPECT_PRIOR_TURNS_TOOL_DEFINITION,
  GET_TOOL_CALL_TOOL_DEFINITION,
];

const CLOUD_BUILTIN_TOOL_DEFINITIONS: ToolDefinition[] = [
  REBEL_MEETINGS_LIVE_TRANSCRIPT_TOOL_DEFINITION,
];

const CLOUD_BUILTIN_TOOL_EXECUTORS: Partial<Record<WiredBuiltinToolName, BuiltinToolExecutor>> = {
  rebel_meetings_live_transcript: executeLiveMeetingTranscriptTool,
};

let cloudBuiltinsRegistered = false;

export const registerCloudOnlyBuiltins = (): void => {
  if (cloudBuiltinsRegistered) return;
  cloudBuiltinsRegistered = true;
  BUILTIN_TOOL_DEFINITIONS.push(...CLOUD_BUILTIN_TOOL_DEFINITIONS);
  Object.assign(BUILTIN_TOOL_EXECUTORS, CLOUD_BUILTIN_TOOL_EXECUTORS);
};

export const resetCloudOnlyBuiltinsForTesting = (): void => {
  if (!cloudBuiltinsRegistered) return;
  cloudBuiltinsRegistered = false;

  for (const definition of CLOUD_BUILTIN_TOOL_DEFINITIONS) {
    const index = BUILTIN_TOOL_DEFINITIONS.findIndex((tool) => tool.name === definition.name);
    if (index >= 0) {
      BUILTIN_TOOL_DEFINITIONS.splice(index, 1);
    }
  }

  for (const toolName of Object.keys(CLOUD_BUILTIN_TOOL_EXECUTORS) as WiredBuiltinToolName[]) {
    delete BUILTIN_TOOL_EXECUTORS[toolName];
  }
};

const OPTIONAL_BUILTIN_TOOL_DEFINITIONS: ToolDefinition[] = [
  MISSION_SET_TOOL_DEFINITION,
  GET_MISSION_CONTEXT_TOOL_DEFINITION,
  GET_PREVIOUS_TASKS_TOOL_DEFINITION,
  SUMMARIZE_RESULT_TOOL_DEFINITION,
];

const resolveImageAssetSurfaceFromContext = (
  context: BuiltinToolContext,
): 'desktop' | 'cloud' => {
  if (context.imageAssetContext?.surface) {
    return context.imageAssetContext.surface;
  }
  return process.env.REBEL_SURFACE === 'cloud' ? 'cloud' : 'desktop';
};

const maybeMaterializeBuiltinToolImageRefs = async (
  toolName: BuiltinToolName,
  result: ToolExecutionResult,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> => {
  if (!result.imageContent || result.imageContent.length === 0) {
    return result;
  }
  if (result.imageRef && result.imageRef.length > 0) {
    return result;
  }
  if (!context.imageAssetContext) {
    return result;
  }

  let eventSeq: number;
  try {
    eventSeq = context.imageAssetContext.nextToolResultEventSeq();
  } catch (error) {
    imageMaterializationLog.warn(
      {
        toolName,
        err: error instanceof Error ? error.message : String(error),
      },
      'Image ref materialization skipped because event sequence allocation failed',
    );
    return { ...result, imageRef: [] };
  }

  try {
    const materialization = await materializeImageRefsForEvent(
      {
        sessionId: context.imageAssetContext.sessionId,
        turnId: context.imageAssetContext.turnId,
        eventSeq,
        imageContent: result.imageContent,
        surface: resolveImageAssetSurfaceFromContext(context),
      },
      getAssetStore(),
    );

    if (materialization.failures.length > 0) {
      imageMaterializationLog.warn(
        {
          toolName,
          eventSeq,
          failureCount: materialization.failures.length,
          failures: materialization.failures.map((failure) => ({
            index: failure.index,
            reason: failure.reason,
          })),
        },
        'Built-in tool image ref materialization had failures; legacy image payload retained',
      );
    }

    return {
      ...result,
      imageRef: materialization.refs,
    };
  } catch (error) {
    imageMaterializationLog.warn(
      {
        toolName,
        eventSeq,
        err: error instanceof Error ? error.message : String(error),
      },
      'Built-in tool image ref materialization failed; legacy image payload retained',
    );
    return { ...result, imageRef: [] };
  }
};

export const isBuiltinToolName = (toolName: string): toolName is WiredBuiltinToolName =>
  Object.hasOwn(BUILTIN_TOOL_EXECUTORS, toolName);

export const getBuiltinToolDefinitions = (): ToolDefinition[] => [...BUILTIN_TOOL_DEFINITIONS];

export const getBuiltinToolDefinition = (toolName: string): ToolDefinition | undefined =>
  BUILTIN_TOOL_DEFINITIONS.find((tool) => tool.name === toolName)
  ?? OPTIONAL_BUILTIN_TOOL_DEFINITIONS.find((tool) => tool.name === toolName);

export const executeBuiltinTool = async (
  toolName: string,
  input: unknown,
  context: BuiltinToolContext = {},
): Promise<ToolExecutionResult> => {
  if (!isBuiltinToolName(toolName)) {
    return {
      output: `Unknown built-in tool: ${toolName}`,
      isError: true,
    };
  }

  const executor = BUILTIN_TOOL_EXECUTORS[toolName];
  if (!executor) {
    return {
      output: `Unknown built-in tool: ${toolName}`,
      isError: true,
    };
  }

  const result = await executor(input, context);
  return maybeMaterializeBuiltinToolImageRefs(toolName, result, context);
};
