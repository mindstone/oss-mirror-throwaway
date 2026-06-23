import fs from "node:fs/promises";
import { realpathSync, lstatSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { getPlatformConfig } from "@core/platform";
import { logger } from "@core/logger";
import { detectCloudStorage } from "@core/utils/cloudStorageUtils";
import {
  buildSymlinkMap,
  convertPathWithSymlinkMap,
  type SymlinkMapping,
} from "@core/utils/symlinkMap";

/**
 * Check if `target` path is contained within `container` path.
 * Uses proper path boundary checking to avoid false matches like /foo/bar2 matching /foo/bar.
 * Cross-platform: handles both forward and back slashes.
 */
const isPathContainedIn = (target: string, container: string): boolean => {
  // Normalize paths to handle different separators
  const normalizedTarget = path.normalize(target);
  const normalizedContainer = path.normalize(container);
  
  // Exact match
  if (normalizedTarget === normalizedContainer) return true;
  
  // Check if target starts with container followed by a path separator
  // This prevents /foo/bar2 from matching /foo/bar
  return normalizedTarget.startsWith(normalizedContainer + path.sep);
};

/**
 * Get the relative path from container to target, assuming target is contained in container.
 * Cross-platform: uses path.relative() which handles separators correctly.
 */
const getContainedRelativePath = (target: string, container: string): string => {
  return path.relative(container, target);
};

/**
 * Try to convert an absolute path to a relative workspace path.
 *
 * Returns the relative path if the target is accessible through the workspace
 * (directly, or via a symlink mounted into the workspace), null otherwise.
 *
 * Use case: Tool events can contain resolved/real paths when files are accessed
 * through symlinks. This helper converts them back to workspace-relative paths
 * for display in the UI (e.g., File Activity pane).
 *
 * Performance: this used to perform an O(workspace-size) synchronous filesystem
 * walk (readdir + lstat + realpath) on EVERY call — the dominant idle-CPU
 * hotspot. It now resolves in two stages:
 *
 *  1. Fast path — realpath both ends and compute `path.relative`. If the
 *     target's real path is under the workspace's real root, return the
 *     relative path with ZERO directory scanning. This covers all ordinary
 *     nested files, root-level files, and symlinked-workspace-root cases.
 *  2. Symlink fallback — only when the fast path misses, consult a symlink
 *     registry (built once via {@link buildSymlinkMap}, depth/skip parity with
 *     the legacy walker) to handle the genuinely-needed case: a symlink INSIDE
 *     the workspace pointing OUTSIDE the real root, with the target under it.
 *
 * Handles nested symlinks up to 4 levels deep (e.g., work/Company/DriveName).
 *
 * @param absolutePath - the absolute path to convert (will be realpath-resolved).
 * @param workspaceRoot - the workspace root directory.
 * @param symlinkMap - OPTIONAL pre-built symlink registry. When omitted, one is
 *   built per call (Stage 1 behavior). Stage 2 callers should pass a cached map
 *   to avoid the one-time scan on hot paths.
 */
export const tryConvertToWorkspacePath = (
  absolutePath: string,
  workspaceRoot: string,
  symlinkMap?: SymlinkMapping[],
): string | null => {
  // RS-F1 residual (Stage 5 carry-forward): a cloud-classified ABSOLUTE target
  // must NOT be `realpathSync`'d on the main thread. `realpathSync` dereferences
  // the (possibly dead) cloud FUSE mount and blocks in the kernel with no timeout
  // — the libuv-threadpool-exhaustion hang (0.4.48→0.4.49 class). Decide via the
  // pure-string `detectCloudStorage` (no I/O) BEFORE touching the target, and
  // degrade to non-resolvable (null) — consistent with the existing
  // realpath-failure handling below. Cloud-backed targets are excluded from the
  // workspace index anyway, so they have no workspace-relative form to return;
  // normal reads are workspace-relative and never reach here. LOCAL paths keep
  // the exact realpath fast path unchanged.
  if (detectCloudStorage(absolutePath).isCloud) {
    return null;
  }
  let realTarget: string;
  try {
    // Get the real path of the target (following all symlinks).
    // Throws for deleted/nonexistent paths -> return null (do NOT cache failure).
    realTarget = realpathSync(absolutePath);
  } catch {
    return null;
  }

  // Stage 1 — fast realpath-containment path (no directory scan).
  // Realpath the root too so a symlinked workspace root maps correctly.
  //
  // S4.1f MUST-FIX C residual: the TARGET cloud-guard above only covers a
  // cloud-classified target. Here the target is local but the workspace ROOT
  // itself can be cloud-hosted (a workspace placed under
  // `~/Library/CloudStorage/…`). `realpathSync(workspaceRoot)` on a dead cloud
  // FUSE mount blocks the main thread with no timeout (a hang, NOT a throw, so
  // the catch can't rescue it). Decide via the pure-string `detectCloudStorage`
  // (no I/O) BEFORE the probe and skip straight to `path.resolve` — IDENTICAL to
  // the existing catch fallback, so a cloud root degrades to the same lexical
  // root the catch already produced (no behaviour change for the resolution
  // result; we only avoid the kernel block). LOCAL roots keep the realpath path.
  let realRoot: string;
  if (detectCloudStorage(workspaceRoot).isCloud) {
    realRoot = path.resolve(workspaceRoot);
  } else {
    try {
      realRoot = realpathSync(workspaceRoot);
    } catch {
      realRoot = path.resolve(workspaceRoot);
    }
  }

  const relFromRoot = path.relative(realRoot, realTarget);
  // Parity note: the legacy walker returns `null` for the workspace root ITSELF
  // (no child entry's realpath contains the root), so we intentionally do NOT
  // short-circuit `relFromRoot === ""` to a relative path here — we let it fall
  // through to the symlink fallback, which also returns null for the bare root.
  if (
    relFromRoot !== "" &&
    relFromRoot !== ".." &&
    !relFromRoot.startsWith(".." + path.sep) &&
    !path.isAbsolute(relFromRoot)
  ) {
    // Contained strictly under the (real) workspace root.
    // path.relative already normalizes; matches legacy path.join semantics.
    return path.normalize(relFromRoot);
  }

  // Stage 2 — symlink fallback. The target's real path is outside the real
  // workspace root; the only way it is reachable is through a symlink mounted
  // into the workspace pointing at (an ancestor of) the target.
  const mappings = symlinkMap ?? buildSymlinkMap(workspaceRoot);
  return convertPathWithSymlinkMap(realTarget, mappings);
};

/**
 * Legacy O(workspace-size) implementation, retained ONLY as a parity oracle for
 * tests. Do not use on hot paths. See {@link tryConvertToWorkspacePath}.
 *
 * @internal
 */
// bounded-walker-pending: see docs/plans/260503_s9_bounded_walker_resource_budget.md
export const tryConvertToWorkspacePathLegacy = (
  absolutePath: string,
  workspaceRoot: string,
): string | null => {
  try {
    // Get the real path of the target (following all symlinks)
    const realTarget = realpathSync(absolutePath);
    const normalizedRoot = path.resolve(workspaceRoot);

    // Recursively scan for symlinks that might contain the target path
    // Max depth of 4 matches the scan-drive-symlinks handler (work/Company/Drive/...)
    const MAX_DEPTH = 4;

    const scanDirectory = (
      dir: string,
      workspaceRelativePrefix: string,
      depth: number
    ): string | null => {
      if (depth > MAX_DEPTH) return null;

      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return null;
      }

      for (const entry of entries) {
        // Skip hidden entries (except at root level) and node_modules
        if (depth > 0 && entry.startsWith('.')) continue;
        if (entry === 'node_modules') continue;

        const entryPath = path.join(dir, entry);
        const workspaceRelativePath = workspaceRelativePrefix
          ? path.join(workspaceRelativePrefix, entry)
          : entry;

        try {
          const stat = lstatSync(entryPath);

          if (stat.isSymbolicLink()) {
            // Resolve the symlink to get its real target
            let realEntry: string;
            try {
              realEntry = realpathSync(entryPath);
            } catch {
              // Broken symlink, skip
              continue;
            }

            // Check if the target path is under this symlink's real path
            if (isPathContainedIn(realTarget, realEntry)) {
              const relativePart = getContainedRelativePath(realTarget, realEntry);
              return relativePart
                ? path.join(workspaceRelativePath, relativePart)
                : workspaceRelativePath;
            }
          } else if (stat.isDirectory()) {
            // For regular directories, first check if target is directly within
            let realEntry: string;
            try {
              realEntry = realpathSync(entryPath);
            } catch {
              continue;
            }

            if (isPathContainedIn(realTarget, realEntry)) {
              const relativePart = getContainedRelativePath(realTarget, realEntry);
              return relativePart
                ? path.join(workspaceRelativePath, relativePart)
                : workspaceRelativePath;
            }

            // Recurse into directory to find nested symlinks
            const result = scanDirectory(entryPath, workspaceRelativePath, depth + 1);
            if (result) return result;
          }
        } catch {
          // Skip entries that can't be accessed
          continue;
        }
      }

      return null;
    };

    return scanDirectory(normalizedRoot, '', 0);
  } catch {
    return null;
  }
};

