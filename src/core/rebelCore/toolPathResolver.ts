/**
 * Path validation for built-in file tools (Read / Write / Edit).
 *
 * **Why this exists:**
 * The built-in Write tool was originally sandboxed to the agent's `cwd` (=
 * user's Rebel workspace root, typically `~/Documents/Rebel/`). But the
 * `build-custom-mcp-server` skill mandates that all connector project files
 * live under `~/mcp-servers/<project>/` — which is outside the workspace.
 * That left the skill structurally unreachable from the Write tool: every
 * Phase 4.2 scaffold `Write` call failed with "Path is outside workspace
 * root". See `docs-private/investigations/260420_phase8_predev_submodule_detach.md`
 * (for the adjacent Phase 8 investigation) and this postmortem:
 * `docs-private/postmortems/260420_mcp_write_sandbox_mismatch_postmortem.md`.
 *
 * **Policy:**
 * A path is accepted if it resolves under either
 *   (a) the agent's `cwd` (workspace root), or
 *   (b) `<homePath>/mcp-servers/<project>/…` — i.e. an MCP project under the
 *       canonical location used by the build skill and the MCPBuildCard
 *       auto-detect hook (`src/main/services/mcpBuildAutoDetectHook.ts`).
 *
 *       Special case: when the project segment is literally
 *       `mcp-servers-repo` (the cloned upstream used by the
 *       `extend-mcp-server` skill), writes are only permitted under
 *       `connectors/<name>/…`. The `<name>` segment is treated as the
 *       effective project root and the same connector-shape allowlist
 *       applies to everything beneath it. This lets the extend skill ship
 *       source, tests and docs for a single connector without granting
 *       write access to the repo's top-level files.
 *
 * For the **Write** tool only, paths under `mcp-servers/<project>/` must
 * additionally match an MCP-project filename shape allowlist. This keeps the
 * sandbox widening purpose-shaped: an off-script agent can still only create
 * legitimate MCP project files (`package.json`, `src/**`, `docs/**`, etc.)
 * and not secrets (`.env`), shell scripts at project root, or arbitrary data.
 *
 * **Read** and **Edit** skip the filename allowlist because they act on
 * files that already exist — lower risk than creation.
 *
 * The exact contract between the SKILL.md paths and this resolver is
 * verified by `__tests__/skillPathContract.test.ts`: every `~/mcp-servers/…`
 * path mentioned in the bundled skill must be acceptable to this helper.
 */

import path from 'node:path';
import {
  expandLeadingTildePath,
  pathStartsUnderHomeMcpServers,
} from '@shared/utils/contributionPathClassifier';

export type ToolKind = 'Read' | 'Write' | 'Edit' | 'Glob' | 'LS';

export type ToolPathResolution =
  | { ok: true; resolvedPath: string; allowReason: 'workspace' | 'mcp-project' }
  | { ok: false; error: string; reason: PathRejectionReason };

export type PathRejectionReason =
  | 'outside-allowed-zones'
  | 'mcp-servers-root-only' // resolved to ~/mcp-servers/ itself, no project subdir
  | 'managed-repo-root-only' // resolved to ~/mcp-servers/mcp-servers-repo/ without connectors/<name>/
  | 'mcp-allowlist-miss';   // Write rejected because filename not in MCP-project shape

export interface ResolveToolPathOptions {
  /** The agent's workspace root (cwd). Falls back to `process.cwd()`. */
  cwd?: string;
  /**
   * The user's home directory. If undefined, the mcp-servers exception is
   * disabled (only `cwd`-relative paths resolve). Caller should pass
   * `getPlatformConfig().homePath`.
   */
  homePath?: string;
  /** Which built-in tool is resolving — determines allowlist enforcement. */
  tool: ToolKind;
}

/**
 * Filenames that are acceptable at the root of an MCP project directory
 * (e.g. `~/mcp-servers/foo-mcp/<filename>`). Case-insensitive match.
 */
const MCP_PROJECT_ROOT_FILES: ReadonlySet<string> = new Set([
  'package.json',
  'package-lock.json',
  'readme.md',
  'license',
  'license.md',
  'license.txt',
  'changelog.md',
  'catalog-entry.json', // extend-mcp-server: connector catalog metadata
  '.gitignore',
  '.env.example',
  '.nvmrc',
  '.npmrc',
  '.editorconfig',
  '.prettierrc',
  '.prettierrc.json',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.cjs',
  '.eslintrc.js',
]);

