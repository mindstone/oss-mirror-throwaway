import fs from 'node:fs/promises';
import path from 'node:path';
import * as crypto from 'node:crypto';
import type { Logger } from 'pino';
import { createScopedLogger } from '@core/logger';
import { assertWithinRoot } from '@core/utils/pathSafety';
import { withRetryOnEmfile } from '@core/utils/emfileRetry';
import { redactSensitiveString } from '@shared/utils/sentryRedaction';

export const MATERIALIZATION_THRESHOLD_CHARS = 20_000;
export const MATERIALIZATION_SIZE_CAP_BYTES = 20 * 1024 * 1024;

const TOOL_OUTPUTS_RELATIVE_DIR = ['.rebel', 'tool-outputs'] as const;
const PREVIEW_CHARS = 2_048;

const materializationLog = createScopedLogger({ service: 'rebelCore.bash.materialization' });
type MaterializationLogger = Pick<Logger, 'info' | 'warn'>;

export interface WriteMaterialisedFileParams {
  workspacePath?: string | null;
  filenamePrefix: string;
  content: string;
  ext: string;
  sizeCap: number;
  log?: MaterializationLogger;
}

export interface WriteMaterialisedFileResult {
  relativePath: string;
  absolutePath: string;
  sizeChars: number;
  materialized: true;
}

export interface MaterializeBuiltinBashOutputParams {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  workspacePath?: string | null;
  threshold?: number;
  sizeCap?: number;
  log?: MaterializationLogger;
}

export interface MaterializedBuiltinBashOutput {
  output: string;
  sizeChars: number;
  materialized: true;
}