/**
 * Check if a target path is lexically inside a root directory.
 * Uses path.resolve() to normalize paths (resolves .. but does NOT follow symlinks).
 *
 * This intentionally trusts symlinks inside the workspace - a symlink at
 * /workspace/gdrive pointing to /Users/foo/Google Drive is allowed.
 * The security model is: we validate the path STRING, not where symlinks point.
 *
 * @param targetPath - The path to check
 * @param rootPath - The root directory that should contain targetPath
 * @returns true if targetPath is lexically inside rootPath
 */
export const isPathInsideLexical = (
  targetPath: string,
  rootPath: string,
): boolean => {
  // Normalize both paths (resolves .., makes absolute, but doesn't follow symlinks)
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(targetPath);

  const relative = path.relative(resolvedRoot, resolvedTarget);

  // Empty string means same path, which is allowed
  if (relative === "") return true;

  // Check for escape:
  // - equals '..' exactly (direct parent)
  // - starts with '..' + separator (parent traversal)
  // - is absolute (different drive on Windows, e.g., 'D:\evil')
  return (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
};

/**
 * Resolve and validate a workspace path, ensuring it's within the configured workspace
 * Handles absolute paths by converting them to workspace-relative paths via symlinks
 */
export const resolveLibraryPath = (
  target: string | null | undefined,
  coreDirectory: string | null,
): { root: string; resolved: string } => {
  if (!coreDirectory) {
    throw new Error("Core directory is not configured.");
  }
  if (!target || typeof target !== "string") {
    throw new Error("Invalid workspace path.");
  }

  const root = path.resolve(coreDirectory);
  let candidate = target.trim().length > 0 ? target.trim() : "";
  if (!candidate) {
    throw new Error("Workspace path is empty.");
  }

  // If it's an absolute path that doesn't start with root, try to convert via symlinks
  if (path.isAbsolute(candidate) && !candidate.startsWith(root)) {
    const workspacePath = tryConvertToWorkspacePath(candidate, root);
    if (workspacePath) {
      logger.info(
        {
          originalPath: candidate,
          convertedPath: workspacePath,
        },
        "Converted absolute path to workspace path via symlink",
      );
      candidate = workspacePath;
    } else if (candidate.startsWith("/") && !candidate.startsWith("//")) {
      // Symlink conversion failed. Check if this might be a "fake absolute" Unix path
      // (e.g., "/Chief-of-staff/Memory/file.md" when agent meant workspace-relative)
      //
      // S4.1f MUST-FIX C residual: a cloud-classified absolute candidate must NOT
      // reach `existsSync` — a dead cloud FUSE mount blocks the main thread with no
      // timeout. Decide via the pure-string `detectCloudStorage` (no I/O) and treat
      // a cloud path as "does not exist on the real FS" (`absoluteExists = false`),
      // which is byte-identical to the local case where `existsSync` returns false:
      // we then fall through to the workspace-relative attempt below. (A genuine
      // cloud-backed workspace file is read through the already-bounded
      // `library:read-file` boundary, not this string-resolution helper.)
      let absoluteExists = false;
      if (!detectCloudStorage(candidate).isCloud) {
        try {
          absoluteExists = existsSync(candidate);
        } catch {
          absoluteExists = false;
        }
      }

      if (!absoluteExists) {
        // Absolute path doesn't exist on filesystem, try as workspace-relative
        const withoutLeadingSlash = candidate.replace(/^\/+/, "");
        const relativeAttempt = path.resolve(root, withoutLeadingSlash);

        // S4.1f MUST-FIX C residual: `relativeAttempt` is under `root`, so it is
        // cloud-classified iff the workspace root itself is cloud-hosted. A cloud
        // path must NOT reach `existsSync` (dead-FUSE main-thread block). Decide via
        // the pure-string `detectCloudStorage` (no I/O) and skip the probe when
        // cloud — byte-identical to the local case where `existsSync` returns false:
        // `candidate` is left unchanged (stays the leading-slash absolute) and the
        // existing security/normalisation below applies. (A genuine cloud-backed
        // file is read through the already-bounded `library:read-file` boundary.)
        if (relativeAttempt.startsWith(root) && !detectCloudStorage(relativeAttempt).isCloud) {
          try {
            if (existsSync(relativeAttempt)) {
              logger.info(
                {
                  originalPath: candidate,
                  convertedPath: withoutLeadingSlash,
                  resolvedTo: relativeAttempt,
                },
                "Converted fake-absolute path to workspace-relative path",
              );
              candidate = withoutLeadingSlash;
            }
          } catch {
            // File doesn't exist in workspace either, will fail at later validation
          }
        }
      }
    }
  }

  const resolved = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(root, candidate);

  // Security check: validate that the path is lexically inside the workspace
  // Uses path.relative() instead of startsWith() to prevent bypass attacks like:
  // '/workspace2/evil.txt'.startsWith('/workspace') === true (VULNERABLE)
  if (!isPathInsideLexical(resolved, root)) {
    throw new Error(
      "Access to paths outside the workspace directory is not permitted.",
    );
  }

  return { root, resolved };
};

/**
 * Common system Git Bash installation paths for Windows.
 * Used by both setupGitEnvironment() and checkGitBashHealth() (health checks)
 * to ensure consistent detection. Keep these in sync.
 */
export const getWindowsGitBashCandidatePaths = (): string[] => {
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;

  const paths: string[] = [
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];

  // Per-user Git for Windows install (common in corporate environments
  // where users lack admin rights or system Git is blocked by policy)
  if (localAppData) {
    paths.push(
      path.join(localAppData, "Programs", "Git", "usr", "bin", "bash.exe"),
      path.join(localAppData, "Programs", "Git", "bin", "bash.exe"),
    );
  }

  if (programFiles) {
    paths.push(path.join(programFiles, "Git", "bin", "bash.exe"));
  }

  return paths;
};

/**
 * Setup Git environment with bundled distribution
 * - Windows: PortableGit (includes bash.exe at usr/bin/bash.exe)
 * - macOS/Linux: dugite-native (bash is native, just need git at bin/git)
 * 
 * Sets CLAUDE_CODE_GIT_BASH_PATH on Windows for runtime compatibility.
 */
export const setupGitEnvironment = async (): Promise<void> => {
  const isWindows = process.platform === "win32";

  // If the user (or a previous Rebel version during auto-update relaunch) has already set
  // CLAUDE_CODE_GIT_BASH_PATH, validate it before trusting it.
  // Claude Code hard-exits when this env var is set but points at a missing file.
  if (isWindows && process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    const existingPath = process.env.CLAUDE_CODE_GIT_BASH_PATH;

    try {
      if (existsSync(existingPath)) {
        logger.debug(
          { path: existingPath },
          "CLAUDE_CODE_GIT_BASH_PATH already set",
        );
        return;
      }
    } catch (error) {
      logger.warn(
        { path: existingPath, err: error },
        "Failed to validate CLAUDE_CODE_GIT_BASH_PATH; ignoring",
      );
    }

    logger.warn(
      { path: existingPath },
      "CLAUDE_CODE_GIT_BASH_PATH is set but path does not exist (likely stale), ignoring",
    );
    // Clear the stale path so it doesn't interfere with path discovery below
    // or get inherited by child processes before we set the new value.
    delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
    // Fall through to discover a valid Git Bash path.
  }

  // Check for bundled Git in packaged app
  if (getPlatformConfig().isPackaged) {
    const resourcesPath = process.resourcesPath;
    const bundledGitDir = path.join(resourcesPath, "git-bundle");

    if (isWindows) {
      // Windows: PortableGit structure - bash at usr/bin/bash.exe
      const bundledBashPath = path.join(bundledGitDir, "usr", "bin", "bash.exe");

      if (existsSync(bundledBashPath)) {
        process.env.CLAUDE_CODE_GIT_BASH_PATH = bundledBashPath;
        // Add usr/bin to PATH so cygpath and other MSYS2 utilities are available
        // Some runtime tooling relies on cygpath for Windows/Unix path conversion
        const usrBinDir = path.dirname(bundledBashPath);
        process.env.PATH = [usrBinDir, process.env.PATH || ""].join(path.delimiter);
        logger.info(
          { bundledBashPath },
          "Using bundled Git Bash for Windows"
        );
        return;
      }
      logger.warn(
        { expectedPath: bundledBashPath },
        "Bundled Git Bash not found, will rely on system installation"
      );
    } else {
      // macOS/Linux: dugite-native structure - git at bin/git
      const bundledGitPath = path.join(bundledGitDir, "bin", "git");

      if (existsSync(bundledGitPath)) {
        // Set environment variables for bundled git
        process.env.LOCAL_GIT_DIRECTORY = bundledGitDir;
        process.env.GIT_EXEC_PATH = path.join(bundledGitDir, "libexec", "git-core");
        process.env.GIT_TEMPLATE_DIR = path.join(bundledGitDir, "share", "git-core", "templates");
        
        if (process.platform === "linux") {
          process.env.PREFIX = bundledGitDir;
          const sslCABundle = path.join(bundledGitDir, "ssl", "cacert.pem");
          if (existsSync(sslCABundle) && !process.env.GIT_SSL_CAINFO) {
            process.env.GIT_SSL_CAINFO = sslCABundle;
          }
        }
        
        // Add git bin to PATH
        const gitBinDir = path.join(bundledGitDir, "bin");
        process.env.PATH = [gitBinDir, process.env.PATH || ""].join(path.delimiter);
        
        logger.info(
          { bundledGitDir, bundledGitPath },
          "Using bundled Git (dugite-native)"
        );
        return;
      }
      logger.warn(
        { expectedPath: bundledGitPath },
        "Bundled Git not found, will rely on system installation"
      );
    }
  }

  // In development or if bundled git not found, check for system Git
  if (isWindows) {
    const commonPaths = getWindowsGitBashCandidatePaths();

    for (const bashPath of commonPaths) {
      if (existsSync(bashPath)) {
        process.env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;
        // Add usr/bin to PATH so cygpath and other MSYS2 utilities are available
        const usrBinDir = path.dirname(bashPath);
        process.env.PATH = [usrBinDir, process.env.PATH || ""].join(path.delimiter);
        logger.info(
          { bashPath },
          "Found system Git Bash installation"
        );
        return;
      }
    }

    logger.warn(
      "No Git Bash installation found. Some runtime tooling may not work correctly on Windows."
    );
  } else {
    // On macOS/Linux, git is typically available in PATH
    logger.debug("Using system Git (no bundled version available)");
  }
};

/**
 * Setup Node.js environment with proper PATH configuration
 * Includes bundled Node.js for packaged apps and system Node.js paths
 */

// Promise memoization for setupNodeEnvironment - ensures PATH mutation happens only once
// and concurrent callers receive the same promise (prevents race conditions)
let setupNodeEnvPromise: Promise<string> | null = null;

export const setupNodeEnvironment = async (): Promise<string> => {
  // Prevent double PATH mutation: concurrent callers share the same setup promise.
  // NOTE: Other setup steps (e.g. Git Bash setup) may legitimately mutate PATH after
  // this runs, so callers should rely on `process.env.PATH` after awaiting.
  if (setupNodeEnvPromise !== null) {
    await setupNodeEnvPromise;
    return process.env.PATH || "";
  }

  setupNodeEnvPromise = (async () => {
    const originalPath = process.env.PATH || "";
    const isWindows = process.platform === "win32";
    logger.debug(
      { originalPath, isPackaged: getPlatformConfig().isPackaged, platform: process.platform },
      "Setting up Node.js environment",
    );

    // Common system Node.js installation paths (platform-specific)
    const systemNodePaths: string[] = isWindows
      ? [
          // Windows Node.js paths
          path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs"),
          path.join(
            process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
            "nodejs",
          ),
          path.join(process.env.LOCALAPPDATA || "", "Programs", "nodejs"),
          path.join(process.env.APPDATA || "", "npm"),
          // nvm-windows default location
          path.join(
            process.env.NVM_HOME || path.join(process.env.APPDATA || "", "nvm"),
            "nodejs",
          ),
          // fnm (Fast Node Manager) on Windows
          path.join(process.env.LOCALAPPDATA || "", "fnm_multishells"),
        ].filter((p) => p && !p.includes("undefined"))
      : [
          // macOS/Linux Node.js paths
          "/opt/homebrew/bin", // Homebrew on Apple Silicon
          "/usr/local/bin", // Homebrew on Intel, or standard location
          "/opt/homebrew/opt/node/bin",
          path.join(os.homedir(), ".nvm/versions/node"),
          path.join(os.homedir(), ".volta/bin"),
          "/usr/bin", // System node (if exists)
        ];

    const existingPaths = originalPath.split(path.delimiter);
    const pathsToAdd: string[] = [];

    // Check for bundled Node.js (with npm/npx) first if packaged
    if (getPlatformConfig().isPackaged) {
      const resourcesPath = process.resourcesPath;

      // Windows: node.exe is at root of node-bundle
      // macOS: node is in node-bundle/bin
      const bundledNodeDir = isWindows
        ? path.join(resourcesPath, "node-bundle")
        : path.join(resourcesPath, "node-bundle", "bin");
      const nodeExecutableName = isWindows ? "node.exe" : "node";
      const bundledNodePath = path.join(bundledNodeDir, nodeExecutableName);
      const npmExecutableName = isWindows ? "npm.cmd" : "npm";
      const npxExecutableName = isWindows ? "npx.cmd" : "npx";
      const bundledNpmPath = path.join(bundledNodeDir, npmExecutableName);
      const bundledNpxPath = path.join(bundledNodeDir, npxExecutableName);

      try {
        const stats = await fs.stat(bundledNodePath);
        if (stats.isFile()) {
          // On Windows, just check existence; on Unix, check executable bit
          const isAccessible = isWindows
            ? true
            : await fs
                .access(bundledNodePath, fs.constants.X_OK)
                .then(() => true)
                .catch(() => false);

          if (isAccessible) {
            // Check if npm and npx are also available
            const hasNpm = await fs
              .stat(bundledNpmPath)
              .then(() => true)
              .catch(() => false);
            const hasNpx = await fs
              .stat(bundledNpxPath)
              .then(() => true)
              .catch(() => false);

            pathsToAdd.push(bundledNodeDir);
            logger.info(
              {
                bundledNodePath,
                hasNpm,
                hasNpx,
              },
              "Using bundled Node.js with npm/npx",
            );
          } else {
            logger.error(
              { bundledNodePath },
              "Bundled node binary is not executable",
            );
          }
        }
      } catch {
        logger.warn("Bundled Node.js not found, will try system installations");
      }
    }

    // Add system Node.js paths (only if not already in PATH)
    const nodeExecutableName = isWindows ? "node.exe" : "node";
    let nodeFoundInExistingPath = false;

    // First, check if Node.js is already available in the existing PATH
    for (const existingPath of existingPaths) {
      if (existingPath) {
        try {
          const nodeExecutable = path.join(existingPath, nodeExecutableName);
          if (existsSync(nodeExecutable)) {
            nodeFoundInExistingPath = true;
            logger.debug(
              { nodePath: existingPath },
              "Node.js already available in PATH",
            );
            break;
          }
        } catch {
          // Ignore errors checking paths
        }
      }
    }

    // Then check system paths and add any that aren't already in PATH
    for (const nodePath of systemNodePaths) {
      if (!existingPaths.includes(nodePath)) {
        try {
          if (existsSync(nodePath)) {
            const nodeExecutable = path.join(nodePath, nodeExecutableName);
            if (existsSync(nodeExecutable)) {
              pathsToAdd.push(nodePath);
              logger.debug({ nodePath }, "Found system Node.js installation");
            }
          }
        } catch {
          // Ignore errors checking paths
        }
      }
    }

    const augmentedPath = [...pathsToAdd, ...existingPaths].join(path.delimiter);

    // Only warn if Node.js is genuinely unavailable (not in PATH and not found in system paths)
    if (pathsToAdd.length === 0 && !nodeFoundInExistingPath) {
      logger.error(
        { originalPath: originalPath.slice(0, 100) },
        "No Node.js installation found! App may not work correctly.",
      );
    } else if (pathsToAdd.length === 0) {
      // Node.js is available in existing PATH, no paths needed to add
      logger.debug(
        { nodeFoundInExistingPath },
        "Node.js environment ready (already in PATH)",
      );
    } else {
      // Update process.env.PATH so child processes (like Super-MCP HTTP server)
      // inherit the augmented PATH with bundled node-bundle/bin
      process.env.PATH = augmentedPath;

      logger.info(
        {
          addedPaths: pathsToAdd,
          firstPath: augmentedPath.split(path.delimiter)[0],
        },
        "Node.js environment configured",
      );
    }

    return augmentedPath;
  })();

  await setupNodeEnvPromise;
  return process.env.PATH || "";
};

/**
 * Get an available port. If preferredPort is provided, tries that first.
 * Falls back to letting the OS assign any free port.
 * Useful for OAuth callback servers that need a specific or any available port.
 */
export const getAvailablePort = (preferredPort?: number): Promise<number> => {
  const tryPort = (portToTry: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const server = http.createServer();
      server.listen(portToTry, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address === "object") {
          const port = address.port;
          server.close(() => resolve(port));
        } else {
          server.close(() => reject(new Error("Could not determine port")));
        }
      });
      server.on("error", reject);
    });

  if (preferredPort) {
    return tryPort(preferredPort).catch(() => tryPort(0));
  }
  return tryPort(0);
};

/**
 * Get the current system username in a cross-platform way.
 * 
 * Uses standardized USERNAME across all platforms:
 * - macOS/Linux: $USER env var, falling back to os.userInfo()
 * - Windows: $USERNAME env var, falling back to os.userInfo()
 * 
 * @returns The username or null if unavailable
 */
export const getUsername = (): string | null => {
  try {
    // Try environment variables first (most reliable)
    // USER is standard on macOS/Linux, USERNAME on Windows
    const envUser = process.env['USER'] || process.env['USERNAME'];
    if (envUser) {
      return envUser;
    }
    // Fall back to os.userInfo() which may throw on some systems
    return os.userInfo().username || null;
  } catch {
    // os.userInfo() can throw if user info is not available
    // (e.g., some containerized environments)
    return process.env['USER'] || process.env['USERNAME'] || null;
  }
};
