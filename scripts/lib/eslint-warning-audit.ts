import { spawn } from 'node:child_process';

export interface EslintWarning {
  ruleId: string | null;
  filePath: string;
  line: number;
  column: number;
  message: string;
}

export interface EslintAuditResult {
  totalWarnings: number;
  perRuleCounts: Map<string, number>;
  warnings: EslintWarning[];
}

export interface EslintRunner {
  run(args: {
    paths: string[];
    extraArgs?: string[];
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  runOnStdin?(args: {
    content: string;
    filename: string;
    extraArgs?: string[];
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

interface EslintMessageJson {
  ruleId?: string | null;
  severity?: number;
  line?: number;
  column?: number;
  message?: string;
}

interface EslintFileResultJson {
  filePath?: string;
  messages?: EslintMessageJson[];
}

export const ESLINT_AUDIT_ARGS = [
  '--format',
  'json',
  '--no-warn-ignored',
  '--max-warnings',
  '99999',
  '--cache',
  '--cache-location',
  'node_modules/.cache/eslint/',
] as const;

export const DEFAULT_ESLINT_PATHS: readonly string[] = [
  'src/',
  'private/mindstone/src/',
  'cloud-service/src/',
  'cloud-client/src/',
  'mobile/src/',
  'mobile/app/',
  'evals/',
];

function chunkToString(chunk: Buffer | string): string {
  return typeof chunk === 'string' ? chunk : chunk.toString('utf8');
}

function normalizeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeMessage(message: EslintMessageJson): string {
  return typeof message.message === 'string' ? message.message : '';
}

function normalizeFilePath(filePath: unknown): string {
  return typeof filePath === 'string' && filePath.length > 0
    ? filePath
    : '<unknown-file>';
}

export function parseEslintJson(stdout: string): EslintAuditResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ESLint JSON output: ${details}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Failed to parse ESLint JSON output: expected an array');
  }

  const perRuleCounts = new Map<string, number>();
  const warnings: EslintWarning[] = [];

  for (const fileResult of parsed as EslintFileResultJson[]) {
    const filePath = normalizeFilePath(fileResult.filePath);
    const messages = Array.isArray(fileResult.messages) ? fileResult.messages : [];

    for (const message of messages) {
      if (message.severity !== 1) {
        continue;
      }

      const ruleId =
        typeof message.ruleId === 'string' ? message.ruleId : null;
      const ruleKey = ruleId ?? 'null';

      perRuleCounts.set(ruleKey, (perRuleCounts.get(ruleKey) ?? 0) + 1);
      warnings.push({
        ruleId,
        filePath,
        line: normalizeNumber(message.line),
        column: normalizeNumber(message.column),
        message: normalizeMessage(message),
      });
    }
  }

  return {
    totalWarnings: warnings.length,
    perRuleCounts,
    warnings,
  };
}

export async function runEslintAudit(
  runner: EslintRunner,
  paths: string[] = [...DEFAULT_ESLINT_PATHS],
): Promise<EslintAuditResult> {
  let result: { stdout: string; stderr: string; exitCode: number };

  try {
    result = await runner.run({
      paths: [...paths],
      extraArgs: [...ESLINT_AUDIT_ARGS],
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to run ESLint audit: ${details}`);
  }

  const maybeExitCode = (result as { exitCode: unknown }).exitCode;
  if (typeof maybeExitCode !== 'number' || !Number.isFinite(maybeExitCode)) {
    throw new Error(
      `ESLint audit terminated unexpectedly (invalid exit code: ${String(maybeExitCode)})`,
    );
  }

  try {
    return parseEslintJson(result.stdout);
  } catch (error) {
    if (result.exitCode !== 0) {
      const stderrPreview = result.stderr.trim().slice(0, 500);
      throw new Error(
        `ESLint exited with code ${result.exitCode} and emitted invalid JSON output${stderrPreview.length > 0 ? `: ${stderrPreview}` : ''}`,
      );
    }
    throw error;
  }
}

export function createDefaultEslintRunner(): EslintRunner {
  async function runDefaultEslintCommand(args: {
    eslintArgs: string[];
    stdinContent?: string;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { eslintArgs, stdinContent } = args;
    return new Promise<{ stdout: string; stderr: string; exitCode: number }>(
      (resolve, reject) => {
        const child = spawn('npx', ['eslint', ...eslintArgs], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (!child.stdin || !child.stdout || !child.stderr) {
          reject(new Error('Unable to capture ESLint output streams'));
          return;
        }

        let stdout = '';
        let stderr = '';
        let alreadyRejected = false;

        child.stdout.on('data', (chunk: Buffer | string) => {
          stdout += chunkToString(chunk);
        });
        child.stderr.on('data', (chunk: Buffer | string) => {
          stderr += chunkToString(chunk);
        });
        child.on('error', (error: Error) => {
          alreadyRejected = true;
          reject(new Error(`Failed to spawn ESLint: ${error.message}`));
        });
        child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
          if (alreadyRejected) {
            return;
          }
          if (code === null) {
            reject(
              new Error(
                `ESLint process terminated by signal ${signal ?? 'unknown'}`,
              ),
            );
            return;
          }

          resolve({ stdout, stderr, exitCode: code });
        });

        child.stdin.end(stdinContent);
      },
    );
  }

  return {
    async run({ paths, extraArgs = [] }) {
      return runDefaultEslintCommand({ eslintArgs: [...paths, ...extraArgs] });
    },

    async runOnStdin({ content, filename, extraArgs = [...ESLINT_AUDIT_ARGS] }) {
      return runDefaultEslintCommand({
        eslintArgs: ['--stdin', '--stdin-filename', filename, ...extraArgs],
        stdinContent: content,
      });
    },
  };
}