/**
 * Filename regex for variants (e.g. `tsconfig.json`, `tsconfig.build.json`).
 * Case-insensitive.
 */
const MCP_PROJECT_ROOT_FILE_PATTERNS: readonly RegExp[] = [
  /^tsconfig(\..+)?\.json$/i,
  /^jest\.config\.(js|ts|cjs|mjs|json)$/i,
  /^vitest\.config\.(js|ts|cjs|mjs)$/i,
];

/**
 * Path-segment prefixes (relative to the MCP project root) that are open to
 * arbitrary file creation. E.g. `src/`, `docs/`, `tests/`, `__tests__/`.
 * Case-insensitive comparison.
 */
const MCP_PROJECT_ALLOWED_SUBDIRS: readonly string[] = [
  'src',
  'docs',
  'tests',
  'test',
  '__tests__',
  'scripts',
  'examples',
  'dist',
  'build',
  'lib',
  'types',
  'public',
  'assets',
  'fixtures',
];

/**
 * Normalize path separators and case for comparison.
 */
function toPortable(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * Name of the cloned upstream OSS MCP repo used by the `extend-mcp-server`
 * skill. When the first segment under `~/mcp-servers/` is this name, the
 * resolver treats it as a managed-repo container rather than a single
 * project: only paths under `connectors/<name>/...` are allowed, and the
 * effective "project root" for allowlist purposes is `connectors/<name>/`.
 */
const MANAGED_REPO_NAME = 'mcp-servers-repo';

/**
 * Result of unpacking a path under `~/mcp-servers/...`.
 *
 * `kind: 'project'` — simple case, project root is `~/mcp-servers/<project>/`.
 * `kind: 'managed-repo-connector'` — extend-mcp-server case, effective
 *   project root is `~/mcp-servers/mcp-servers-repo/connectors/<name>/` and
 *   `relativePath` is the tail beneath it.
 */
type McpRelativePathClassification =
  | {
      kind: 'project';
      projectName: string;
      relativePath: string;
    }
  | {
      kind: 'managed-repo-connector';
      connectorName: string;
      relativePath: string;
    };

/**
 * Given a resolved absolute path known to be under
 * `<homePath>/mcp-servers/`, classify it as either a standalone project
 * path (`~/mcp-servers/<project>/...`) or a managed-repo connector path
 * (`~/mcp-servers/mcp-servers-repo/connectors/<name>/...`).
 *
 * Returns `null` for paths that target the `~/mcp-servers/` root itself,
 * or `~/mcp-servers/mcp-servers-repo/` without a `connectors/<name>/` tail.
 */
function classifyMcpRelativePath(
  resolvedPath: string,
  homePath: string,
): McpRelativePathClassification | { rejection: 'mcp-servers-root-only' | 'managed-repo-root-only' } | null {
  const portableResolved = toPortable(resolvedPath).replace(/\/+$/, '');
  const portableHome = toPortable(homePath).replace(/\/+$/, '');
  const mcpServersPrefix = `${portableHome}/mcp-servers`;

  if (!portableResolved.toLowerCase().startsWith(`${mcpServersPrefix.toLowerCase()}/`)) {
    return null;
  }

  const tail = portableResolved.slice(mcpServersPrefix.length + 1);
  const segments = tail.split('/').filter((seg) => seg.length > 0);

  if (segments.length < 2) {
    return { rejection: 'mcp-servers-root-only' };
  }

  const [firstSeg, ...rest] = segments;

  if (firstSeg.toLowerCase() === MANAGED_REPO_NAME) {
    // Managed repo: must be `connectors/<name>/<relativePath>`.
    // Reject bare writes to the repo root, `connectors/` dir, or
    // `connectors/<name>` (directory marker, no file).
    if (
      rest.length < 3 ||
      rest[0].toLowerCase() !== 'connectors' ||
      rest[1].length === 0
    ) {
      return { rejection: 'managed-repo-root-only' };
    }
    const connectorName = rest[1];
    const relativePath = rest.slice(2).join('/');
    return {
      kind: 'managed-repo-connector',
      connectorName,
      relativePath,
    };
  }

  return {
    kind: 'project',
    projectName: firstSeg,
    relativePath: rest.join('/'),
  };
}

/**
 * Check whether a relative project path matches the Write-tool allowlist.
 * The project-root file check is case-insensitive; subdir prefix check is
 * case-insensitive on the first segment only.
 */
export function isAllowedMcpProjectWritePath(relativePath: string): boolean {
  const segments = relativePath.split('/').filter((seg) => seg.length > 0);
  if (segments.length === 0) return false;

  // File at project root.
  if (segments.length === 1) {
    const fileName = segments[0];
    const lower = fileName.toLowerCase();
    if (MCP_PROJECT_ROOT_FILES.has(lower)) return true;
    return MCP_PROJECT_ROOT_FILE_PATTERNS.some((re) => re.test(fileName));
  }

  // File inside a subdir — check the first segment.
  const firstSeg = segments[0].toLowerCase();
  return MCP_PROJECT_ALLOWED_SUBDIRS.includes(firstSeg);
}

/**
 * Resolve and validate a file path for the Read / Write / Edit built-in
 * tools. See module docstring for the policy.
 */
export function resolveToolPath(
  filePath: string,
  opts: ResolveToolPathOptions,
): ToolPathResolution {
  const workspaceRoot = path.resolve(opts.cwd ?? process.cwd());
  const homePath = opts.homePath;

  // Expand `~/` if a homePath is available, so both `~/mcp-servers/foo` and
  // `/Users/you/mcp-servers/foo` reach the same resolved absolute path.
  // If homePath is undefined we still allow absolute paths (falls back to
  // the original workspace-only contract).
  const expanded = homePath ? expandLeadingTildePath(filePath, homePath) : filePath;

  const resolvedPath = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(workspaceRoot, expanded);

  // 1. Workspace-root acceptance (unchanged original behaviour).
  const relativeToWorkspace = path.relative(workspaceRoot, resolvedPath);
  const insideWorkspace =
    relativeToWorkspace.length > 0 &&
    !relativeToWorkspace.startsWith('..') &&
    !path.isAbsolute(relativeToWorkspace);
  const isWorkspaceRoot = relativeToWorkspace === '';
  if (insideWorkspace || isWorkspaceRoot) {
    return { ok: true, resolvedPath, allowReason: 'workspace' };
  }

  // 2. MCP project acceptance: only if homePath is available.
  if (homePath && pathStartsUnderHomeMcpServers(resolvedPath, homePath)) {
    const classification = classifyMcpRelativePath(resolvedPath, homePath);

    if (classification === null) {
      // Shouldn't happen — pathStartsUnderHomeMcpServers said yes but the
      // classifier disagrees. Treat as outside-allowed-zones to fail closed.
      return {
        ok: false,
        error: `Path is outside allowed zones: ${filePath}.`,
        reason: 'outside-allowed-zones',
      };
    }

    if ('rejection' in classification) {
      if (classification.rejection === 'managed-repo-root-only') {
        return {
          ok: false,
          error:
            'Path targets the mcp-servers-repo without naming a connector. ' +
            'Writes under the managed repo are only allowed inside connectors/<name>/ (e.g. ~/mcp-servers/mcp-servers-repo/connectors/slack/src/tool.ts).',
          reason: 'managed-repo-root-only',
        };
      }
      return {
        ok: false,
        error:
          'Path resolves to ~/mcp-servers/ itself or a file at that root. Writes must target a project subdirectory (e.g. ~/mcp-servers/<api-name>-mcp/).',
        reason: 'mcp-servers-root-only',
      };
    }

    // Write is the only tool that enforces the filename allowlist. For both
    // the standalone-project and managed-repo-connector shapes, the relative
    // path is checked against the same connector-project allowlist — the
    // file layout of an OSS connector inside mcp-servers-repo is the same
    // shape as a standalone custom MCP project.
    if (opts.tool === 'Write') {
      const relative = classification.relativePath;
      if (!isAllowedMcpProjectWritePath(relative)) {
        return {
          ok: false,
          error:
            `MCP project file "${relative}" is not in the allowed shape for Write. ` +
            'Allowed at project root: package.json, tsconfig.json, README.md, LICENSE, .gitignore, .env.example, .nvmrc, catalog-entry.json. ' +
            'Allowed subdirs: src/, docs/, tests/, test/, __tests__/, scripts/, examples/, dist/. ' +
            'See rebel-system/skills/coding/build-custom-mcp-server/SKILL.md and extend-mcp-server/SKILL.md.',
          reason: 'mcp-allowlist-miss',
        };
      }
    }

    return { ok: true, resolvedPath, allowReason: 'mcp-project' };
  }

  // 3. Outside both allowed zones.
  return {
    ok: false,
    error: `Path is outside allowed zones: ${filePath}. Allowed: workspace root (${workspaceRoot}) or ~/mcp-servers/<project>/ when building an MCP connector.`,
    reason: 'outside-allowed-zones',
  };
}