const sanitizeForFilename = (value: string): string => {
  const sanitized = value
    .replace(/[\\/:*?"<>|\n\r]/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/^\.+$/, '_')
    .slice(0, 80);
  return sanitized.length > 0 ? sanitized : 'tool';
};

const normalizeExtension = (ext: string): string => {
  const withoutDot = ext.startsWith('.') ? ext.slice(1) : ext;
  return sanitizeForFilename(withoutDot || 'txt');
};

const buildMaterializedFilename = (filenamePrefix: string, ext: string): string => {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const HH = String(now.getHours()).padStart(2, '0');
  const MM = String(now.getMinutes()).padStart(2, '0');
  // 4 random bytes = 8 hex chars (~4.3B collision space). Matches Super-MCP's pattern;
  // protects against same-minute concurrent materialisations silently overwriting each other.
  const randomHexSuffix = crypto.randomBytes(4).toString('hex');
  return `${yy}${mm}${dd}_${HH}${MM}_${sanitizeForFilename(filenamePrefix)}_${randomHexSuffix}.${normalizeExtension(ext)}`;
};

const getErrorCode = (error: unknown): string | undefined => {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
};

const getErrorMessage = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const getToolNameForPrefix = (filenamePrefix: string): string => (
  filenamePrefix === 'bash' ? 'Bash' : filenamePrefix
);

export async function writeMaterialisedFile({
  workspacePath,
  filenamePrefix,
  content,
  ext,
  sizeCap,
  log = materializationLog,
}: WriteMaterialisedFileParams): Promise<WriteMaterialisedFileResult | null> {
  const sizeBytes = Buffer.byteLength(content, 'utf8');
  const sizeChars = content.length;
  const toolName = getToolNameForPrefix(filenamePrefix);

  if (process.env.REBEL_DISABLE_BASH_MATERIALIZATION) {
    log.info(
      {
        event: 'materialization_skipped_killswitch',
        materializer: 'builtin-bash',
        tool_name: toolName,
        size_chars: sizeChars,
      },
      'Bash materialization skipped by kill-switch',
    );
    return null;
  }

  if (!workspacePath) {
    log.warn(
      {
        event: 'materialization_skipped_no_workspace',
        materializer: 'builtin-bash',
        tool_name: toolName,
        size_chars: sizeChars,
      },
      'Bash materialization skipped: no workspace path',
    );
    return null;
  }

  if (sizeBytes > sizeCap) {
    log.warn(
      {
        event: 'materialization_skipped_size_cap',
        materializer: 'builtin-bash',
        tool_name: toolName,
        size_chars: sizeChars,
        size_bytes: sizeBytes,
        size_cap_bytes: sizeCap,
      },
      'Bash materialization skipped: output exceeds size cap',
    );
    return null;
  }

  const targetDir = path.join(workspacePath, ...TOOL_OUTPUTS_RELATIVE_DIR);
  const filename = buildMaterializedFilename(filenamePrefix, ext);

  try {
    await withRetryOnEmfile(() => fs.mkdir(targetDir, { recursive: true }));

    const [workspaceRealPath, targetDirRealPath] = await Promise.all([
      withRetryOnEmfile(() => fs.realpath(workspacePath)),
      withRetryOnEmfile(() => fs.realpath(targetDir)),
    ]);
    // Symlink-escape guard: the resolved target directory must stay under the
    // resolved workspace path. Trust mode (REBEL_BASH_MATERIALIZATION_TRUST_SYMLINK)
    // exists for the eval harness, which deliberately symlinks `.rebel/tool-outputs/`
    // out of the per-fixture sandbox to a shared `evalWorkspaceBase` dir (see
    // `evals/knowledge-work.ts` "Symlinked tool-outputs"). In production this
    // env var is never set; the realpath containment check stays in force.
    if (process.env.REBEL_BASH_MATERIALIZATION_TRUST_SYMLINK !== '1') {
      assertWithinRoot(targetDirRealPath, workspaceRealPath);
    }

    const absolutePath = path.join(targetDirRealPath, filename);
    const tmpPath = `${absolutePath}.tmp`;
    // POSIX-style separators in the model-facing relative path: avoids JSON-escaping
    // hazards on Windows (`.rebel\tool-outputs\...` containing `\t` would deserialise
    // as a tab) and gives the agent a cross-platform stable shape for Read/Grep.
    const relativePath = [...TOOL_OUTPUTS_RELATIVE_DIR, filename].join('/');

    try {
      await withRetryOnEmfile(() => fs.writeFile(tmpPath, content, 'utf8'));
      await withRetryOnEmfile(() => fs.rename(tmpPath, absolutePath));
    } catch (writeError) {
      try {
        await withRetryOnEmfile(() => fs.unlink(tmpPath));
      } catch {
        // Best-effort cleanup only; the fallback warning below is the observable failure.
      }
      throw writeError;
    }

    log.info(
      {
        event: 'materialization_success',
        materializer: 'builtin-bash',
        tool_name: toolName,
        size_chars: sizeChars,
        relative_path: relativePath,
      },
      'Bash output materialized',
    );

    return {
      relativePath,
      absolutePath,
      sizeChars,
      materialized: true,
    };
  } catch (error) {
    log.warn(
      {
        event: 'materialization_failed_fallback',
        materializer: 'builtin-bash',
        tool_name: toolName,
        size_chars: sizeChars,
        error_code: getErrorCode(error),
        error_message: getErrorMessage(error),
      },
      'Bash materialization failed; falling back to inline truncation',
    );
    return null;
  }
}

export interface MaterializeBuiltinToolOutputParams {
  /** Short tool/source label used as the materialised filename prefix (e.g. `read`). */
  filenamePrefix: string;
  /** Full content to persist to `.rebel/tool-outputs/` (lossless). */
  content: string;
  /** File extension for the materialised archive (defaults to `txt`). */
  ext?: string;
  workspacePath?: string | null;
  sizeCap?: number;
  log?: MaterializationLogger;
}

/**
 * Generalised, best-effort materialiser for ANY built-in tool whose model-facing
 * output had to be truncated/omitted (e.g. `Read` on a large text file or an
 * oversized binary). Writes the full `content` to `.rebel/tool-outputs/` so it is
 * recoverable, and returns the relative path to cite in the model-facing note.
 *
 * Degrades gracefully (returns `null`) when there is no workspace, the kill-switch
 * is set, the content exceeds `sizeCap`, or any I/O error occurs — callers MUST
 * still produce a bounded inline placeholder so safety never depends on the write.
 *
 * This generalises the Bash-only `materializeBuiltinBashOutput` per
 * docs/plans/260529_guard-large-tool-outputs/PLAN.md § Stage 3.
 */
export async function materializeBuiltinToolOutput({
  filenamePrefix,
  content,
  ext = 'txt',
  workspacePath,
  sizeCap = MATERIALIZATION_SIZE_CAP_BYTES,
  log = materializationLog,
}: MaterializeBuiltinToolOutputParams): Promise<WriteMaterialisedFileResult | null> {
  return writeMaterialisedFile({
    workspacePath,
    filenamePrefix,
    content,
    ext,
    sizeCap,
    log,
  });
}

const buildBashArchiveContent = ({
  command,
  stdout,
  stderr,
  exitCode,
}: Pick<MaterializeBuiltinBashOutputParams, 'command' | 'stdout' | 'stderr' | 'exitCode'>): string => [
  `Command exited with status ${exitCode ?? 'null'}.`,
  `Command (redacted): ${redactSensitiveString(command)}`,
  '',
  'stdout:',
  stdout,
  '',
  'stderr:',
  stderr,
].join('\n');

export async function materializeBuiltinBashOutput({
  command,
  stdout,
  stderr,
  exitCode,
  workspacePath,
  threshold = MATERIALIZATION_THRESHOLD_CHARS,
  sizeCap = MATERIALIZATION_SIZE_CAP_BYTES,
  log = materializationLog,
}: MaterializeBuiltinBashOutputParams): Promise<MaterializedBuiltinBashOutput | null> {
  const totalChars = stdout.length + stderr.length;
  if (totalChars <= threshold) {
    return null;
  }

  const archiveContent = buildBashArchiveContent({ command, stdout, stderr, exitCode });
  const materialized = await writeMaterialisedFile({
    workspacePath,
    filenamePrefix: 'bash',
    content: archiveContent,
    ext: 'txt',
    sizeCap,
    log,
  });

  if (!materialized) {
    return null;
  }

  // Code-point-safe preview slicing — `String.prototype.slice` works on UTF-16 code
  // units and can split surrogate pairs (emoji, astral characters), producing lone
  // surrogates. `Array.from(s)` iterates by Unicode code point.
  const sliceByCodePoints = (input: string, max: number): string => {
    if (input.length <= max) return input;
    const codePoints = Array.from(input);
    return codePoints.length <= max ? input : codePoints.slice(0, max).join('');
  };

  const previewLabel = stdout.length > 0 ? 'Stdout' : 'Stderr';
  const previewSource = stdout.length > 0 ? stdout : stderr;
  const preview = sliceByCodePoints(previewSource, PREVIEW_CHARS);

  return {
    output: [
      `Command exited with status ${exitCode ?? 'null'}. ${previewLabel} (first ${preview.length} chars):`,
      preview,
      `[output truncated — full ${totalChars} chars saved to ${materialized.relativePath}; use Read with offset/limit or Grep on this file]`,
    ].join('\n'),
    sizeChars: totalChars,
    materialized: true,
  };
}
