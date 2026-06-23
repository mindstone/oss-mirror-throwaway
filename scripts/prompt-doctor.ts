#!/usr/bin/env npx tsx
/**
 * Prompt Doctor CLI
 *
 * Validates and debugs the composite system prompt configuration.
 * Use this to diagnose issues with system prompt rendering.
 *
 * Usage:
 *   npx tsx scripts/prompt-doctor.ts
 *   npm run prompt:doctor
 *
 * Options:
 *   --core <path>    Path to rebel-system/AGENTS.md (default: auto-detect)
 *   --user <path>    Path to Chief-of-Staff/AGENTS.md (default: auto-detect)
 *   --workspace <path>  Path to workspace (default: auto-detect from settings)
 *   --verbose        Show full rendered prompt (default: first 50 lines)
 *   --help           Show this help message
 *
 * Checks:
 * 1. Validates context against Zod schemas
 * 2. Renders composite for both runningInRebelApp=true and false
 * 3. Reports any validation errors or rendering failures
 * 4. Prints short hash and first N lines for inspection
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import nunjucks from 'nunjucks';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// =============================================================================
// Inline Zod Schemas (copied from promptTemplateService.ts)
// =============================================================================

const SpaceSummarySchema = z.object({
  name: z.string().min(1, 'Space name is required'),
  path: z.string().min(1, 'Space path is required'),
  description: z.string(),
  type: z.string().optional(),
  sharing: z.string().optional(),
});

const EnvContextSchema = z.object({
  date: z.string().min(1, 'date is required'),
  timeOfDayBucket: z.string().min(1, 'timeOfDayBucket is required'),
  timezone: z.string().min(1, 'timezone is required'),
  locale: z.string().min(1, 'locale is required'),
  platform: z.string().min(1, 'platform is required'),
  appVersion: z.string().min(1, 'appVersion is required'),
  buildChannel: z.string().min(1, 'buildChannel is required'),
  workspacePath: z.string().min(1, 'workspacePath is required'),
  mcpConfigPath: z.string().min(1, 'mcpConfigPath is required'),
  model: z.string().min(1, 'model is required'),
  spaces: z.array(SpaceSummarySchema).optional(),
});

const CompositePromptContextSchema = z.object({
  rebelSystemMd: z.string().min(1, 'rebelSystemMd is required and cannot be empty'),
  chiefOfStaffMd: z.string().min(1, 'chiefOfStaffMd is required and cannot be empty'),
  runningInRebelApp: z.boolean(),
  env: EnvContextSchema,
});

type CompositePromptContext = z.infer<typeof CompositePromptContextSchema>;

// =============================================================================
// Inline rendering functions
// =============================================================================

const EXTERNAL_IDE_FALLBACK_PATTERN = /<!--\s*EXTERNAL-IDE-FALLBACK:BEGIN\s*-->[\s\S]*?<!--\s*EXTERNAL-IDE-FALLBACK:END\s*-->/gi;

function stripExternalIdeFallback(content: string): string {
  return content.replace(EXTERNAL_IDE_FALLBACK_PATTERN, '').trim();
}

function validateCompositeContext(context: unknown): string[] {
  const result = CompositePromptContextSchema.safeParse(context);
  if (result.success) {
    return [];
  }
  return result.error.issues.map((issue) => {
    const issuePath = issue.path.join('.');
    return issuePath ? `${issuePath}: ${issue.message}` : issue.message;
  });
}

function renderCompositePrompt(context: CompositePromptContext): string {
  const env = new nunjucks.Environment(null, {
    throwOnUndefined: true,
    autoescape: false,
    trimBlocks: true,
    lstripBlocks: true
  });

  // Strip EXTERNAL-IDE-FALLBACK blocks when running in Rebel app mode
  const templateContent = context.runningInRebelApp
    ? stripExternalIdeFallback(context.rebelSystemMd)
    : context.rebelSystemMd;

  // Render rebel-system/AGENTS.md as the template, substituting chiefOfStaffMd and env
  return env.renderString(templateContent, context);
}

interface CliArgs {
  corePath?: string;
  userPath?: string;
  workspacePath?: string;
  verbose: boolean;
  help: boolean;
}

function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = { verbose: false, help: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--core':
        result.corePath = args[++i];
        break;
      case '--user':
        result.userPath = args[++i];
        break;
      case '--workspace':
        result.workspacePath = args[++i];
        break;
      case '--verbose':
        result.verbose = true;
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
    }
  }

  return result;
}

function showHelp(): void {
  console.log(`
Prompt Doctor CLI - Diagnose composite system prompt issues

Usage:
  npx tsx scripts/prompt-doctor.ts [options]
  npm run prompt:doctor

Options:
  --core <path>       Path to rebel-system/AGENTS.md
  --user <path>       Path to Chief-of-Staff/AGENTS.md
  --workspace <path>  Path to workspace root
  --verbose           Show full rendered prompt
  --help, -h          Show this help message

Examples:
  npx tsx scripts/prompt-doctor.ts
  npx tsx scripts/prompt-doctor.ts --workspace ~/my-workspace
  npx tsx scripts/prompt-doctor.ts --verbose
`);
}

function shortHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
}

function truncateLines(content: string, maxLines: number): string {
  const lines = content.split('\n');
  if (lines.length <= maxLines) {
    return content;
  }
  return lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} more lines)`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  console.log('');
  console.log('===========================================');
  console.log('  Prompt Doctor - Composite Prompt Check  ');
  console.log('===========================================');
  console.log('');

  let hasErrors = false;

  // Determine workspace path
  const workspacePath = args.workspacePath || process.env.REBEL_WORKSPACE || ROOT;
  console.log(`Workspace: ${workspacePath}`);

  // Determine file paths
  const corePath = args.corePath || path.join(workspacePath, 'rebel-system/AGENTS.md');
  const userPath = args.userPath || path.join(workspacePath, 'Chief-of-Staff/README.md');
  const legacyUserPath = path.join(workspacePath, 'Chief-of-Staff/AGENTS.md');

  console.log(`Core path: ${corePath}`);
  console.log(`User path: ${userPath}`);
  console.log('');

  // Check if files exist
  console.log('Checking files...');
  const coreExists = await fileExists(corePath);
  const userExists = await fileExists(userPath);
  const legacyUserExists = await fileExists(legacyUserPath);

  if (coreExists) {
    console.log(`  OK - rebel-system/AGENTS.md exists`);
  } else {
    console.error(`  FAIL - rebel-system/AGENTS.md not found at ${corePath}`);
    hasErrors = true;
  }

  if (userExists) {
    console.log(`  OK - Chief-of-Staff/README.md exists`);
  } else if (legacyUserExists) {
    console.log(`  WARN - Chief-of-Staff/README.md not found, using legacy AGENTS.md`);
  } else {
    console.log(`  WARN - Chief-of-Staff/README.md not found, will use minimal fallback`);
  }

  // Check symlinks for IDE fallback
  console.log('');
  console.log('Checking IDE fallback symlinks...');
  const rootAgentsMdPath = path.join(workspacePath, 'AGENTS.md');
  const rootClaudeMdPath = path.join(workspacePath, 'CLAUDE.md');

  try {
    const agentsMdStats = await fs.lstat(rootAgentsMdPath);
    if (agentsMdStats.isSymbolicLink()) {
      const agentsMdTarget = await fs.readlink(rootAgentsMdPath);
      if (agentsMdTarget === 'rebel-system/AGENTS.md' || agentsMdTarget.endsWith('/rebel-system/AGENTS.md')) {
        console.log(`  OK - AGENTS.md symlink points to rebel-system/AGENTS.md`);
      } else {
        console.log(`  WARN - AGENTS.md symlink exists but points to: ${agentsMdTarget}`);
      }
    } else {
      console.log(`  WARN - AGENTS.md exists but is not a symlink (will not update with rebel-system changes)`);
    }
  } catch {
    console.log(`  WARN - AGENTS.md symlink missing at workspace root (Cursor fallback will not work)`);
  }

  try {
    const claudeMdStats = await fs.lstat(rootClaudeMdPath);
    if (claudeMdStats.isSymbolicLink()) {
      const claudeMdTarget = await fs.readlink(rootClaudeMdPath);
      if (claudeMdTarget === 'AGENTS.md') {
        console.log(`  OK - CLAUDE.md symlink points to AGENTS.md`);
      } else {
        console.log(`  WARN - CLAUDE.md symlink exists but points to: ${claudeMdTarget}`);
      }
    } else {
      console.log(`  WARN - CLAUDE.md exists but is not a symlink (will not update with rebel-system changes)`);
    }
  } catch {
    console.log(`  WARN - CLAUDE.md symlink missing at workspace root (Claude Code fallback will not work)`);
  }
  console.log('');

  if (hasErrors) {
    console.error('Cannot proceed - fix file issues first\n');
    process.exit(1);
  }

  // Load file contents
  console.log('Loading file contents...');
  const rebelSystemMd = await readFileIfExists(corePath);
  let chiefOfStaffMd = await readFileIfExists(userPath);

  if (!chiefOfStaffMd && legacyUserExists) {
    chiefOfStaffMd = await readFileIfExists(legacyUserPath);
    console.log('  Using legacy Chief-of-Staff/AGENTS.md');
  }

  if (!chiefOfStaffMd) {
    // Use minimal fallback - template is for creating files, not runtime inclusion
    chiefOfStaffMd = '# Chief of Staff\n\n(Chief-of-Staff space not yet configured)';
    console.log('  Using minimal fallback for Chief-of-Staff');
  }

  if (!rebelSystemMd) {
    console.error(`  FAIL - Could not read rebel-system/AGENTS.md`);
    process.exit(1);
  }

  console.log(`  rebel-system/AGENTS.md: ${rebelSystemMd.length} chars, hash=${shortHash(rebelSystemMd)}`);
  console.log(`  Chief-of-Staff/README.md: ${chiefOfStaffMd.length} chars, hash=${shortHash(chiefOfStaffMd)}`);
  console.log('');

  // Create mock env context for testing
  const mockEnv = {
    date: '2025-11-30 (Saturday)',
    timeOfDayBucket: 'afternoon',
    timezone: 'UTC (+00:00)',
    locale: 'en-US',
    platform: 'darwin 24.6.0 (arm64)',
    appVersion: '0.2.2',
    buildChannel: 'dev',
    workspacePath: workspacePath,
    mcpConfigPath: path.join(workspacePath, 'mcp.json'),
    model: 'claude-sonnet-4-6',
    spaces: [
      { name: 'Chief-of-Staff', path: 'Chief-of-Staff/', description: 'Router and cross-space context' },
    ],
  };

  // Validate context
  console.log('Validating context schema...');
  const context = {
    rebelSystemMd,
    chiefOfStaffMd,
    runningInRebelApp: true,
    env: mockEnv,
  };

  const validationErrors = validateCompositeContext(context);
  if (validationErrors.length === 0) {
    console.log('  OK - Context validates against schema\n');
  } else {
    console.error('  FAIL - Validation errors:');
    for (const error of validationErrors) {
      console.error(`    - ${error}`);
    }
    console.log('');
    hasErrors = true;
  }

  // Test rendering with runningInRebelApp=true
  console.log('Rendering with runningInRebelApp=true...');
  let renderedInApp: string | null = null;
  try {
    renderedInApp = renderCompositePrompt({ ...context, runningInRebelApp: true });
    console.log(`  OK - Rendered successfully`);
    console.log(`  Length: ${renderedInApp.length} chars, hash=${shortHash(renderedInApp)}`);
  } catch (error) {
    console.error(`  FAIL - Rendering error: ${error instanceof Error ? error.message : String(error)}`);
    hasErrors = true;
  }
  console.log('');

  // Test rendering with runningInRebelApp=false
  console.log('Rendering with runningInRebelApp=false (Cursor mode)...');
  let renderedCursor: string | null = null;
  try {
    renderedCursor = renderCompositePrompt({ ...context, runningInRebelApp: false });
    console.log(`  OK - Rendered successfully`);
    console.log(`  Length: ${renderedCursor.length} chars, hash=${shortHash(renderedCursor)}`);
  } catch (error) {
    console.error(`  FAIL - Rendering error: ${error instanceof Error ? error.message : String(error)}`);
    hasErrors = true;
  }
  console.log('');

  // Check for fallback block difference
  if (renderedInApp && renderedCursor) {
    const sizeDiff = renderedCursor.length - renderedInApp.length;
    if (sizeDiff > 0) {
      console.log(`Fallback block check: Cursor mode is ${sizeDiff} chars longer (expected if EXTERNAL-IDE-FALLBACK blocks exist)`);
    } else if (sizeDiff === 0) {
      console.log('Fallback block check: No EXTERNAL-IDE-FALLBACK blocks detected (both renders identical)');
    } else {
      console.log('Fallback block check: Unexpected - Rebel app mode is longer (check for issues)');
    }
    console.log('');
  }

  // Preview rendered output
  if (renderedInApp) {
    console.log('=== RENDERED PREVIEW (runningInRebelApp=true) ===');
    console.log('');
    if (args.verbose) {
      console.log(renderedInApp);
    } else {
      console.log(truncateLines(renderedInApp, 50));
    }
    console.log('');
    console.log('=== END PREVIEW ===');
    console.log('');
  }

  // Summary
  console.log('===========================================');
  if (hasErrors) {
    console.log('  RESULT: FAIL - Issues detected');
    console.log('===========================================');
    console.log('');
    process.exit(1);
  } else {
    console.log('  RESULT: PASS - All checks passed');
    console.log('===========================================');
    console.log('');
  }
}

main().catch((error) => {
  console.error('Prompt Doctor failed:', error);
  process.exit(1);
});
