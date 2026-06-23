const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");

// Augment NODE_OPTIONS for any child process forge spawns (electron-vite,
// build-worker, electron-builder, etc.) so Rollup's main-process module
// graph analysis doesn't OOM on the default ~4 GB heap. Matches what
// scripts/run-electron-vite-build-with-heap-bump.ts does for the standalone
// `electron-vite build` path and what scripts/run-dev-with-cdp-default.mjs
// does for the dev path. Preserves any upstream NODE_OPTIONS (--inspect,
// --no-warnings, etc.) rather than clobbering.
{
  const HEAP_FLAG = "--max-old-space-size=8192";
  const upstream = (process.env.NODE_OPTIONS ?? "").trim();
  if (!upstream.includes("--max-old-space-size")) {
    process.env.NODE_OPTIONS = upstream.length > 0 ? `${upstream} ${HEAP_FLAG}` : HEAP_FLAG;
  }
}

// =============================================================================
// BUILD CHANNEL CONFIGURATION
// =============================================================================
// Set BUILD_CHANNEL=beta to build the beta app for internal testers.
// Beta builds have a different app name, bundle ID, icon, and update URL.
// This allows beta and stable apps to coexist on the same machine.
// =============================================================================
const buildChannel = process.env.BUILD_CHANNEL || "stable";
const isBeta = buildChannel === "beta";

const appName = isBeta ? "Mindstone Rebel Beta" : "Mindstone Rebel";
const internalName = isBeta ? "mindstone-rebel-beta" : "mindstone-rebel";
const appBundleId = isBeta ? "com.mindstone.rebel.beta" : "com.mindstone.rebel";
// NOTE: Update URL pattern is defined in multiple places - keep in sync:
//   - forge.config.cjs (here + packageAfterCopy Step 10)
//   - electron-builder.cjs - build-time publish config
//   - scripts/build-windows-nsis.mjs - local build app-update.yml generation
//   - src/main/services/autoUpdateService.ts - runtime fallback
//   - src/main/services/health/checks/updates.ts - health check diagnostics
const updateBasePath = isBeta ? "updates-beta" : "updates";
const updateBaseUrl = `https://storage.googleapis.com/mindstone-rebel/${updateBasePath}`;

// Log build channel for CI visibility
console.log(`[forge.config] Build channel: ${buildChannel}`);
console.log(`[forge.config] App name: ${appName}`);
console.log(`[forge.config] Bundle ID: ${appBundleId}`);
console.log(`[forge.config] Update URL base: ${updateBaseUrl}`);

const buildDir = path.resolve(__dirname, "build");
const iconBaseName = isBeta ? "icon-beta" : "icon";
const macIconRelative = `./build/${iconBaseName}.icns`;
const winIconRelative = `./build/${iconBaseName}.ico`;
const baseIconRelative = `./build/${iconBaseName}`;
const entitlementsRelative = "./build/entitlements.mac.plist";
const nodeBundleRelative = "./resources/node-bundle";
const gitBundleRelative = "./resources/git-bundle";
const configRelative = "./config";

const macIconPath = path.join(buildDir, `${iconBaseName}.icns`);
const winIconPath = path.join(buildDir, `${iconBaseName}.ico`);
const entitlementsPath = path.join(buildDir, "entitlements.mac.plist");
const nodeBundlePath = path.join(__dirname, "resources", "node-bundle");
const gitBundlePath = path.join(__dirname, "resources", "git-bundle");
const configPath = path.join(__dirname, "config");
const rebelCliDistPath = path.join(__dirname, "scripts", "rebel-cli", "dist");
const setupCliPathSh = path.join(__dirname, "scripts", "setup-cli-path.sh");
const setupCliPathPs1 = path.join(__dirname, "scripts", "setup-cli-path.ps1");

const hasMacIcon = fs.existsSync(macIconPath);
const hasWinIcon = fs.existsSync(winIconPath);
const hasEntitlements = fs.existsSync(entitlementsPath);
const hasNodeBundle = fs.existsSync(nodeBundlePath);
const hasGitBundle = fs.existsSync(gitBundlePath);
const hasConfig = fs.existsSync(configPath);

// Warn if beta icon is missing when building beta
if (isBeta && !hasMacIcon && !hasWinIcon) {
  console.warn(
    "[forge.config] WARNING: Beta icon files not found. Using default icon.",
  );
  console.warn(
    "[forge.config] Expected: build/icon-beta.icns and build/icon-beta.ico",
  );
}
const macIdentity =
  process.env.MAC_CODESIGN_IDENTITY ||
  "Developer ID Application: Mindstone Learning limited (6HGKU9RW3U)";
const keychainPath = process.env.SECURITY_MAC_KEYCHAIN;
const appleApiKeyPath = process.env.APPLE_API_KEY_PATH;
const appleApiKeyId = process.env.APPLE_API_KEY_ID;
const appleApiIssuer = process.env.APPLE_API_ISSUER_ID;

const osxSignConfig = {
  identity: macIdentity,
  hardenedRuntime: true,
  "gatekeeper-assess": false,
  // Use optionsForFile to ensure ALL executables get our entitlements
  // This is critical for the bundled Node.js binary which needs JIT entitlements
  optionsForFile: (filePath) => {
    // Apply our entitlements to all executables
    // The entitlements include allow-jit and allow-unsigned-executable-memory
    // which are required for V8 JIT compilation on Intel Macs
    if (hasEntitlements) {
      return {
        entitlements: entitlementsPath,
      };
    }
    return {};
  },
};

if (hasEntitlements) {
  osxSignConfig.entitlements = entitlementsRelative;
  osxSignConfig["entitlements-inherit"] = entitlementsRelative;
}

if (keychainPath) {
  osxSignConfig.keychain = keychainPath;
}

const osxNotarizeConfig =
  appleApiKeyPath && appleApiKeyId && appleApiIssuer
    ? {
        tool: "appstore-connect",
        appBundleId: appBundleId,
        appleApiKey: appleApiKeyPath,
        appleApiKeyId,
        appleApiIssuer,
      }
    : undefined;

/**
 * Recursively copy directory using native fs.cp (Node 16+)
 * This is significantly faster than manual file-by-file copying, especially on Windows
 * where individual file operations have high overhead due to NTFS metadata and antivirus scanning.
 * 
 * IMPORTANT: We use dereference: true to convert symlinks to regular files/directories.
 * macOS codesigning fails on symlinks in app bundles with errors like:
 * - "code has no resources but signature indicates they must be present"
 * - "invalid destination for symbolic link in bundle"
 */
async function copyDir(src, dest) {
  await fsp.cp(src, dest, { recursive: true, force: true, dereference: true });
}

/**
 * Recursively delete directory
 */
async function deleteDir(dir) {
  if (!fs.existsSync(dir)) {
    return;
  }
  await fsp.rm(dir, { recursive: true, force: true });
}

/**
 * Strip unnecessary files from a directory to reduce bundle size and path lengths.
 * Removes compile-time-only files that aren't needed at runtime:
 * - .d.ts, .d.ts.map, .d.cts, .d.mts - TypeScript declaration files
 * - .js.map, .cjs.map, .mjs.map - Source maps
 * - .ts, .tsx, .cts, .mts (in node_modules only) - TypeScript source files
 * - README, CHANGELOG, HISTORY, LICENSE, etc. - Documentation files
 * - test/, tests/, __tests__/, __mocks__/ - Test directories
 * - docs/, doc/, example/, examples/, demo/ - Documentation directories
 * - .github/, .circleci/, .gitlab/ - CI configuration directories
 * - .tlog, .lastbuildstate - MSBuild tracking/state files (native module build artifacts)
 * This fixes Windows Squirrel packaging (260 char path limit) and macOS codesigning (EMFILE).
 */
async function stripUnnecessaryFiles(dir, label) {
  if (!fs.existsSync(dir)) {
    return { removed: 0, dirs: 0 };
  }

  let removedCount = 0;
  let dirsRemoved = 0;

  // Check if this is a node_modules directory (safe to strip TS source files and docs)
  const isNodeModules = label.includes("node_modules");

  // Directories to remove entirely (in node_modules only)
  // Note: Uses startsWith for patterns like dist-test-*, etc.
  // NOTE: "docs" and "doc" are NOT included here because some packages (e.g., googleapis)
  // use these names for actual code directories (googleapis/build/src/apis/docs/ contains
  // the Google Docs API). Markdown files in docs directories are stripped separately.
  const removableDirsExact = new Set([
    "test", "tests", "__tests__", "__mocks__",
    "example", "examples", "demo",
    ".github", ".circleci", ".gitlab",
    // Build artifacts and test outputs
    "coverage", "__snapshots__", "fixtures", "__fixtures__",
    "testdata", "test-data", "bench", "benchmark", "perf",
    // Some packages ship test dirs without hyphen (e.g., @azure/identity/dist-test)
    "dist-test",
  ]);
  // Directory name prefixes to remove (handles dist-test-v3, dist-test-v4, etc.)
  // Note: These require hyphen to avoid false positives (e.g., "testament")
  const removableDirPrefixes = [
    "dist-test-",  // zod-to-json-schema ships dist-test-v3, dist-test-v4 (~9k files!)
    "test-dist-",
  ];

  async function walkAndStrip(currentDir) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        // In node_modules, remove entire test/docs/CI directories
        const dirNameLower = entry.name.toLowerCase();
        const shouldRemoveDir = isNodeModules && (
          removableDirsExact.has(dirNameLower) ||
          removableDirPrefixes.some(prefix => dirNameLower.startsWith(prefix))
        );
        if (shouldRemoveDir) {
          try {
            await fsp.rm(fullPath, { recursive: true, force: true });
            dirsRemoved++;
          } catch {
            // Directory may be locked or access denied
          }
          continue;
        }

        // Recursively process subdirectories
        await walkAndStrip(fullPath);

        // Remove empty directories after stripping
        // NOTE: We do NOT blindly remove 'types' directories because some packages
        // (e.g., body-parser/lib/types/, mime/types/) contain runtime .js files
        try {
          const remaining = await fsp.readdir(fullPath);
          if (remaining.length === 0) {
            await fsp.rmdir(fullPath);
            dirsRemoved++;
          }
        } catch {
          // Directory may have been removed already or access denied
        }
      } else if (entry.isFile()) {
        const name = entry.name;
        const nameLower = name.toLowerCase();
        let shouldRemove = false;

        // Remove TypeScript declarations (always safe to remove)
        if (
          name.endsWith(".d.ts") ||
          name.endsWith(".d.ts.map") ||
          name.endsWith(".d.cts") ||
          name.endsWith(".d.mts")
        ) {
          shouldRemove = true;
        }
        // Remove source maps (always safe to remove)
        else if (
          name.endsWith(".js.map") ||
          name.endsWith(".cjs.map") ||
          name.endsWith(".mjs.map")
        ) {
          shouldRemove = true;
        }
        // Remove TypeScript build info
        else if (name.endsWith(".tsbuildinfo")) {
          shouldRemove = true;
        }
        // Remove native module build artifacts (MSBuild intermediate files)
        // These are created during node-gyp/electron-rebuild compilation on Windows
        // Only the .node binary is needed at runtime
        // Note: .tlog and .lastbuildstate are unique to MSBuild and safe to remove globally
        // We do NOT remove .obj files here as they could be Wavefront 3D model assets
        else if (
          name.endsWith(".tlog") ||           // MSBuild tracking logs (unique extension)
          name.endsWith(".lastbuildstate")    // MSBuild incremental build state (unique extension)
        ) {
          shouldRemove = true;
        }
        // In node_modules, also remove TypeScript source files and documentation
        // (compiled JS files are what actually runs)
        else if (isNodeModules) {
          // TypeScript source files
          if (
            name.endsWith(".ts") ||
            name.endsWith(".tsx") ||
            name.endsWith(".cts") ||
            name.endsWith(".mts")
          ) {
            // Don't remove .d.ts (already handled above)
            if (!name.endsWith(".d.ts") && !name.endsWith(".d.cts") && !name.endsWith(".d.mts")) {
              shouldRemove = true;
            }
          }
          // Markdown files (README, CHANGELOG, etc.)
          else if (name.endsWith(".md")) {
            shouldRemove = true;
          }
          // Documentation and metadata files (case-insensitive matching)
          else if (
            nameLower.startsWith("readme") ||
            nameLower.startsWith("changelog") ||
            nameLower.startsWith("history") ||
            nameLower.startsWith("license") ||
            nameLower.startsWith("licence") ||
            nameLower.startsWith("contributing") ||
            nameLower.startsWith("authors")
          ) {
            shouldRemove = true;
          }
          // Build tool configs
          else if (
            nameLower.startsWith(".eslint") ||
            nameLower.startsWith(".prettier") ||
            nameLower === ".editorconfig" ||
            nameLower === "makefile" ||
            nameLower.startsWith("gruntfile") ||
            nameLower.startsWith("gulpfile")
          ) {
            shouldRemove = true;
          }
          // TypeScript configs (but keep package.json for module resolution)
          else if (/^tsconfig.*\.json$/.test(nameLower)) {
            shouldRemove = true;
          }
          // Flow type files
          else if (name.endsWith(".flow")) {
            shouldRemove = true;
          }
          // Package manager lock files (not package.json!)
          else if (nameLower === "yarn.lock" || nameLower === "pnpm-lock.yaml") {
            shouldRemove = true;
          }
          // npm ignore files
          else if (nameLower === ".npmignore" || nameLower === ".yarnignore") {
            shouldRemove = true;
          }
          // GitHub templates
          else if (nameLower.startsWith("issue_template") || nameLower.startsWith("pull_request_template")) {
            shouldRemove = true;
          }
          // Component story files (Storybook)
          else if (name.endsWith(".stories.js") || name.endsWith(".stories.jsx") || name.endsWith(".stories.ts") || name.endsWith(".stories.tsx")) {
            shouldRemove = true;
          }
        }

        if (shouldRemove) {
          try {
            await fsp.unlink(fullPath);
            removedCount++;
          } catch {
            // File may have been removed already or access denied
          }
        }
      }
    }
  }

  await walkAndStrip(dir);
  console.log(
    `[packageAfterCopy] ${label}: removed ${removedCount} files, ${dirsRemoved} dirs`,
  );
  return { removed: removedCount, dirs: dirsRemoved };
}

/**
 * Find and log the longest file paths in a directory (for Windows 260-char limit diagnostics)
 */
async function logLongestPaths(dir, label, resourcesDir, topN = 5) {
  if (!fs.existsSync(dir)) {
    return;
  }

  const paths = [];
  const baseForRelative = path.dirname(resourcesDir); // Go up from Resources to get app bundle root

  async function collectPaths(currentDir) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await collectPaths(fullPath);
      } else {
        // Calculate relative path from app bundle root (what ends up in NuGet package)
        const relativePath = path.relative(baseForRelative, fullPath);
        paths.push({ path: relativePath, length: relativePath.length });
      }
    }
  }

  await collectPaths(dir);
  paths.sort((a, b) => b.length - a.length);

  const longest = paths.slice(0, topN);
  console.log(`[packageAfterCopy] ${label} - Top ${topN} longest paths:`);
  for (const p of longest) {
    const warning = p.length > 150 ? " [WARNING: may exceed Windows limit]" : "";
    console.log(`  ${p.length} chars: ${p.path}${warning}`);
  }

  // Warn if any path is dangerously close to Windows limit
  // NuGet adds ~100 chars for temp directory + lib/net45/
  const dangerThreshold = 150;
  const dangerousPaths = paths.filter((p) => p.length > dangerThreshold);
  if (dangerousPaths.length > 0) {
    console.warn(
      `[packageAfterCopy] WARNING: ${dangerousPaths.length} paths exceed ${dangerThreshold} chars - may fail Windows Squirrel packaging`,
    );
  }
}

// Check for Linux icon (PNG required for .deb packages)
const linuxIconPath = path.join(buildDir, `${iconBaseName}.png`);
const hasLinuxIcon = fs.existsSync(linuxIconPath);
const linuxIconRelative = `./build/${iconBaseName}.png`;

// Linux executable name (lowercase, hyphenated - required for DEB maker)
const linuxExecutableName = isBeta ? "mindstone-rebel-beta" : "mindstone-rebel";

// Detect target platform from electron-forge CLI args (--platform=xxx or -p xxx)
// This is needed because electron-forge evaluates config before building, but we can
// still determine the target platform from the command line arguments.
function getTargetPlatform() {
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    // Handle --platform=linux format
    if (args[i].startsWith("--platform=")) {
      return args[i].split("=")[1];
    }
    // Handle --platform linux or -p linux format
    if ((args[i] === "--platform" || args[i] === "-p") && args[i + 1]) {
      return args[i + 1];
    }
  }
  // Default to current platform if not specified
  return process.platform;
}

const targetPlatform = getTargetPlatform();
const isLinuxBuild = targetPlatform === "linux";

// Only use lowercase executable name for Linux; macOS/Windows should use default (appName)
const executableName = isLinuxBuild ? linuxExecutableName : undefined;

// Debug: Log the platform and executable name for troubleshooting CI issues
console.log(`[forge.config] Current platform: ${process.platform}`);
console.log(`[forge.config] Target platform: ${targetPlatform}`);
console.log(
  `[forge.config] Executable name: ${executableName || "(default: " + appName + ")"}`,
);

// =============================================================================
// WINDOWS INSTALLER CONFIGURATION
// =============================================================================
// Windows uses NSIS installer via electron-builder (configured in electron-builder.cjs).
// Squirrel.Windows maker was removed in the NSIS migration (2026-01).
// electron-forge creates the packaged app; electron-builder creates the NSIS installer.
// =============================================================================

const makers = [
  {
    name: "@electron-forge/maker-zip",
    platforms: ["darwin", "win32"],
    config: (arch) => {
      if (process.platform === "darwin") {
        return {
          macUpdateManifestBaseUrl: `${updateBaseUrl}/darwin/${arch}`,
        };
      }
      return {};
    },
  },
  {
    name: "@electron-forge/maker-dmg",
    platforms: ["darwin"],
    config: (arch) => {
      const baseName = isBeta ? "MindstoneRebelBeta" : "rebel-app";
      const volumeName =
        arch === "arm64" ? `${baseName}Arm64` : `${baseName}X64`;
      return {
        // Rely on default UDZO format in electron-installer-dmg for broader runner compatibility
        name: volumeName,
        ...(hasMacIcon ? { icon: macIconRelative } : {}),
      };
    },
  },
  // NOTE: Squirrel.Windows maker removed - Windows now uses NSIS via electron-builder (2026-01)
  // See electron-builder.cjs for Windows installer configuration
  {
    name: "@electron-forge/maker-deb",
    platforms: ["linux"],
    config: {
      options: {
        // Explicitly set the binary name to match the executableName in packagerConfig
        // This is required because the DEB maker looks for this binary in the packaged output
        bin: linuxExecutableName,
        maintainer: "Mindstone Learning Limited",
        homepage: "https://rebel.mindstone.com/",
        ...(hasLinuxIcon ? { icon: linuxIconRelative } : {}),
        categories: ["Productivity", "Development"],
        genericName: "AI Assistant",
        description: "Voice-first agentic AI powered by Claude",
        // Register mindstone:// and rebel:// for OAuth and navigation deep links
        mimeTypes: ["x-scheme-handler/mindstone", "x-scheme-handler/rebel"],
      },
    },
  },
];

module.exports = {
  rebuildConfig: {
    // @stoprocent/noble ships prebuilt binaries for all platforms, so node-gyp
    // rebuild is unnecessary and fails in many dev environments.
    onlyModules: [],
  },
  packagerConfig: {
    name: appName,
    // Only set executableName for Linux builds (DEB packaging requires lowercase).
    // For macOS/Windows, omit it to use the default (appName), which ensures
    // the executable is named "Mindstone Rebel" and auto-updates work correctly.
    ...(executableName ? { executableName } : {}),
    appBundleId: appBundleId,
    appCategoryType: "public.app-category.productivity",
    protocols: [
      { name: "Mindstone Rebel OAuth", schemes: ["mindstone"] },
      { name: "Mindstone Rebel Navigation", schemes: ["rebel"] },
    ],
    ...(hasMacIcon || hasWinIcon ? { icon: baseIconRelative } : {}),
    // Windows executable metadata - sets publisher info in file properties and firewall dialogs.
    // Without this, Windows shows "GitHub, Inc." (from Electron's base binary).
    // Note: FileDescription is what Windows Task Manager shows in the Processes tab.
    win32metadata: {
      CompanyName: "Mindstone Learning Limited",
      FileDescription: appName,
      ProductName: appName,
      Comments: "Voice-first agentic AI powered by Claude",
      LegalCopyright: `© ${new Date().getFullYear()} Mindstone Learning Limited. All rights reserved.`,
      InternalName: internalName,
      OriginalFilename: `${appName}.exe`,
    },
    osxSign: osxSignConfig,
    ...(osxNotarizeConfig ? { osxNotarize: osxNotarizeConfig } : {}),
    // macOS Info.plist extensions for permission dialogs
    extendInfo: {
      // Bluetooth usage description for Limitless Pendant physical recording
      NSBluetoothAlwaysUsageDescription: "Rebel uses Bluetooth to connect to your Limitless Pendant for recording in-person meetings and conversations.",
      NSBluetoothPeripheralUsageDescription: "Rebel uses Bluetooth to connect to your Limitless Pendant for recording in-person meetings and conversations.",
      // Screen Recording + system-audio usage descriptions for recording a meeting
      // locally on this Mac. Electron 39+ routes desktop audio through Apple's
      // CoreAudio Tap API, so the macOS prompt covers both screen and audio; these
      // strings make that prompt contextual instead of bare. We only request this
      // permission when the user actually starts a local recording.
      NSScreenCaptureUsageDescription: "Rebel records the meeting on your screen so it can transcribe and summarise it for you. It only does this when you start a local recording.",
      NSAudioCaptureUsageDescription: "Rebel records the meeting's audio so it can transcribe and summarise it for you. It only does this when you start a local recording.",
      CFBundleURLTypes: [
        {
          CFBundleURLName: `${appBundleId}.oauth`,
          CFBundleURLSchemes: ["mindstone"],
        },
        {
          CFBundleURLName: `${appBundleId}.navigation`,
          CFBundleURLSchemes: ["rebel"],
        },
      ],
    },
    // ASAR is enabled with selective unpacking:
    // - workers/** unpacked for Node.js Worker Thread access (can't load workers from asar)
    // - @lancedb/lancedb has native bindings that require direct file system access
    // - gpu-worker/** unpacked for Hidden BrowserWindow access (WebGPU embedding)
    // - @recallai/desktop-sdk is copied manually in packageAfterCopy because the
    //   helper subprocess `desktop_sdk_macos_exe` dynamically links into
    //   Frameworks/ (LC_LOAD_DYLIB on @rpath/liblibbot_desktop_rs.dylib and the
    //   GStreamer framework umbrella), and the framework's macOS-standard symlink
    //   topology must be preserved (verbatimSymlinks) and arch-gated (arm64-only
    //   on macOS). See docs-private/investigations/260522_recallai_dyld_liblibbot_missing.md.
    // - Bundled MCP server dependencies are copied manually in packageAfterCopy hook.
    asar: {
      unpack: "{**/workers/**,**/gpu-worker/**,**/node_modules/@lancedb/**,**/node_modules/win-ca/**}",
    },
    // Extra resources (config, media files)
    // Note: node-bundle, mcp, and git-bundle are copied in packageAfterCopy to handle symlinks
    // (extraResource doesn't dereference symlinks, which breaks macOS codesigning)
    extraResource: [
      ...(hasConfig ? [configRelative] : []),
      "./resources/connector-catalog.json",
    ],
  },

  hooks: {
    preStart: async () => {
      // Build embedding worker before dev server starts
      // This ensures the worker exists for local development
      console.log("[preStart] Building embedding worker for dev...");
      const { execSync } = require("child_process");
      try {
        execSync("node scripts/build-worker.mjs", {
          cwd: __dirname,
          stdio: "inherit",
        });
        console.log("[preStart] Embedding worker built successfully");
      } catch (error) {
        console.error("[preStart] Failed to build embedding worker:", error);
        // Don't throw - allow dev to continue even if worker build fails
        // The embedding service will gracefully degrade
      }
    },
    generateAssets: async (config, platform, arch) => {
      // Build the embedding worker after Vite builds the main process
      // The worker is built as a separate file because electron-vite doesn't support
      // multiple entry points for the main process in a way compatible with Worker Threads
      console.log("[generateAssets] Building embedding worker...");
      const { execSync } = require("child_process");
      try {
        execSync("node scripts/build-worker.mjs", {
          cwd: __dirname,
          stdio: "inherit",
        });
        console.log("[generateAssets] Embedding worker built successfully");
      } catch (error) {
        console.error(
          "[generateAssets] Failed to build embedding worker:",
          error,
        );
        throw error;
      }
    },
    packageAfterCopy: async (
      config,
      buildPath,
      electronVersion,
      platform,
      arch,
    ) => {
      // buildPath is <app>/Contents/Resources/app on macOS
      // resourcesDir is <app>/Contents/Resources
      const resourcesDir = path.join(buildPath, "..");

      // Copy all utilityProcess/Worker-Thread workers to app.asar.unpacked/workers.
      // Workers must be on disk (not in asar) for Node.js to load them: this loop
      // readdir's out/main/workers and copies EVERY non-.map file, so each worker
      // built by scripts/build-worker.mjs is covered automatically — embedding,
      // preTurn, atlas, indexHealth, AND cloudLivenessWorker.js (260619 Stage 2;
      // a forked child needs a real on-disk path, not an asar entry).
      console.log("[packageAfterCopy] Copying workers...");
      const outMainWorkers = path.join(__dirname, "out", "main", "workers");
      const unpackedWorkers = path.join(
        resourcesDir,
        "app.asar.unpacked",
        "workers",
      );

      if (fs.existsSync(outMainWorkers)) {
        await fsp.mkdir(unpackedWorkers, { recursive: true });
        const workerFiles = await fsp.readdir(outMainWorkers);
        for (const file of workerFiles) {
          // Skip .map files - they shouldn't be in production builds, but filter
          // as a safety net in case build-worker.mjs generates them unexpectedly
          if (file.endsWith(".map")) {
            console.log(`  Skipping sourcemap: ${file}`);
            continue;
          }
          await fsp.copyFile(
            path.join(outMainWorkers, file),
            path.join(unpackedWorkers, file),
          );
          console.log(`  Copied worker: ${file}`);
        }
        console.log(
          "[packageAfterCopy] Workers copied to app.asar.unpacked/workers",
        );
      } else {
        console.warn("[packageAfterCopy] WARNING: out/main/workers not found");
      }

      // Copy GPU embedding worker to app.asar.unpacked/gpu-worker
      // GPU worker runs in a Hidden BrowserWindow for WebGPU access
      console.log("[packageAfterCopy] Copying GPU embedding worker...");
      const outGpuWorker = path.join(__dirname, "out", "main", "gpu-worker");
      const unpackedGpuWorker = path.join(
        resourcesDir,
        "app.asar.unpacked",
        "gpu-worker",
      );

      if (fs.existsSync(outGpuWorker)) {
        await fsp.mkdir(unpackedGpuWorker, { recursive: true });
        const gpuWorkerFiles = await fsp.readdir(outGpuWorker);
        for (const file of gpuWorkerFiles) {
          // Skip .map files - they shouldn't be in production builds, but filter
          // as a safety net in case build-worker.mjs generates them unexpectedly
          if (file.endsWith(".map")) {
            console.log(`  Skipping GPU worker sourcemap: ${file}`);
            continue;
          }
          await fsp.copyFile(
            path.join(outGpuWorker, file),
            path.join(unpackedGpuWorker, file),
          );
          console.log(`  Copied GPU worker: ${file}`);
        }
        console.log(
          "[packageAfterCopy] GPU embedding worker copied to app.asar.unpacked/gpu-worker",
        );
      } else {
        console.warn("[packageAfterCopy] WARNING: out/main/gpu-worker not found");
      }

      // Step 4: Copy rebel-system manually (can't use extraResource because we need to filter broken symlinks)
      const rebelSystemSrc = path.join(__dirname, "rebel-system");
      const rebelSystemDest = path.join(resourcesDir, "rebel-system");
      if (fs.existsSync(rebelSystemSrc)) {
        console.log("[packageAfterCopy] Copying rebel-system...");
        console.log(`  Source: ${rebelSystemSrc}`);
        console.log(`  Destination: ${rebelSystemDest}`);

        // Directories/files to exclude from rebel-system (not needed at runtime)
        // See: docs/plans/finished/260205_strip_rebel_system_node_modules.md
        const REBEL_SYSTEM_EXCLUDE = new Set([
          'node_modules',
          'cli',
          'scripts',
          '.git',
          '.github',
          'package-lock.json',
          'package.json',
        ]);

        // Custom copy that skips broken symlinks
        async function copyDirSkipBrokenSymlinks(src, dest, excludeSet = null) {
          await fsp.mkdir(dest, { recursive: true });
          const entries = await fsp.readdir(src, { withFileTypes: true });

          for (const entry of entries) {
            // Skip excluded items (only at top level for rebel-system)
            if (excludeSet && excludeSet.has(entry.name)) {
              console.log(`  [packageAfterCopy] Skipping rebel-system/${entry.name}`);
              continue;
            }

            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);

            if (entry.isSymbolicLink()) {
              // Check if symlink target exists
              try {
                await fsp.stat(srcPath); // This follows the symlink
                // Symlink is valid, copy as regular file (safer for codesign)
                const target = await fsp.readlink(srcPath);
                const resolvedTarget = path.resolve(src, target);
                const targetStat = await fsp.stat(resolvedTarget);
                if (targetStat.isDirectory()) {
                  await copyDirSkipBrokenSymlinks(resolvedTarget, destPath); // No excludeSet for nested calls
                } else {
                  await fsp.copyFile(resolvedTarget, destPath);
                }
              } catch {
                // Broken symlink - skip it
                console.log(`  Skipping broken symlink: ${entry.name}`);
              }
            } else if (entry.isDirectory()) {
              await copyDirSkipBrokenSymlinks(srcPath, destPath); // No excludeSet for nested calls
            } else {
              await fsp.copyFile(srcPath, destPath);
            }
          }
        }

        await copyDirSkipBrokenSymlinks(rebelSystemSrc, rebelSystemDest, REBEL_SYSTEM_EXCLUDE);
        console.log("[packageAfterCopy] rebel-system copied successfully");
      } else {
        console.log(
          "[packageAfterCopy] WARNING: rebel-system not found, skipping",
        );
      }

      // Step 5: Copy MCP SDK dependencies for bundled MCP servers
      // The bundled MCP servers (RebelInbox, RebelDiagnostics) are standalone .cjs files
      // that require @modelcontextprotocol/sdk and zod. Since Vite bundles all main process
      // dependencies into app.asar, these modules aren't available for the spawned servers.
      // We copy them to app.asar.unpacked/node_modules so NODE_PATH can find them.
      console.log(
        "[packageAfterCopy] Copying MCP SDK dependencies for bundled servers...",
      );
      const unpackedNodeModules = path.join(
        resourcesDir,
        "app.asar.unpacked",
        "node_modules",
      );
      await fsp.mkdir(unpackedNodeModules, { recursive: true });

      // Helper: recursively copy a package's production-dependency closure into
      // app.asar.unpacked/node_modules. Used after manually-copied unpacked
      // packages (e.g. @recallai/desktop-sdk, @stoprocent/noble) to ensure their
      // runtime deps are present alongside them.
      //
      // Defined inline so it closes over __dirname and unpackedNodeModules. Reuses
      // the top-level copyDir helper for actual file copying.
      //
      // Reads only production `dependencies` — ignores devDependencies,
      // peerDependencies, and optionalDependencies. For each dep: resolves from
      // <parent>/node_modules/<dep> (nested install) first, then top-level
      // node_modules/<dep> (hoisted). Throws if neither exists (fail-loud).
      // Idempotent: skips copy if destination already exists. Recursive over the
      // full closure with cycle protection via copiedSet.
      //
      // See docs-private/investigations/260511_recallai_desktop_sdk_uuid_missing.md.
      async function copyRuntimeDepsForUnpackedPackage(
        parentPackageName,
        copiedSet = new Set(),
      ) {
        const isTopLevel = copiedSet.size === 0;
        const newlyCopiedNames = [];

        // Resolve a dep relative to its parent's *actual installed location*,
        // not the parent's package name. This matters when the parent itself
        // was resolved from a nested location (e.g. node_modules/A/node_modules/B):
        // B's transitive deps may also be nested under B's installed path, and
        // looking them up under the bare top-level name would silently pick up
        // the wrong (hoisted) version. parentSrcPath is the absolute path on
        // disk where the parent package lives.
        async function resolveAndCopy(depName, parentSrcPath, parentDirName) {
          if (copiedSet.has(depName)) {
            return;
          }
          copiedSet.add(depName);

          const nestedSrc = path.join(parentSrcPath, "node_modules", depName);
          const hoistedSrc = path.join(__dirname, "node_modules", depName);

          let resolvedSrc;
          if (fs.existsSync(nestedSrc)) {
            resolvedSrc = nestedSrc;
          } else if (fs.existsSync(hoistedSrc)) {
            resolvedSrc = hoistedSrc;
          } else {
            throw new Error(
              `[packageAfterCopy] copyRuntimeDepsForUnpackedPackage: ` +
                `cannot resolve runtime dep '${depName}' declared by '${parentDirName}'. ` +
                `Checked nested (${nestedSrc}) and hoisted (${hoistedSrc}). ` +
                `Run 'npm ci' to install missing dependencies.`,
            );
          }

          let version = "unknown";
          let depDependencies = {};
          const depPkgJsonPath = path.join(resolvedSrc, "package.json");
          try {
            const raw = await fsp.readFile(depPkgJsonPath, "utf8");
            const parsed = JSON.parse(raw);
            version = parsed.version || "unknown";
            depDependencies = parsed.dependencies || {};
          } catch (err) {
            throw new Error(
              `[packageAfterCopy] copyRuntimeDepsForUnpackedPackage: ` +
                `failed to read package.json for '${depName}' (declared by '${parentDirName}') ` +
                `at ${depPkgJsonPath}: ${err.message}`,
            );
          }

          const dest = path.join(unpackedNodeModules, depName);
          if (fs.existsSync(dest)) {
            // Already present (e.g. copied earlier by manual logic) — still
            // recurse below to ensure its own deps are present.
          } else {
            if (depName.startsWith("@")) {
              const scope = depName.split("/")[0];
              await fsp.mkdir(path.join(unpackedNodeModules, scope), {
                recursive: true,
              });
            }
            console.log(
              `  Copying runtime dep: ${depName}@${version} (for ${parentDirName})`,
            );
            await copyDir(resolvedSrc, dest);
            newlyCopiedNames.push(depName);
          }

          for (const subDepName of Object.keys(depDependencies)) {
            await resolveAndCopy(subDepName, resolvedSrc, depName);
          }
        }

        const parentSrcPath = path.join(
          __dirname,
          "node_modules",
          parentPackageName,
        );
        const parentPkgJsonPath = path.join(parentSrcPath, "package.json");
        let parentDeps = {};
        try {
          const raw = await fsp.readFile(parentPkgJsonPath, "utf8");
          parentDeps = JSON.parse(raw).dependencies || {};
        } catch (err) {
          throw new Error(
            `[packageAfterCopy] copyRuntimeDepsForUnpackedPackage: ` +
              `failed to read package.json for parent '${parentPackageName}' at ${parentPkgJsonPath}: ${err.message}`,
          );
        }

        // Defensive cycle protection: register the top-level parent so any
        // transitive dep that references it back is short-circuited.
        copiedSet.add(parentPackageName);

        for (const depName of Object.keys(parentDeps)) {
          await resolveAndCopy(depName, parentSrcPath, parentPackageName);
        }

        if (isTopLevel) {
          const summary =
            newlyCopiedNames.length > 0
              ? newlyCopiedNames.join(", ")
              : "(none — all already present)";
          console.log(
            `[packageAfterCopy] Copied ${newlyCopiedNames.length} runtime deps for ${parentPackageName}: ${summary}`,
          );
        }
      }

      // Copy @recallai/desktop-sdk into app.asar.unpacked, encoding the arch matrix
      // for Frameworks/ handling and adhoc-signature stripping.
      //
      // The helper subprocess (desktop_sdk_macos_exe) dynamically links into
      // Frameworks/ via @rpath LC_LOAD_DYLIB entries: it loads
      // liblibbot_desktop_rs.dylib and the GStreamer umbrella, and
      // liblibbot_desktop_rs.dylib in turn pulls in the GStreamer framework's
      // internal dylibs. All these must ship for the helper to start at all.
      //
      // Arch matrix:
      //   - arm64 macOS: copy the helper exe + selectively copy Frameworks/ —
      //     standalone dylibs (liblibbot_desktop_rs.dylib, libui_recorder.dylib)
      //     are flat-copied; GStreamer.framework/ (and any other future top-level
      //     framework entry) is copied via fsp.cp with verbatimSymlinks: true so
      //     that the standard macOS framework symlink topology survives intact
      //     (electron-osx-sign handles framework bundles with this layout).
      //   - x64 macOS: skip Frameworks/ entirely. The helper exe is excluded on
      //     x64 (arm64-only binary), so the framework would be dead weight.
      //   - non-macOS: copy everything as-is.
      //
      // Why not the existing copyDir helper for the framework? copyDir uses
      // dereference: true, which flattens symlinks into real copies and breaks
      // the framework's Versions/Current -> 1.0 layout that codesigning expects.
      //
      // Adhoc-signature reset (arm64 macOS only): every Mach-O the SDK ships
      // — the helper exe, the standalone dylibs, the GStreamer framework's main
      // Mach-O, and ~100 inner GStreamer dylibs (Versions/1.0/lib/*.dylib +
      // Versions/1.0/lib/gstreamer-1.0/*.dylib) — is adhoc-linker-signed
      // (flags=0x20002). We re-adhoc-sign every one of them via
      // `codesign --sign - --force` so:
      //   1. The "linker-signed" flag is cleared (giving electron-osx-sign
      //      a clean adhoc state to re-sign over with --force --deep in CI).
      //   2. Local `npm run package` builds (which don't run real signing)
      //      still produce a runnable bundle — Apple Silicon mandates a
      //      valid signature, so simply *removing* the signature would make
      //      every Mach-O unrunnable (SIGKILL by the kernel before dyld even
      //      tries to resolve libraries). Re-adhoc-signing keeps the bundle
      //      runnable while still resetting the signature state.
      // Mach-O detection is magic-byte-based so future SDK layout changes
      // are handled automatically.
      //
      // The 2026-01-08 codesign failure was caused by extraResource symlinks
      // pointing OUTSIDE the bundle, not by in-bundle framework symlinks.
      // See docs-private/investigations/260522_recallai_dyld_liblibbot_missing.md and
      // docs/plans/finished/260108_fix_macos_codesign_failure.md.
      async function copyRecallaiPackage(platform, arch) {
        console.log("[packageAfterCopy] Copying @recallai/desktop-sdk...");
        const recallaiSrc = path.join(
          __dirname,
          "node_modules",
          "@recallai",
          "desktop-sdk",
        );
        const recallaiDest = path.join(
          unpackedNodeModules,
          "@recallai",
          "desktop-sdk",
        );
        if (!fs.existsSync(recallaiSrc)) {
          console.log("[packageAfterCopy] WARNING: @recallai/desktop-sdk not found");
          return;
        }

        await fsp.mkdir(path.join(unpackedNodeModules, "@recallai"), {
          recursive: true,
        });

        const isMac = platform === "darwin";
        const isArm64Mac = isMac && arch === "arm64";
        const isX64Mac = isMac && arch === "x64";

        // Frameworks/ entries we ship flat (regular dylibs, no symlinks).
        const flatFrameworkFiles = new Set([
          "liblibbot_desktop_rs.dylib",
          "libui_recorder.dylib",
        ]);

        const recallaiEntries = await fsp.readdir(recallaiSrc);
        for (const entry of recallaiEntries) {
          // dummy.node is a zero-byte stub that fails macOS codesign.
          if (isMac && entry === "dummy.node") {
            console.log("  Skipping dummy.node (zero-byte file breaks codesign)");
            continue;
          }
          // desktop_sdk_macos_exe is arm64-only.
          if (isX64Mac && entry === "desktop_sdk_macos_exe") {
            console.log("  Skipping desktop_sdk_macos_exe (arm64-only binary, not needed for x64 build)");
            continue;
          }
          // Frameworks/: arch-specific handling on macOS.
          if (isMac && entry === "Frameworks") {
            if (isArm64Mac) {
              console.log("  Copying Frameworks (arm64: dylibs + GStreamer.framework with symlinks preserved)");
              const frameworksSrc = path.join(recallaiSrc, entry);
              const frameworksDest = path.join(recallaiDest, entry);
              await fsp.mkdir(frameworksDest, { recursive: true });
              const frameworkEntries = await fsp.readdir(frameworksSrc);
              for (const fwEntry of frameworkEntries) {
                const fwSrcPath = path.join(frameworksSrc, fwEntry);
                const fwDestPath = path.join(frameworksDest, fwEntry);
                const fwStat = await fsp.lstat(fwSrcPath);
                if (flatFrameworkFiles.has(fwEntry) && fwStat.isFile()) {
                  await fsp.copyFile(fwSrcPath, fwDestPath);
                } else {
                  // Framework bundle (or any other directory): preserve symlink
                  // topology so codesign treats it as a standard framework.
                  // verbatimSymlinks keeps relative symlinks pointing within
                  // the bundle (e.g. Versions/Current -> 1.0).
                  await fsp.cp(fwSrcPath, fwDestPath, {
                    recursive: true,
                    force: true,
                    dereference: false,
                    verbatimSymlinks: true,
                  });
                }
              }
            } else {
              console.log("  Skipping Frameworks (x64: helper exe excluded so framework not needed)");
            }
            continue;
          }
          const srcPath = path.join(recallaiSrc, entry);
          const destPath = path.join(recallaiDest, entry);
          const stat = await fsp.stat(srcPath);
          if (stat.isDirectory()) {
            await copyDir(srcPath, destPath);
          } else {
            await fsp.mkdir(recallaiDest, { recursive: true });
            await fsp.copyFile(srcPath, destPath);
          }
        }

        const excludedItems = ["dummy.node"];
        if (isX64Mac) {
          excludedItems.push("desktop_sdk_macos_exe", "Frameworks");
        }
        console.log(
          `[packageAfterCopy] @recallai/desktop-sdk copied${
            isMac ? ` (excluded on macOS: ${excludedItems.join(" + ")})` : ""
          }`,
        );

        // Strip adhoc signatures (arm64 macOS only) so electron-osx-sign re-signs
        // from a clean state. We detect Mach-Os by magic bytes and walk every
        // shipped file, so this self-adapts to upstream SDK layout changes.
        if (isArm64Mac) {
          const { execFileSync } = require("child_process");

          async function isMachOFile(filePath) {
            let fh;
            try {
              fh = await fsp.open(filePath, "r");
              const buf = Buffer.alloc(4);
              const { bytesRead } = await fh.read(buf, 0, 4, 0);
              if (bytesRead < 4) return false;
              const magic = buf.readUInt32BE(0);
              // 0xfeedface = MH_MAGIC (32-bit), 0xfeedfacf = MH_MAGIC_64,
              // 0xcafebabe = FAT_MAGIC (universal), 0xcefaedfe / 0xcffaedfe
              // = byte-swapped variants.
              return (
                magic === 0xfeedface ||
                magic === 0xfeedfacf ||
                magic === 0xcafebabe ||
                magic === 0xcefaedfe ||
                magic === 0xcffaedfe
              );
            } catch {
              return false;
            } finally {
              if (fh) {
                try { await fh.close(); } catch { /* ignore close errors */ }
              }
            }
          }

          async function resignAdhocMachO(filePath, counts) {
            // `--sign -` = adhoc identity. `--force` overwrites any existing
            // signature (including adhoc-linker-signed). Result: a clean
            // adhoc signature that satisfies Apple Silicon's mandatory
            // codesigning while leaving electron-osx-sign --force free to
            // re-sign with the real Developer ID later in CI.
            try {
              execFileSync(
                "codesign",
                ["--sign", "-", "--force", filePath],
                { stdio: "pipe" },
              );
              counts.resigned += 1;
            } catch (e) {
              counts.failed += 1;
              console.warn(
                `  Warning: codesign --sign - --force failed for ${path.relative(recallaiDest, filePath)}: ${e.message}`,
              );
            }
          }

          async function walkAndResignMachOs(dir, counts) {
            let entries;
            try {
              entries = await fsp.readdir(dir, { withFileTypes: true });
            } catch (e) {
              console.warn(`  Warning: could not read ${dir}: ${e.message}`);
              return;
            }
            for (const entry of entries) {
              const full = path.join(dir, entry.name);
              if (entry.isSymbolicLink()) {
                // Skip symlinks — codesign would re-sign the target via the
                // real file walk, so following the symlink would double-process.
                continue;
              }
              if (entry.isDirectory()) {
                await walkAndResignMachOs(full, counts);
              } else if (entry.isFile()) {
                if (await isMachOFile(full)) {
                  await resignAdhocMachO(full, counts);
                }
              }
            }
          }

          const counts = { resigned: 0, failed: 0 };

          // Helper exe sits at the SDK root, not under Frameworks/.
          const helperExe = path.join(recallaiDest, "desktop_sdk_macos_exe");
          if (fs.existsSync(helperExe) && (await isMachOFile(helperExe))) {
            await resignAdhocMachO(helperExe, counts);
          }

          const frameworksDest = path.join(recallaiDest, "Frameworks");
          if (fs.existsSync(frameworksDest)) {
            await walkAndResignMachOs(frameworksDest, counts);
          }

          console.log(
            `  Re-adhoc-signed ${counts.resigned} Mach-Os ` +
              `(${counts.failed} failed)`,
          );
        }

        await copyRuntimeDepsForUnpackedPackage("@recallai/desktop-sdk");
      }

      // Copy @modelcontextprotocol/sdk from super-mcp (it uses a newer version than main project)
      // super-mcp requires specific SDK version for StreamableHTTPServerTransport compatibility
      const superMcpSdkSrc = path.join(
        __dirname,
        "super-mcp",
        "node_modules",
        "@modelcontextprotocol",
        "sdk",
      );
      const mainSdkSrc = path.join(
        __dirname,
        "node_modules",
        "@modelcontextprotocol",
        "sdk",
      );
      const mcpSdkSrc = fs.existsSync(superMcpSdkSrc)
        ? superMcpSdkSrc
        : mainSdkSrc;
      const mcpSdkDest = path.join(
        unpackedNodeModules,
        "@modelcontextprotocol",
        "sdk",
      );
      if (fs.existsSync(mcpSdkSrc)) {
        console.log(`  Copying @modelcontextprotocol/sdk from: ${mcpSdkSrc}`);
        console.log(`  Copying @modelcontextprotocol/sdk to: ${mcpSdkDest}`);
        await copyDir(mcpSdkSrc, mcpSdkDest);
      } else {
        console.log(
          "  WARNING: @modelcontextprotocol/sdk not found in node_modules",
        );
      }

      // Copy zod (includes v3, v4, v4-mini subdirectories used by the SDK)
      const zodSrc = path.join(__dirname, "node_modules", "zod");
      const zodDest = path.join(unpackedNodeModules, "zod");
      if (fs.existsSync(zodSrc)) {
        console.log(`  Copying zod to: ${zodDest}`);
        await copyDir(zodSrc, zodDest);
      } else {
        console.log("  WARNING: zod not found in node_modules");
      }

      // Copy zod-to-json-schema (required by @modelcontextprotocol/sdk)
      // TODO: Consider automating transitive dependency discovery from SDK's package.json
      const zodToJsonSchemaSrc = path.join(
        __dirname,
        "node_modules",
        "zod-to-json-schema",
      );
      const zodToJsonSchemaDest = path.join(
        unpackedNodeModules,
        "zod-to-json-schema",
      );
      if (fs.existsSync(zodToJsonSchemaSrc)) {
        console.log(`  Copying zod-to-json-schema to: ${zodToJsonSchemaDest}`);
        await copyDir(zodToJsonSchemaSrc, zodToJsonSchemaDest);
      } else {
        console.log("  WARNING: zod-to-json-schema not found in node_modules");
      }

      // Copy graceful-fs to app.asar.unpacked/node_modules.
      // The desktop main bundle now BUNDLES graceful-fs (not external) so it
      // resolves from inside app.asar. This unpacked copy is still needed by
      // out-of-asar consumers that externalise it:
      //   - super-mcp's bundled cli (also has its own node_modules copy as fallback)
      //   - office-sidecar (has its own package)
      //   - 13 handwritten resources/mcp/<name>/server.{cjs,mjs} files
      //   - 17 bundled resources/mcp-generated/<name>/server.cjs outputs
      //   - cloud-service/build.mjs (externalises, runs on bare Node.js — no asar)
      // See docs/plans/260428_graceful_fs_emfile_fix.md, REBEL-536/REBEL-537.
      const gracefulFsSrc = path.join(__dirname, "node_modules", "graceful-fs");
      const gracefulFsDest = path.join(unpackedNodeModules, "graceful-fs");
      if (fs.existsSync(gracefulFsSrc)) {
        console.log(`  Copying graceful-fs to: ${gracefulFsDest}`);
        await copyDir(gracefulFsSrc, gracefulFsDest);
      } else {
        console.log("  WARNING: graceful-fs not found in node_modules");
      }

      // Copy pino logging stack for packaged-build rotating log transport.
      // pino and thread-stream are bundled into the main Vite chunk (because
      // they're statically required at module-init by @core/logger before
      // bootstrap installs NODE_PATH), but ALL three packages must also exist
      // on disk under app.asar.unpacked/node_modules/ so the worker thread
      // chain (pino-worker, thread-stream-worker, pino-roll target) can
      // resolve via globalThis.__bundlerPathsOverrides at runtime.
      // See vite.main.config.mjs for the externalization rationale.
      const pinoRuntimePackages = ["pino-roll", "pino", "thread-stream"];
      for (const packageName of pinoRuntimePackages) {
        const packageSrc = path.join(__dirname, "node_modules", packageName);
        const packageDest = path.join(unpackedNodeModules, packageName);
        if (fs.existsSync(packageSrc)) {
          if (!fs.existsSync(packageDest)) {
            console.log(`  Copying ${packageName} to: ${packageDest}`);
            await copyDir(packageSrc, packageDest);
          }
          await copyRuntimeDepsForUnpackedPackage(packageName);
        } else {
          throw new Error(
            `[packageAfterCopy] FATAL: ${packageName} not found in node_modules. ` +
            "Packaged builds require the pino logging stack for bounded log rotation. " +
            "Run 'npm ci' to install missing dependencies.",
          );
        }
      }

      // Copy super-mcp dependencies from super-mcp/node_modules
      // These are direct dependencies of super-mcp that aren't bundled with the SDK
      const superMcpDeps = [
        "express", // HTTP server framework for super-mcp
        "ajv", // JSON schema validation
        "ajv-formats", // Additional ajv format validators
        "chokidar", // Config file watching
      ];

      // Also copy transitive dependencies that express and other packages need
      const transitiveDeps = [
        // Express and its dependencies
        "accepts",
        "array-flatten",
        "body-parser",
        "content-disposition",
        "content-type",
        "cookie",
        "cookie-signature",
        "debug",
        "depd",
        "destroy",
        "encodeurl",
        "escape-html",
        "etag",
        "finalhandler",
        "fresh",
        "http-errors",
        "iconv-lite",
        "inherits",
        "media-typer",
        "merge-descriptors",
        "methods",
        "mime",
        "mime-types",
        "mime-db",
        "ms",
        "on-finished",
        "parseurl",
        "path-to-regexp",
        "proxy-addr",
        "forwarded",
        "ipaddr.js",
        "qs",
        "range-parser",
        "raw-body",
        "router",
        "safe-buffer",
        "safer-buffer",
        "send",
        "serve-static",
        "setprototypeof",
        "side-channel",
        "statuses",
        "type-is",
        "unpipe",
        "utils-merge",
        "vary",
        "bytes",
        "ee-first",
        "object-inspect",
        "call-bind-apply-helpers",
        "get-intrinsic",
        "es-errors",
        "es-define-property",
        "gopd",
        "has-symbols",
        "has-proto",
        "function-bind",
        "hasown",
        "dunder-proto",
        "es-object-atoms",
        "math-intrinsics",
        "call-bound",
        // ajv transitive deps
        "fast-deep-equal",
        "fast-uri",
        "json-schema-traverse",
        "require-from-string",
      ];

      const allDeps = [...superMcpDeps, ...transitiveDeps];
      const superMcpNodeModules = path.join(
        __dirname,
        "super-mcp",
        "node_modules",
      );

      for (const dep of allDeps) {
        // Check super-mcp/node_modules first, fall back to main node_modules
        let depSrc = path.join(superMcpNodeModules, dep);
        if (!fs.existsSync(depSrc)) {
          depSrc = path.join(__dirname, "node_modules", dep);
        }
        const depDest = path.join(unpackedNodeModules, dep);
        if (fs.existsSync(depSrc) && !fs.existsSync(depDest)) {
          console.log(`  Copying ${dep} to: ${depDest}`);
          await copyDir(depSrc, depDest);
        }
      }

      // Handle scoped packages from super-mcp that might be missing
      const scopedDeps = ["@types/express"];
      for (const dep of scopedDeps) {
        const [scope, name] = dep.split("/");
        const depSrc = path.join(superMcpNodeModules, scope, name);
        const depDest = path.join(unpackedNodeModules, scope, name);
        if (fs.existsSync(depSrc) && !fs.existsSync(depDest)) {
          console.log(`  Copying ${dep} to: ${depDest}`);
          await fsp.mkdir(path.join(unpackedNodeModules, scope), {
            recursive: true,
          });
          await copyDir(depSrc, depDest);
        }
      }

      console.log(
        "[packageAfterCopy] MCP SDK dependencies copied successfully",
      );

      // Step 5b: Copy LanceDB native module for semantic search
      // LanceDB is marked as external in Vite (can't be bundled), so it needs to be
      // available at runtime. Native modules can't load from asar, so we copy to unpacked.
      // This includes the main package and platform-specific native bindings.
      console.log("[packageAfterCopy] Copying LanceDB native module...");
      const lancedbScopeSrc = path.join(__dirname, "node_modules", "@lancedb");
      const lancedbScopeDest = path.join(unpackedNodeModules, "@lancedb");
      if (fs.existsSync(lancedbScopeSrc)) {
        // Validate that the target platform's binary package is present
        // This catches cross-compilation issues (e.g. building x64 on arm64) where npm ci
        // skipped optional dependencies for the target architecture.
        // If missing, the app will crash at runtime with "Cannot find module".
        let lancedbTargetPackage = null;
        if (platform === "darwin") {
          lancedbTargetPackage = `lancedb-darwin-${arch}`;
        } else if (platform === "win32") {
          lancedbTargetPackage = `lancedb-win32-${arch}-msvc`;
        } else if (platform === "linux") {
          // Default to gnu (glibc) for standard Linux builds
          lancedbTargetPackage = `lancedb-linux-${arch}-gnu`;
        }

        if (lancedbTargetPackage) {
          const targetPkgPath = path.join(lancedbScopeSrc, lancedbTargetPackage);
          if (!fs.existsSync(targetPkgPath)) {
            console.error(`[packageAfterCopy] ERROR: LanceDB binary for target ${platform}-${arch} is missing!`);
            console.error(`[packageAfterCopy] Expected at: ${targetPkgPath}`);
            console.error(`[packageAfterCopy] This usually happens when cross-compiling (e.g. building x64 on arm64).`);
            console.error(`[packageAfterCopy] Fix: Run "npm install @lancedb/${lancedbTargetPackage} --no-save" to install it manually.`);
            throw new Error(`Missing LanceDB binary for ${platform}-${arch}`);
          }
          console.log(`[packageAfterCopy] Verified target binary exists: ${lancedbTargetPackage}`);
        }

        const lancedbPackages = await fsp.readdir(lancedbScopeSrc);
        await fsp.mkdir(lancedbScopeDest, { recursive: true });
        for (const pkg of lancedbPackages) {
          const pkgSrc = path.join(lancedbScopeSrc, pkg);
          const pkgDest = path.join(lancedbScopeDest, pkg);
          const pkgStat = await fsp.stat(pkgSrc);
          if (pkgStat.isDirectory()) {
            console.log(`  Copying @lancedb/${pkg}`);
            await copyDir(pkgSrc, pkgDest);
          }
        }
        console.log(
          "[packageAfterCopy] LanceDB native module copied successfully",
        );
      } else {
        console.log(
          "[packageAfterCopy] WARNING: @lancedb not found in node_modules",
        );
      }

      // Step 5c: Copy @huggingface/transformers and onnxruntime-node for embedding generation
      // These are marked as external in Vite and need to be available at runtime.
      // onnxruntime-node contains native bindings that can't load from asar.
      console.log(
        "[packageAfterCopy] Copying HuggingFace transformers and onnxruntime...",
      );
      const hfScopeSrc = path.join(__dirname, "node_modules", "@huggingface");
      const hfScopeDest = path.join(unpackedNodeModules, "@huggingface");
      if (fs.existsSync(hfScopeSrc)) {
        const hfPackages = await fsp.readdir(hfScopeSrc);
        await fsp.mkdir(hfScopeDest, { recursive: true });
        for (const pkg of hfPackages) {
          const pkgSrc = path.join(hfScopeSrc, pkg);
          const pkgDest = path.join(hfScopeDest, pkg);
          const pkgStat = await fsp.stat(pkgSrc);
          if (pkgStat.isDirectory()) {
            console.log(`  Copying @huggingface/${pkg}`);
            await copyDir(pkgSrc, pkgDest);
          }
        }
      } else {
        console.log(
          "[packageAfterCopy] WARNING: @huggingface not found in node_modules",
        );
      }

      // Copy onnxruntime-node (native dependency of transformers.js)
      const onnxSrc = path.join(__dirname, "node_modules", "onnxruntime-node");
      const onnxDest = path.join(unpackedNodeModules, "onnxruntime-node");
      if (fs.existsSync(onnxSrc)) {
        console.log("  Copying onnxruntime-node");
        await copyDir(onnxSrc, onnxDest);

        // Strip unused platform binaries to reduce bundle size (~140MB savings)
        // onnxruntime-node ships with darwin/linux/win32 binaries but we only need one
        const onnxBinDir = path.join(onnxDest, "bin", "napi-v3");
        if (fs.existsSync(onnxBinDir)) {
          const allPlatforms = ["darwin", "linux", "win32"];
          const unusedPlatforms = allPlatforms.filter((p) => p !== platform);
          for (const unusedPlatform of unusedPlatforms) {
            const platformDir = path.join(onnxBinDir, unusedPlatform);
            if (fs.existsSync(platformDir)) {
              console.log(
                `  Removing unused onnxruntime platform: ${unusedPlatform}`,
              );
              await deleteDir(platformDir);
            }
          }

          // Strip opposite-architecture binaries on macOS to fix codesigning
          // onnxruntime ships with both arm64 and x64 binaries under darwin/
          // Having both causes electron-osx-sign to fail with cross-arch errors
          if (platform === "darwin") {
            const oppositeArch = arch === "arm64" ? "x64" : "arm64";
            const oppositeArchDir = path.join(onnxBinDir, "darwin", oppositeArch);
            if (fs.existsSync(oppositeArchDir)) {
              console.log(
                `  Removing opposite-arch onnxruntime: darwin/${oppositeArch}`,
              );
              await deleteDir(oppositeArchDir);
            }
          }
        }
      } else {
        console.log(
          "[packageAfterCopy] WARNING: onnxruntime-node not found in node_modules",
        );
      }

      // Copy onnxruntime-common (dependency of onnxruntime-node)
      const onnxCommonSrc = path.join(
        __dirname,
        "node_modules",
        "onnxruntime-common",
      );
      const onnxCommonDest = path.join(unpackedNodeModules, "onnxruntime-common");
      if (fs.existsSync(onnxCommonSrc)) {
        console.log("  Copying onnxruntime-common");
        await copyDir(onnxCommonSrc, onnxCommonDest);
      }

      // Step 5d: Copy sherpa-onnx-node for local STT on Windows
      // sherpa-onnx-node is a native module for speech-to-text using Parakeet models
      // It has platform-specific native binaries that can't load from asar
      if (platform === "win32") {
        console.log("[packageAfterCopy] Copying sherpa-onnx-node for Windows STT...");
        const sherpaNodeSrc = path.join(__dirname, "node_modules", "sherpa-onnx-node");
        const sherpaNodeDest = path.join(unpackedNodeModules, "sherpa-onnx-node");
        if (fs.existsSync(sherpaNodeSrc)) {
          console.log("  Copying sherpa-onnx-node");
          await copyDir(sherpaNodeSrc, sherpaNodeDest);
        }
        // Copy platform-specific sherpa-onnx native library
        const sherpaWinSrc = path.join(__dirname, "node_modules", "sherpa-onnx-win-x64");
        const sherpaWinDest = path.join(unpackedNodeModules, "sherpa-onnx-win-x64");
        if (fs.existsSync(sherpaWinSrc)) {
          console.log("  Copying sherpa-onnx-win-x64 native library");
          await copyDir(sherpaWinSrc, sherpaWinDest);
        } else {
          console.log("[packageAfterCopy] NOTE: sherpa-onnx-win-x64 not found (only installed on Windows)");
        }
      }

      // Step 5e: Copy @stoprocent/noble for BLE (Limitless Pendant physical recording)
      // Noble is a native BLE library that can't be bundled into asar.
      // It has platform-specific native bindings that require file system access.
      console.log("[packageAfterCopy] Copying @stoprocent/noble for BLE...");
      const nobleScopeSrc = path.join(__dirname, "node_modules", "@stoprocent");
      const nobleScopeDest = path.join(unpackedNodeModules, "@stoprocent");
      if (fs.existsSync(nobleScopeSrc)) {
        const noblePackages = await fsp.readdir(nobleScopeSrc);
        await fsp.mkdir(nobleScopeDest, { recursive: true });
        for (const pkg of noblePackages) {
          const pkgSrc = path.join(nobleScopeSrc, pkg);
          const pkgDest = path.join(nobleScopeDest, pkg);
          const pkgStat = await fsp.stat(pkgSrc);
          if (pkgStat.isDirectory()) {
            console.log(`  Copying @stoprocent/${pkg}`);
            await copyDir(pkgSrc, pkgDest);
          }
        }
        console.log("[packageAfterCopy] @stoprocent/noble copied successfully");
        await copyRuntimeDepsForUnpackedPackage("@stoprocent/noble");
      } else {
        console.log("[packageAfterCopy] NOTE: @stoprocent/noble not found in node_modules");
      }

      // Step 5f: Copy fsevents for macOS native file watching (macOS only)
      // fsevents is an optional dependency of chokidar that provides native FSEvents
      // integration on macOS. Without it, chokidar falls back to fs.watchFile polling,
      // which causes ~100% CPU from stat() storms on large workspaces (1900+ directories).
      // fsevents is excluded from the asar by electron-packager (optional dep pruning),
      // so we must manually copy it to app.asar.unpacked/node_modules/.
      if (platform === "darwin") {
        console.log("[packageAfterCopy] Copying fsevents for macOS native file watching...");
        const fseventsSrc = path.join(__dirname, "node_modules", "fsevents");
        const fseventsDest = path.join(unpackedNodeModules, "fsevents");
        if (fs.existsSync(fseventsSrc)) {
          await copyDir(fseventsSrc, fseventsDest);
          console.log("[packageAfterCopy] fsevents copied successfully");
        } else {
          throw new Error(
            "[packageAfterCopy] FATAL: fsevents not found in node_modules. " +
            "macOS builds require fsevents for native file watching. " +
            "Without it, chokidar falls back to polling (~100% CPU). " +
            "Run 'npm ci' to install optional dependencies."
          );
        }
      }

      // Step 5g: Copy win-ca for Windows TLS certificate trust (Windows only)
      // win-ca ships roots.exe and native .node binaries that must be on disk (not in asar).
      // It reads the Windows system certificate store and injects certs into Node.js TLS.
      // Without this, HTTPS calls fail with "unable to get local issuer certificate".
      if (platform === "win32") {
        console.log("[packageAfterCopy] Copying win-ca for Windows TLS support...");
        const winCaSrc = path.join(__dirname, "node_modules", "win-ca");
        const winCaDest = path.join(unpackedNodeModules, "win-ca");
        if (fs.existsSync(winCaSrc)) {
          await copyDir(winCaSrc, winCaDest);
          // Also copy win-ca's dependencies (is-electron, node-forge, make-dir, split)
          const winCaDeps = ["is-electron", "node-forge", "make-dir", "split", "pify", "through"];
          for (const dep of winCaDeps) {
            const depSrc = path.join(__dirname, "node_modules", dep);
            const depDest = path.join(unpackedNodeModules, dep);
            if (fs.existsSync(depSrc) && !fs.existsSync(depDest)) {
              await copyDir(depSrc, depDest);
              console.log(`  Copied win-ca dependency: ${dep}`);
            }
          }
          console.log("[packageAfterCopy] win-ca copied successfully");
        } else {
          console.log("[packageAfterCopy] WARNING: win-ca not found in node_modules");
        }
      }

      // Copy apache-arrow (dependency of @lancedb/lancedb)
      const arrowSrc = path.join(__dirname, "node_modules", "apache-arrow");
      const arrowDest = path.join(unpackedNodeModules, "apache-arrow");
      if (fs.existsSync(arrowSrc)) {
        console.log("  Copying apache-arrow");
        await copyDir(arrowSrc, arrowDest);
      } else {
        console.log(
          "[packageAfterCopy] WARNING: apache-arrow not found in node_modules",
        );
      }

      // Copy additional transitive dependencies for native modules
      const nativeTransitiveDeps = [
        // apache-arrow dependencies
        "tslib",
        "flatbuffers",
        // @lancedb/lancedb dependencies
        "reflect-metadata",
        // sharp dependencies
        "detect-libc",
        "semver",
        "color",
        "color-string",
        "color-name",
        "color-convert",
        "simple-swizzle",
        "is-arrayish",
      ];

      // Copy all @img/* packages (sharp platform bindings + libvips native libs).
      // Dynamic discovery ensures every platform gets its native deps without
      // maintaining a static list that silently breaks cross-platform builds.
      const imgScopeDir = path.join(__dirname, "node_modules", "@img");
      const imgPackages = fs.existsSync(imgScopeDir)
        ? fs.readdirSync(imgScopeDir).filter((entry) => {
            return fs
              .statSync(path.join(imgScopeDir, entry))
              .isDirectory();
          })
        : [];
      for (const pkg of imgPackages) {
        const depSrc = path.join(imgScopeDir, pkg);
        const depDest = path.join(unpackedNodeModules, "@img", pkg);
        if (!fs.existsSync(depDest)) {
          console.log(`  Copying @img/${pkg}`);
          await fsp.mkdir(path.join(unpackedNodeModules, "@img"), {
            recursive: true,
          });
          await copyDir(depSrc, depDest);
        }
      }

      for (const dep of nativeTransitiveDeps) {
        const depSrc = path.join(__dirname, "node_modules", dep);
        const depDest = path.join(unpackedNodeModules, dep);
        if (fs.existsSync(depSrc) && !fs.existsSync(depDest)) {
          console.log(`  Copying ${dep}`);
          await copyDir(depSrc, depDest);
        }
      }

      // Copy sharp (image processing dependency that may be needed)
      const sharpSrc = path.join(__dirname, "node_modules", "sharp");
      const sharpDest = path.join(unpackedNodeModules, "sharp");
      if (fs.existsSync(sharpSrc)) {
        console.log("  Copying sharp");
        await copyDir(sharpSrc, sharpDest);
      }

      console.log(
        "[packageAfterCopy] HuggingFace transformers and dependencies copied successfully",
      );

      // Step 6: Copy super-mcp dist AND node_modules (bundled MCP router)
      // super-mcp is now bundled instead of fetched via npx for faster startup and offline support
      // IMPORTANT: We copy node_modules alongside dist because Node.js resolves modules
      // relative to the script file location, not cwd or NODE_PATH alone.
      // NOTE: These two copies run in parallel for faster builds (especially on Windows)
      const superMcpDistSrc = path.join(__dirname, "super-mcp", "dist");
      const superMcpDistDest = path.join(resourcesDir, "super-mcp", "dist");
      const superMcpNodeModulesSrc = path.join(
        __dirname,
        "super-mcp",
        "node_modules",
      );
      const superMcpNodeModulesDest = path.join(
        resourcesDir,
        "super-mcp",
        "node_modules",
      );

      // Create parent directory first (needed for both copies)
      await fsp.mkdir(path.join(resourcesDir, "super-mcp"), { recursive: true });

      // Run both copies in parallel for significant speedup on Windows
      const superMcpCopyTasks = [];

      if (fs.existsSync(superMcpDistSrc)) {
        console.log("[packageAfterCopy] Copying super-mcp dist...");
        console.log(`  Source: ${superMcpDistSrc}`);
        console.log(`  Destination: ${superMcpDistDest}`);
        superMcpCopyTasks.push(
          copyDir(superMcpDistSrc, superMcpDistDest).then(() => {
            console.log("[packageAfterCopy] super-mcp dist copied successfully");
          }),
        );
      } else {
        throw new Error(
          'super-mcp/dist not found. Run `npm run build:super-mcp` before packaging. ' +
          '(Shipping without it silently produces a broken bundle — MCP router missing.)',
        );
      }

      if (fs.existsSync(superMcpNodeModulesSrc)) {
        console.log("[packageAfterCopy] Copying super-mcp node_modules...");
        console.log(`  Source: ${superMcpNodeModulesSrc}`);
        console.log(`  Destination: ${superMcpNodeModulesDest}`);
        superMcpCopyTasks.push(
          copyDir(superMcpNodeModulesSrc, superMcpNodeModulesDest).then(() => {
            console.log(
              "[packageAfterCopy] super-mcp node_modules copied successfully",
            );
          }),
        );
      } else {
        throw new Error(
          'super-mcp/node_modules not found. Run `npm run build:super-mcp` (or `cd super-mcp && npm ci`) before packaging. ' +
          '(Shipping without it silently produces a broken bundle — super-mcp dependencies missing.)',
        );
      }

      // Wait for all super-mcp copies to complete
      await Promise.all(superMcpCopyTasks);

      // Step 6a: Copy browser-extension dist for App Bridge installer
      const browserExtSrc = path.join(__dirname, "packages", "browser-extension", "dist");
      const browserExtDest = path.join(resourcesDir, "browser-extension");
      if (fs.existsSync(browserExtSrc)) {
        console.log("[packageAfterCopy] Copying browser-extension dist...");
        await copyDir(browserExtSrc, browserExtDest);
        console.log("[packageAfterCopy] browser-extension dist copied successfully");
      } else {
        if (!process.env.MINDSTONE_REBEL_ALLOW_MISSING_BROWSER_EXTENSION) {
          throw new Error('packages/browser-extension/dist not found. Run `npm run build:browser-extension` before packaging, or set MINDSTONE_REBEL_ALLOW_MISSING_BROWSER_EXTENSION=1 to skip.');
        }
        console.log("[packageAfterCopy] WARNING: packages/browser-extension/dist not found");
      }

      // Step 6b: Copy managed-install seed tarballs (Office MCP). These let
      // first-launch installs skip the npm registry round-trip and work
      // offline. See scripts/build-managed-install-seeds.mjs.
      const seedsSrc = path.join(__dirname, "dist", "managed-install-seeds");
      const seedsDest = path.join(resourcesDir, "managed-install-seeds");
      if (fs.existsSync(seedsSrc)) {
        console.log("[packageAfterCopy] Copying managed-install seeds...");
        await copyDir(seedsSrc, seedsDest);
        console.log("[packageAfterCopy] managed-install seeds copied successfully");
      } else {
        if (!process.env.MINDSTONE_REBEL_ALLOW_MISSING_INSTALL_SEEDS) {
          throw new Error('dist/managed-install-seeds not found. Run `npm run build:managed-install-seeds` before packaging, or set MINDSTONE_REBEL_ALLOW_MISSING_INSTALL_SEEDS=1 to skip (first-launch will fall back to npm registry).');
        }
        console.log("[packageAfterCopy] WARNING: dist/managed-install-seeds not found — first launch will fetch from npm");
      }

      // Step 6c: Copy standalone Rebel CLI for packaged-app installs.
      // The setup scripts create per-user PATH shims/symlinks and refuse to
      // overwrite an existing `rebel` command.
      const rebelCliDest = path.join(resourcesDir, "rebel-cli");
      const rebelCliJsSrc = path.join(rebelCliDistPath, "rebel.js");
      if (!fs.existsSync(rebelCliJsSrc)) {
        throw new Error(
          'scripts/rebel-cli/dist/rebel.js not found. Run `npm run build:rebel-cli` before packaging.',
        );
      }
      console.log("[packageAfterCopy] Copying standalone Rebel CLI...");
      await fsp.mkdir(rebelCliDest, { recursive: true });
      await fsp.copyFile(rebelCliJsSrc, path.join(rebelCliDest, "rebel.js"));
      await fsp.chmod(path.join(rebelCliDest, "rebel.js"), 0o755);
      const rebelCliDistPackageJson = path.join(rebelCliDistPath, "package.json");
      if (fs.existsSync(rebelCliDistPackageJson)) {
        await fsp.copyFile(
          rebelCliDistPackageJson,
          path.join(rebelCliDest, "package.json"),
        );
      }
      await fsp.copyFile(setupCliPathSh, path.join(rebelCliDest, "setup-cli-path.sh"));
      await fsp.chmod(path.join(rebelCliDest, "setup-cli-path.sh"), 0o755);
      await fsp.copyFile(setupCliPathPs1, path.join(rebelCliDest, "setup-cli-path.ps1"));
      console.log("[packageAfterCopy] Standalone Rebel CLI copied successfully");

      // Remove .bin directories from ALL copied node_modules - these are build-time CLI tools
      // (semver, prebuild-install, etc.) that aren't needed at runtime, and their symlinks
      // cause macOS codesigning to fail with:
      // - "code has no resources but signature indicates they must be present"
      // - "invalid destination for symbolic link in bundle"
      // Note: Even with dereference:true in copyDir, nested .bin directories may still cause issues
      const superMcpBinDir = path.join(superMcpNodeModulesDest, ".bin");
      if (fs.existsSync(superMcpBinDir)) {
        console.log("[packageAfterCopy] Removing unused super-mcp .bin directory...");
        await deleteDir(superMcpBinDir);
        console.log("[packageAfterCopy] super-mcp .bin directory removed");
      }

      // Also remove .bin from app.asar.unpacked/node_modules
      const unpackedBinDir = path.join(unpackedNodeModules, ".bin");
      if (fs.existsSync(unpackedBinDir)) {
        console.log("[packageAfterCopy] Removing unused app.asar.unpacked .bin directory...");
        await deleteDir(unpackedBinDir);
        console.log("[packageAfterCopy] app.asar.unpacked .bin directory removed");
      }

      await copyRecallaiPackage(platform, arch);

      // Step 6b: Copy fluidaudiocli for local STT (macOS only for now)
      // This is the CLI binary for Parakeet V3 CoreML speech recognition
      // The binary is universal (arm64 + x64) so no arch selection needed
      if (platform === "darwin") {
        const fluidaudiocliSrc = path.join(__dirname, "resources", "local-stt", "fluidaudiocli-darwin");
        const fluidaudiocliDest = path.join(resourcesDir, "fluidaudiocli");
        if (fs.existsSync(fluidaudiocliSrc)) {
          console.log("[packageAfterCopy] Copying fluidaudiocli for local STT...");
          await fsp.copyFile(fluidaudiocliSrc, fluidaudiocliDest);
          // Ensure executable permissions
          await fsp.chmod(fluidaudiocliDest, 0o755);
          console.log("[packageAfterCopy] fluidaudiocli copied successfully");
        } else {
          console.log("[packageAfterCopy] NOTE: fluidaudiocli-darwin not found, local STT will be unavailable");
          console.log("[packageAfterCopy] To enable: build FluidAudio CLI and copy to resources/local-stt/fluidaudiocli-darwin");
        }

        // Step 6c: Copy ESpeakNG.framework for fluidaudiocli (required dependency)
        // The fluidaudiocli binary links against ESpeakNG.framework at @rpath
        // We must copy the framework and ensure the binary can find it
        const espeakngSrc = path.join(__dirname, "resources", "local-stt", "ESpeakNG.framework");
        const frameworksDir = path.join(resourcesDir, "..", "Frameworks");
        const espeakngDest = path.join(frameworksDir, "ESpeakNG.framework");

        if (fs.existsSync(espeakngSrc) && fs.existsSync(fluidaudiocliDest)) {
          console.log("[packageAfterCopy] Copying ESpeakNG.framework for local STT...");

          // Ensure Frameworks directory exists
          await fsp.mkdir(frameworksDir, { recursive: true });

          // Use ditto to preserve macOS framework structure (symlinks etc.)
          // fs.cp with dereference:true would break the framework layout
          const { execFileSync } = require("child_process");
          try {
            execFileSync("ditto", [espeakngSrc, espeakngDest], { stdio: "pipe" });
            console.log("[packageAfterCopy] ESpeakNG.framework copied successfully");

            // Fix RPATH in fluidaudiocli to find ESpeakNG in Frameworks directory
            // The binary expects @rpath/ESpeakNG.framework/...
            // We add @executable_path/../Frameworks to the RPATH search path
            try {
              execFileSync("install_name_tool", [
                "-add_rpath",
                "@executable_path/../Frameworks",
                fluidaudiocliDest,
              ], { stdio: "pipe" });
              console.log("[packageAfterCopy] Added RPATH to fluidaudiocli for ESpeakNG discovery");
            } catch (rpathErr) {
              // May fail if RPATH already exists (e.g., in dev builds) - that's OK
              if (rpathErr.message.includes("would duplicate")) {
                console.log("[packageAfterCopy] RPATH already exists in fluidaudiocli");
              } else {
                console.warn(`[packageAfterCopy] Warning: Failed to add RPATH: ${rpathErr.message}`);
              }
            }
          } catch (dittoErr) {
            console.warn(`[packageAfterCopy] Warning: Failed to copy ESpeakNG.framework: ${dittoErr.message}`);
          }
        } else if (fs.existsSync(fluidaudiocliSrc) && !fs.existsSync(espeakngSrc)) {
          console.log("[packageAfterCopy] NOTE: ESpeakNG.framework not found - local STT may fail");
          console.log("[packageAfterCopy] To fix: copy ESpeakNG.framework to resources/local-stt/");
        }
      }

      // Step 7: Strip unnecessary files to reduce bundle size and fix CI issues
      // - Windows: Squirrel/NuGet fails with paths > 260 chars
      // - macOS: codesigning fails with EMFILE (too many open files)
      // These files (.d.ts, .d.ts.map, .js.map) are only needed at compile time
      console.log("[packageAfterCopy] Step 7: Stripping unnecessary files...");
      const stripStart = Date.now();
      let totalFilesRemoved = 0;
      let totalDirsRemoved = 0;

      const stripResult1 = await stripUnnecessaryFiles(
        unpackedNodeModules,
        "app.asar.unpacked/node_modules",
      );
      totalFilesRemoved += stripResult1.removed;
      totalDirsRemoved += stripResult1.dirs;

      const stripResult2 = await stripUnnecessaryFiles(
        superMcpNodeModulesDest,
        "super-mcp/node_modules",
      );
      totalFilesRemoved += stripResult2.removed;
      totalDirsRemoved += stripResult2.dirs;

      // Step 7b: Copy node-bundle manually (can't use extraResource - symlinks break codesigning)
      // node-bundle/bin contains symlinks (npm, npx, corepack) that point to ../lib/node_modules/
      // Using dereference:true in copyDir converts these to regular files
      if (hasNodeBundle) {
        console.log("[packageAfterCopy] Step 7b: Copying node-bundle (with symlink resolution)...");
        const nodeBundleDest = path.join(resourcesDir, "node-bundle");
        console.log(`  Source: ${nodeBundlePath}`);
        console.log(`  Destination: ${nodeBundleDest}`);
        await copyDir(nodeBundlePath, nodeBundleDest);
        console.log("[packageAfterCopy] node-bundle copied successfully");

        // Step 7b-1b: Fix npm/npx scripts after symlink dereferencing (macOS/Linux only)
        // When symlinks are converted to regular files, the relative require paths break.
        // Original structure: bin/npx -> ../lib/node_modules/npm/bin/npx-cli.js
        // After dereference: bin/npx is a copy of npx-cli.js, but require('../lib/cli.js')
        // now resolves to node-bundle/lib/cli.js (wrong) instead of node-bundle/lib/node_modules/npm/lib/cli.js
        // Fix: Replace bin/npm and bin/npx with wrapper scripts that invoke the correct paths.
        // Note: Windows node-bundle has no bin/ directory (node.exe at root, npm/npx via .cmd files)
        const binDir = path.join(nodeBundleDest, "bin");
        if (platform !== "win32" && fs.existsSync(binDir)) {
          console.log("[packageAfterCopy] Step 7b-1b: Fixing npm/npx wrapper scripts...");
          
          // Create npm wrapper script
          const npmWrapper = `#!/usr/bin/env node
// Wrapper script for bundled npm
// Invokes the actual npm-cli.js from its correct location
require('../lib/node_modules/npm/bin/npm-cli.js');
`;
          await fsp.writeFile(path.join(binDir, "npm"), npmWrapper, { mode: 0o755 });
          
          // Create npx wrapper script
          const npxWrapper = `#!/usr/bin/env node
// Wrapper script for bundled npx
// Invokes the actual npx-cli.js from its correct location
require('../lib/node_modules/npm/bin/npx-cli.js');
`;
          await fsp.writeFile(path.join(binDir, "npx"), npxWrapper, { mode: 0o755 });
          
          // Create corepack wrapper script
          const corepackWrapper = `#!/usr/bin/env node
// Wrapper script for bundled corepack
// Invokes the actual corepack.js from its correct location
require('../lib/node_modules/corepack/dist/corepack.js');
`;
          await fsp.writeFile(path.join(binDir, "corepack"), corepackWrapper, { mode: 0o755 });
          
          console.log("[packageAfterCopy] npm/npx/corepack wrapper scripts created");
        } else if (platform === "win32") {
          console.log("[packageAfterCopy] Step 7b-1b: Skipping wrapper scripts (Windows uses .cmd files)");
        }

        // Step 7b-2: Strip unnecessary files from node-bundle to reduce file count
        // node-bundle contains ~4,800 files with headers, man pages, docs that aren't needed at runtime
        console.log("[packageAfterCopy] Step 7b-2: Stripping node-bundle...");
        const nodeBundleStripStart = Date.now();
        let nodeBundleFilesRemoved = 0;
        let nodeBundleDirsRemoved = 0;

        // Helper function to count files recursively
        async function countFilesRecursive(dir) {
          let count = 0;
          try {
            const entries = await fsp.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory()) {
                count += await countFilesRecursive(path.join(dir, entry.name));
              } else {
                count++;
              }
            }
          } catch {}
          return count;
        }

        // Remove directories not needed at runtime
        const nodeBundleDirsToRemove = [
          "include",           // C/C++ headers (V8, Node, OpenSSL)
          "share/doc",         // Documentation
          "share/man",         // Man pages
          "share/systemtap",   // SystemTap probes
          "lib/node_modules/npm/docs",  // npm documentation
          "lib/node_modules/npm/man",   // npm man pages
        ];

        for (const relDir of nodeBundleDirsToRemove) {
          const dirPath = path.join(nodeBundleDest, relDir);
          if (fs.existsSync(dirPath)) {
            const countBefore = await countFilesRecursive(dirPath);
            await fsp.rm(dirPath, { recursive: true, force: true });
            nodeBundleDirsRemoved++;
            nodeBundleFilesRemoved += countBefore;
            console.log(`[packageAfterCopy]   Removed ${relDir}/ (~${countBefore} files)`);
          }
        }

        // Remove file patterns not needed at runtime
        const nodeBundleFilePatternsToRemove = [
          /\.pdb$/,          // Windows debug symbols
          /\.lib$/,          // Windows static libraries  
          /\.exp$/,          // Windows export files
          /^CHANGELOG/i,     // Changelogs
          /^README/i,        // Readmes
          /^LICENSE/i,       // License files
          /\.md$/,           // Markdown files
        ];

        async function stripNodeBundleFiles(dir) {
          let entries;
          try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
          } catch {
            // Directory may not exist or be inaccessible
            return;
          }
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              await stripNodeBundleFiles(fullPath);
              // Clean up empty directories
              try {
                const remaining = await fsp.readdir(fullPath);
                if (remaining.length === 0) {
                  await fsp.rmdir(fullPath);
                }
              } catch {}
            } else if (entry.isFile()) {
              for (const pattern of nodeBundleFilePatternsToRemove) {
                if (pattern.test(entry.name)) {
                  try {
                    await fsp.unlink(fullPath);
                    nodeBundleFilesRemoved++;
                  } catch {
                    // File may be locked or already removed
                  }
                  break;
                }
              }
            }
          }
        }
        await stripNodeBundleFiles(nodeBundleDest);

        const nodeBundleStripDuration = ((Date.now() - nodeBundleStripStart) / 1000).toFixed(1);
        console.log(`[packageAfterCopy] node-bundle stripped in ${nodeBundleStripDuration}s (${nodeBundleFilesRemoved} files, ${nodeBundleDirsRemoved} dirs)`);
        totalFilesRemoved += nodeBundleFilesRemoved;
        totalDirsRemoved += nodeBundleDirsRemoved;
      }



      // Step 7b-3: Windows-only: Copy app-local MSVC runtime DLLs for native modules
      // We ship the DLLs app-local to avoid running vc_redist at install/first-run (no UAC, fully offline install).
      if (platform === "win32" && arch === "x64") {
        console.log(
          "[packageAfterCopy] Step 7b-3: Copying MSVC runtime DLLs (app-local)...",
        );

        const msvcRuntimeSrc = path.join(
          __dirname,
          "resources",
          "windows",
          "msvc-runtime",
          "x64",
        );

        const requiredMsvcDlls = [
          "concrt140.dll",
          "msvcp140.dll",
          "msvcp140_1.dll",
          "msvcp140_2.dll",
          "vcruntime140.dll",
          "vcruntime140_1.dll",
        ];

        if (!fs.existsSync(msvcRuntimeSrc)) {
          console.error(
            `[packageAfterCopy] ERROR: MSVC runtime DLLs not found at ${msvcRuntimeSrc}`,
          );
          console.error(
            '[packageAfterCopy] Run: node scripts/prepare-windows-msvc-runtime.mjs',
          );
          throw new Error("Missing MSVC runtime DLLs for Windows build");
        }

        const runtimeFiles = await fsp.readdir(msvcRuntimeSrc);
        const dllFiles = runtimeFiles.filter((f) =>
          f.toLowerCase().endsWith(".dll"),
        );
        const dllSetLower = new Set(dllFiles.map((f) => f.toLowerCase()));
        const missingRequired = requiredMsvcDlls.filter(
          (f) => !dllSetLower.has(f.toLowerCase()),
        );
        if (missingRequired.length > 0) {
          console.error(
            `[packageAfterCopy] ERROR: MSVC runtime DLL set is incomplete: missing ${missingRequired.join(", ")}`,
          );
          throw new Error("Incomplete MSVC runtime DLL set");
        }

        const appRootDir = path.join(resourcesDir, "..");
        const nodeBundleDir = path.join(resourcesDir, "node-bundle");
        const onnxRuntimeDir = path.join(
          resourcesDir,
          "app.asar.unpacked",
          "node_modules",
          "onnxruntime-node",
          "bin",
          "napi-v3",
          "win32",
          "x64",
        );

        const destinations = [
          { label: "app root", dir: appRootDir },
          { label: "node-bundle", dir: nodeBundleDir },
        ];

        if (fs.existsSync(onnxRuntimeDir)) {
          destinations.push({ label: "onnxruntime-node", dir: onnxRuntimeDir });
        } else {
          console.log(
            "[packageAfterCopy] Step 7b-3: onnxruntime-node dir not found, skipping extra copy",
          );
        }

        for (const dest of destinations) {
          await fsp.mkdir(dest.dir, { recursive: true });
          for (const file of dllFiles) {
            await fsp.copyFile(
              path.join(msvcRuntimeSrc, file),
              path.join(dest.dir, file),
            );
          }
          console.log(
            `[packageAfterCopy] Step 7b-3: Copied ${dllFiles.length} MSVC runtime DLLs to ${dest.label}: ${dest.dir}`,
          );
        }
      }

      // Step 7c: Copy MCP servers manually (can't use extraResource - symlinks break codesigning)
      // MCP servers have symlinks in node_modules/.bin and workspace symlinks (microsoft-shared)
      // We copy with dereference:true and then remove .bin directories
      //
      // There are two categories of MCPs:
      // 1. Generated/bundled MCPs: Built via scripts/build-bundled-mcps.mjs, output to resources/mcp-generated/
      //    These are copied as just server.cjs (no node_modules, build, src directories)
      // 2. Hand-written MCPs: Source code lives in resources/mcp/, copied with full directory structure
      //
      // MCPs that have been bundled into single server.cjs files via esbuild.
      // These are copied as just server.cjs (no node_modules, build, src directories).
      // This dramatically reduces file count and size for Windows NSIS builds.
      // Source of truth: scripts/mcp-config.json
      const mcpConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'scripts', 'mcp-config.json'), 'utf8'));
      const BUNDLED_MCPS = mcpConfig.bundledMcps;
      
      // MCPs to exclude entirely from packaging (not needed at runtime)
      // - notion: Unused at runtime; connector-catalog.json points to remote official Notion MCP
      const EXCLUDED_MCPS = new Set(['notion', 'granola']);
      
      // Step 7c-1: Copy generated/bundled MCPs from resources/mcp-generated/ to resourcesDir/mcp-generated/
      const mcpGeneratedSrc = path.join(__dirname, "resources", "mcp-generated");
      const mcpGeneratedDest = path.join(resourcesDir, "mcp-generated");
      if (fs.existsSync(mcpGeneratedSrc)) {
        console.log("[packageAfterCopy] Step 7c-1: Copying generated MCP bundles...");
        console.log(`  Source: ${mcpGeneratedSrc}`);
        console.log(`  Destination: ${mcpGeneratedDest}`);
        
        // Create destination directory
        await fsp.mkdir(mcpGeneratedDest, { recursive: true });
        
        // Copy each bundled MCP's server.cjs
        for (const mcpName of BUNDLED_MCPS) {
          const serverCjsSrc = path.join(mcpGeneratedSrc, mcpName, 'server.cjs');
          const serverCjsDest = path.join(mcpGeneratedDest, mcpName, 'server.cjs');
          
          if (fs.existsSync(serverCjsSrc)) {
            console.log(`  Copying bundled MCP: ${mcpName}/server.cjs`);
            await fsp.mkdir(path.join(mcpGeneratedDest, mcpName), { recursive: true });
            await fsp.copyFile(serverCjsSrc, serverCjsDest);
          } else {
            throw new Error(`Missing bundle for ${mcpName} at ${serverCjsSrc}. Run 'node scripts/build-bundled-mcps.mjs' or 'npm run prebuild' first.`);
          }
        }
        console.log("[packageAfterCopy] Generated MCP bundles copied successfully");
      } else {
        throw new Error(`Generated MCP bundles directory not found at ${mcpGeneratedSrc}. Run 'node scripts/build-bundled-mcps.mjs' or 'npm run prebuild' first.`);
      }
      
      // Step 7c-2: Copy hand-written MCPs from resources/mcp/ to resourcesDir/mcp/
      const mcpSrc = path.join(__dirname, "resources", "mcp");
      const mcpDest = path.join(resourcesDir, "mcp");
      if (fs.existsSync(mcpSrc)) {
        console.log("[packageAfterCopy] Step 7c-2: Copying hand-written MCP servers (with symlink resolution)...");
        console.log(`  Source: ${mcpSrc}`);
        console.log(`  Destination: ${mcpDest}`);
        
        // Create destination directory
        await fsp.mkdir(mcpDest, { recursive: true });
        
        // Copy only non-bundled (hand-written) MCPs with full directory structure
        const mcpServerDirs = await fsp.readdir(mcpSrc);
        for (const server of mcpServerDirs) {
          const serverSrcPath = path.join(mcpSrc, server);
          const serverDestPath = path.join(mcpDest, server);
          const stat = await fsp.stat(serverSrcPath);
          
          if (!stat.isDirectory()) continue;
          
          // Skip excluded MCPs (not needed at runtime)
          if (EXCLUDED_MCPS.has(server)) {
            console.log(`  Skipping excluded MCP: ${server}/`);
            continue;
          }
          
          // Skip bundled MCPs - they are now in resources/mcp-generated/
          if (BUNDLED_MCPS.includes(server)) {
            console.log(`  Skipping bundled MCP (now in mcp-generated/): ${server}/`);
            continue;
          }
          
          // For hand-written MCPs: copy full directory (existing behavior)
          console.log(`  Copying full MCP directory: ${server}/`);
          await copyDir(serverSrcPath, serverDestPath);
        }

        // Remove all .bin directories from MCP server node_modules
        // These contain symlinks to CLI tools that aren't needed at runtime
        // Note: Only hand-written MCPs are in mcpDest now (bundled MCPs are in mcp-generated/)
        const mcpServers = await fsp.readdir(mcpDest);
        let binDirsRemoved = 0;
        for (const server of mcpServers) {
          const serverPath = path.join(mcpDest, server);
          const stat = await fsp.stat(serverPath);
          if (stat.isDirectory()) {
            // Check for .bin in node_modules
            const binDir = path.join(serverPath, "node_modules", ".bin");
            if (fs.existsSync(binDir)) {
              await deleteDir(binDir);
              binDirsRemoved++;
            }
            // Also check nested node_modules (e.g., google-workspace/node_modules/gaxios/node_modules/.bin)
            const nodeModulesPath = path.join(serverPath, "node_modules");
            if (fs.existsSync(nodeModulesPath)) {
              const walkAndRemoveBins = async (dir) => {
                const entries = await fsp.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                  if (entry.isDirectory()) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.name === ".bin") {
                      await deleteDir(fullPath);
                      binDirsRemoved++;
                    } else if (entry.name === "node_modules") {
                      await walkAndRemoveBins(fullPath);
                    }
                  }
                }
              };
              await walkAndRemoveBins(nodeModulesPath);
            }
          }
        }
        console.log(`[packageAfterCopy] Removed ${binDirsRemoved} .bin directories from MCP servers`);

        // Strip unnecessary files from MCP server node_modules
        // Note: Only hand-written MCPs are in mcpDest now (bundled MCPs are in mcp-generated/)
        for (const server of mcpServers) {
          const serverPath = path.join(mcpDest, server);
          const stat = await fsp.stat(serverPath);
          if (stat.isDirectory()) {
            const nodeModulesPath = path.join(serverPath, "node_modules");
            if (fs.existsSync(nodeModulesPath)) {
              const mcpStripResult = await stripUnnecessaryFiles(nodeModulesPath, `mcp/${server}/node_modules`);
              totalFilesRemoved += mcpStripResult.removed;
              totalDirsRemoved += mcpStripResult.dirs;
            }
          }
        }

        // Step 7c-2: Remove unused ESM/browser build directories from MCP servers
        // Packages like @microsoft/microsoft-graph-client ship lib/es/ (ESM), lib/src/ (CJS), lib/browser/
        // Node.js only uses CJS (per package.json "main" field), so lib/es/ is unused at runtime.
        // These directories contain deeply nested paths (160+ chars) that cause Windows Squirrel
        // installer to fail with PathTooLongException when combined with install path (~100 chars).
        // Total can exceed 260 chars, which is Squirrel's hardcoded MAX_PATH limit.
        //
        // IMPORTANT: We only strip from lib/ directories (lib/es, lib/esm, lib/browser).
        // We do NOT strip dist/esm because some packages (uuid, googleapis) use ESM imports
        // that resolve to dist/esm/index.js. Stripping those breaks MCP servers at runtime.
        console.log("[packageAfterCopy] Step 7c-2: Removing unused ESM/browser builds from MCP servers...");
        let esmDirsRemoved = 0;
        // Only strip from lib/ subdirectories, NOT from dist/
        // dist/esm is often needed for ESM imports (e.g., uuid/dist/esm/index.js)
        const esmBuildDirNamesInLib = new Set(["es", "esm", "browser", "umd"]);
        
        const removeUnusedBuildDirs = async (nodeModulesDir) => {
          const entries = await fsp.readdir(nodeModulesDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const fullPath = path.join(nodeModulesDir, entry.name);
            
            // Handle scoped packages (@microsoft, @google-cloud, etc.)
            if (entry.name.startsWith("@")) {
              const scopedEntries = await fsp.readdir(fullPath, { withFileTypes: true });
              for (const scopedEntry of scopedEntries) {
                if (scopedEntry.isDirectory()) {
                  await checkPackageForEsmDirs(path.join(fullPath, scopedEntry.name));
                }
              }
            } else if (entry.name !== ".bin") {
              await checkPackageForEsmDirs(fullPath);
            }
          }
        };
        
        const checkPackageForEsmDirs = async (pkgDir) => {
          // Check for lib/ directory containing es/, esm/, browser/, etc.
          // These are typically alternative builds for different module systems.
          // Node.js uses the main/exports fields which point to CJS in lib/src or similar.
          const libDir = path.join(pkgDir, "lib");
          if (fs.existsSync(libDir)) {
            try {
              const libEntries = await fsp.readdir(libDir, { withFileTypes: true });
              for (const libEntry of libEntries) {
                if (libEntry.isDirectory() && esmBuildDirNamesInLib.has(libEntry.name)) {
                  const esmPath = path.join(libDir, libEntry.name);
                  try {
                    await deleteDir(esmPath);
                    esmDirsRemoved++;
                  } catch (e) {
                    console.warn(`  Warning: Failed to delete ${esmPath}: ${e.message}`);
                  }
                }
              }
            } catch {
              // Ignore errors reading lib directory
            }
          }
          
          // NOTE: We intentionally do NOT strip dist/esm, dist/es directories.
          // Some packages (uuid, googleapis, etc.) use ESM imports that resolve to
          // dist/esm/index.js. Stripping those breaks MCP servers at runtime with:
          // "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../dist/esm/index.js'"
          
          // Recurse into nested node_modules
          const nestedNodeModules = path.join(pkgDir, "node_modules");
          if (fs.existsSync(nestedNodeModules)) {
            await removeUnusedBuildDirs(nestedNodeModules);
          }
        };
        
        for (const server of mcpServers) {
          const serverPath = path.join(mcpDest, server);
          const stat = await fsp.stat(serverPath);
          if (stat.isDirectory()) {
            const nodeModulesPath = path.join(serverPath, "node_modules");
            if (fs.existsSync(nodeModulesPath)) {
              await removeUnusedBuildDirs(nodeModulesPath);
            }
          }
        }
        console.log(`[packageAfterCopy] Removed ${esmDirsRemoved} unused ESM/browser build directories`);

        // Step 7c-3: Hoist deeply nested dependencies to avoid Windows MAX_PATH
        // NOTE: Microsoft MCPs are now bundled (in mcp-generated/), so this section
        // is mostly historical. It remains for any future hand-written MCPs that might
        // have similar nested dependency issues.
        //
        // The original problem: microsoft-* MCPs used a workspace symlink to microsoft-shared,
        // which after dereferencing created paths like:
        //   microsoft-calendar/node_modules/microsoft-shared/node_modules/@microsoft/...
        // This added ~50 extra chars and exceeded Windows 260-char limit.
        // Solution was to hoist dependencies to flatten the path structure.
        console.log("[packageAfterCopy] Step 7c-3: Hoisting nested dependencies to reduce path lengths...");
        let depsHoisted = 0;
        
        for (const server of mcpServers) {
          // Note: microsoft-* MCPs are now bundled and won't be in mcpServers
          if (server.startsWith("microsoft-") && server !== "microsoft-shared") {
            const serverNodeModules = path.join(mcpDest, server, "node_modules");
            const nestedSharedPath = path.join(serverNodeModules, "microsoft-shared");
            const nestedNodeModules = path.join(nestedSharedPath, "node_modules");
            
            if (fs.existsSync(nestedNodeModules)) {
              // Move (hoist) packages from nested node_modules to server's node_modules
              // Only hoist specific problematic packages to minimize risk
              const packagesToHoist = ["@microsoft"]; // Scopes that contain long-path packages
              
              const nestedPackages = await fsp.readdir(nestedNodeModules, { withFileTypes: true });
              for (const pkg of nestedPackages) {
                if (!pkg.isDirectory()) continue;
                if (pkg.name === ".bin") continue; // Skip .bin directory
                
                const srcPath = path.join(nestedNodeModules, pkg.name);
                const destPath = path.join(serverNodeModules, pkg.name);
                
                // Only hoist targeted scopes/packages
                if (!packagesToHoist.includes(pkg.name)) continue;
                
                // Handle scoped packages (@microsoft, etc.)
                if (pkg.name.startsWith("@")) {
                  // It's a scope directory, process packages inside
                  const scopedPackages = await fsp.readdir(srcPath, { withFileTypes: true });
                  for (const scopedPkg of scopedPackages) {
                    if (!scopedPkg.isDirectory()) continue;
                    
                    const scopedSrc = path.join(srcPath, scopedPkg.name);
                    const scopedDest = path.join(destPath, scopedPkg.name);
                    
                    // Only hoist if not already present at destination
                    if (!fs.existsSync(scopedDest)) {
                      await fsp.mkdir(destPath, { recursive: true });
                      try {
                        await fsp.rename(scopedSrc, scopedDest);
                      } catch (renameErr) {
                        // Fallback for cross-device or permission errors
                        if (renameErr.code === "EXDEV" || renameErr.code === "EPERM") {
                          await copyDir(scopedSrc, scopedDest);
                          await deleteDir(scopedSrc);
                        } else {
                          throw renameErr;
                        }
                      }
                      depsHoisted++;
                      console.log(`  Hoisted ${pkg.name}/${scopedPkg.name} from ${server}/node_modules/microsoft-shared/`);
                    } else {
                      // Package already exists at dest - just delete the duplicate
                      await deleteDir(scopedSrc);
                      console.log(`  Removed duplicate ${pkg.name}/${scopedPkg.name} (already hoisted)`);
                    }
                  }
                  // Clean up empty scope directory
                  try {
                    const remaining = await fsp.readdir(srcPath);
                    if (remaining.length === 0) {
                      await fsp.rmdir(srcPath);
                    }
                  } catch { /* ignore */ }
                } else {
                  // Regular package - hoist directly
                  if (!fs.existsSync(destPath)) {
                    try {
                      await fsp.rename(srcPath, destPath);
                    } catch (renameErr) {
                      if (renameErr.code === "EXDEV" || renameErr.code === "EPERM") {
                        await copyDir(srcPath, destPath);
                        await deleteDir(srcPath);
                      } else {
                        throw renameErr;
                      }
                    }
                    depsHoisted++;
                    console.log(`  Hoisted ${pkg.name} from ${server}/node_modules/microsoft-shared/`);
                  } else {
                    // Package already exists - just delete duplicate
                    await deleteDir(srcPath);
                    console.log(`  Removed duplicate ${pkg.name} (already hoisted)`);
                  }
                }
              }
              
              // Only delete nested node_modules if it's now empty
              try {
                const remaining = await fsp.readdir(nestedNodeModules);
                if (remaining.length === 0 || (remaining.length === 1 && remaining[0] === ".bin")) {
                  await deleteDir(nestedNodeModules);
                }
              } catch {
                // Ignore - directory may already be gone
              }
            }
          }
        }
        console.log(`[packageAfterCopy] Hoisted ${depsHoisted} nested dependencies`);

        // Step 7c-4: Path length enforcement - scan for any remaining paths > 150 chars
        // and warn/fail if Windows build would exceed MAX_PATH (260 chars)
        // Windows install adds ~110 chars: C:\Users\<user>\AppData\Local\MindstoneRebelBeta\app-X.X.XXXX\
        const MAX_RELATIVE_PATH = 145; // 260 - 110 - 5 (safety margin)
        console.log("[packageAfterCopy] Step 7c-4: Scanning MCP paths for Windows MAX_PATH compliance...");
        let pathViolations = [];
        
        const scanForLongPaths = async (dir, baseDir) => {
          if (!fs.existsSync(dir)) return;
          const entries = await fsp.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(baseDir, fullPath);
            
            if (relativePath.length > MAX_RELATIVE_PATH) {
              pathViolations.push({ path: relativePath, length: relativePath.length });
            }
            
            if (entry.isDirectory()) {
              await scanForLongPaths(fullPath, baseDir);
            }
          }
        };
        
        // Scan both hand-written MCPs (mcp/) and generated MCPs (mcp-generated/)
        await scanForLongPaths(mcpDest, resourcesDir);
        await scanForLongPaths(mcpGeneratedDest, resourcesDir);
        
        if (pathViolations.length > 0) {
          console.warn(`[packageAfterCopy] WARNING: Found ${pathViolations.length} paths exceeding ${MAX_RELATIVE_PATH} chars:`);
          pathViolations.sort((a, b) => b.length - a.length);
          pathViolations.slice(0, 10).forEach(v => {
            console.warn(`  ${v.length} chars: ${v.path}`);
          });
          if (pathViolations.length > 10) {
            console.warn(`  ... and ${pathViolations.length - 10} more`);
          }
          
          // On Windows, this is a fatal error - the installer WILL fail
          if (platform === "win32") {
            console.error("[packageAfterCopy] FATAL: Windows MAX_PATH will be exceeded. Fix the path lengths before building.");
            // Don't throw - let the build continue so we can see the full diagnostic output
            // The Squirrel step will fail with a clearer error
          }
        } else {
          console.log(`[packageAfterCopy] All MCP paths are under ${MAX_RELATIVE_PATH} chars (Windows MAX_PATH safe)`);
        }

        console.log("[packageAfterCopy] MCP servers copied and cleaned successfully");
      } else {
        console.log("[packageAfterCopy] WARNING: resources/mcp not found, skipping");
      }

      // Step 7d: Copy git-bundle manually and handle symlinks (macOS codesigning fix)
      // git-bundle contains 141 symlinks in libexec/git-core/ (git-add -> git, git-commit -> git, etc.)
      // These symlinks break macOS codesigning with "code has no resources but signature indicates they must be present"
      // Git's multicall architecture means the symlinks aren't needed - we call `git add`, not `./git-add`
      // GIT_EXEC_PATH is set at runtime so git can find helper scripts without the symlinks
      // NOTE: We intentionally do NOT bundle git on macOS to avoid adding ~150MB to the app.
      // The runtime uses system git on macOS (see setupGitEnvironment()).
      const shouldCopyGitBundle = hasGitBundle && platform !== "darwin";

      if (shouldCopyGitBundle) {
        console.log("[packageAfterCopy] Step 7d: Copying git-bundle...");
        const gitBundleDest = path.join(resourcesDir, "git-bundle");
        console.log(`  Source: ${gitBundlePath}`);
        console.log(`  Destination: ${gitBundleDest}`);
        
        // Copy git-bundle without dereferencing (faster, smaller)
        await fsp.cp(gitBundlePath, gitBundleDest, { recursive: true });
        
        // On macOS only: Remove/convert symlinks to fix codesigning
        // Windows/Linux don't have this issue and symlinks work fine there
        if (platform === "darwin") {
          console.log("[packageAfterCopy] Removing symlinks for macOS codesigning...");
          const gitCorePath = path.join(gitBundleDest, "libexec", "git-core");
          if (fs.existsSync(gitCorePath)) {
            const entries = await fsp.readdir(gitCorePath, { withFileTypes: true });
            let symlinksRemoved = 0;
            let symlinksConverted = 0;
            for (const entry of entries) {
              if (entry.isSymbolicLink()) {
                const linkPath = path.join(gitCorePath, entry.name);
                const target = await fsp.readlink(linkPath);
                const targetBasename = path.basename(target);
                
                if (targetBasename === "git") {
                  // Remove convenience symlinks (git-add -> git, git-commit -> git)
                  // These aren't needed - git's multicall handles them
                  await fsp.unlink(linkPath);
                  symlinksRemoved++;
                } else {
                  // Convert essential helper symlinks to real files (e.g., git-remote-https -> git-remote-http)
                  // This ensures zero symlinks in the bundle for reliable codesigning
                  const resolvedTarget = path.resolve(gitCorePath, target);
                  if (fs.existsSync(resolvedTarget)) {
                    await fsp.unlink(linkPath);
                    await fsp.copyFile(resolvedTarget, linkPath);
                    // CRITICAL: Preserve executable permissions after copy
                    // fs.copyFile does NOT preserve file mode, which breaks codesigning
                    // on macOS arm64 runners where is-binary-file skips non-executable files
                    const stats = await fsp.stat(resolvedTarget);
                    await fsp.chmod(linkPath, stats.mode);
                    symlinksConverted++;
                  } else {
                    // Target doesn't exist, just remove the broken symlink
                    await fsp.unlink(linkPath);
                    symlinksRemoved++;
                  }
                }
              }
            }
            console.log(`[packageAfterCopy] Removed ${symlinksRemoved} convenience symlinks, converted ${symlinksConverted} helper symlinks to files`);
          }
        }
        
        console.log("[packageAfterCopy] git-bundle copied and cleaned successfully");
      } else if (hasGitBundle && platform === "darwin") {
        console.log(
          "[packageAfterCopy] Skipping git-bundle on macOS (using system git)",
        );
      }

      // Log file stripping summary
      const stripDuration = ((Date.now() - stripStart) / 1000).toFixed(1);
      console.log(`[packageAfterCopy] File stripping completed in ${stripDuration}s`);
      console.log(`[packageAfterCopy] Total files removed: ${totalFilesRemoved}`);
      console.log(`[packageAfterCopy] Total directories removed: ${totalDirsRemoved}`);

      // Step 7d: Remove native module build intermediate directories
      // Native modules compiled by node-gyp/electron-rebuild contain build/Release/obj/
      // directories with MSBuild intermediates (.tlog, .obj, .lastbuildstate, .pdb files).
      // Only the compiled .node binary in build/Release/ is needed at runtime.
      // This reduces path lengths for Windows MAX_PATH compliance.
      console.log("[packageAfterCopy] Step 7d: Removing native module build intermediates...");
      let nativeBuildDirsRemoved = 0;
      
      async function removeNativeBuildIntermediates(nodeModulesDir) {
        if (!fs.existsSync(nodeModulesDir)) return;
        
        const walkForBuildDirs = async (dir) => {
          let entries;
          try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
          } catch (e) {
            // Skip directories we can't read (permissions, path length issues, etc.)
            return;
          }
          
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const fullPath = path.join(dir, entry.name);
            
            // Look for build/Release/obj or build/Debug/obj patterns
            if (entry.name === "build") {
              for (const buildType of ["Release", "Debug"]) {
                const objDir = path.join(fullPath, buildType, "obj");
                if (fs.existsSync(objDir)) {
                  try {
                    await deleteDir(objDir);
                    nativeBuildDirsRemoved++;
                    console.log(`  Removed: ${path.relative(nodeModulesDir, objDir)}`);
                  } catch (e) {
                    console.warn(`  Warning: Failed to remove ${objDir}: ${e.message}`);
                  }
                }
              }
            }
            
            // Recurse into subdirectories (but not into build directories)
            if (entry.name !== "build") {
              await walkForBuildDirs(fullPath);
            }
          }
        };
        
        await walkForBuildDirs(nodeModulesDir);
      }
      
      await removeNativeBuildIntermediates(unpackedNodeModules);
      console.log(`[packageAfterCopy] Removed ${nativeBuildDirsRemoved} native build intermediate directories`);

      // Step 8: Log longest paths for Windows path length diagnostics
      console.log("[packageAfterCopy] Step 8: Path length diagnostics...");
      await logLongestPaths(
        unpackedNodeModules,
        "app.asar.unpacked/node_modules",
        resourcesDir,
      );
      await logLongestPaths(
        superMcpNodeModulesDest,
        "super-mcp/node_modules",
        resourcesDir,
      );

      // Step 9: Pre-signing diagnostics (macOS only)
      // Log potential issues that could cause codesign failures
      if (platform === "darwin") {
        console.log("[packageAfterCopy] Step 9: Pre-signing diagnostics...");
        
        // Check for any remaining symlinks in the bundle
        const { execSync } = require("child_process");
        try {
          const symlinks = execSync(`find "${resourcesDir}" -type l 2>/dev/null || true`, { encoding: "utf8" }).trim();
          if (symlinks) {
            const symlinkList = symlinks.split("\n").filter(Boolean);
            console.warn(`[packageAfterCopy] WARNING: Found ${symlinkList.length} symlinks in bundle:`);
            symlinkList.slice(0, 10).forEach(s => console.warn(`  - ${s}`));
            if (symlinkList.length > 10) {
              console.warn(`  ... and ${symlinkList.length - 10} more`);
            }
          } else {
            console.log("[packageAfterCopy] No symlinks found in bundle (good)");
          }
        } catch (e) {
          console.log("[packageAfterCopy] Could not check for symlinks:", e.message);
        }
        
        // Check for zero-byte files that could break signing
        try {
          const emptyFiles = execSync(`find "${resourcesDir}" -type f -size 0 2>/dev/null || true`, { encoding: "utf8" }).trim();
          if (emptyFiles) {
            const emptyList = emptyFiles.split("\n").filter(Boolean);
            // Filter out expected empty files
            const unexpectedEmpty = emptyList.filter(f => !f.endsWith(".gitkeep") && !f.endsWith(".keep"));
            if (unexpectedEmpty.length > 0) {
              console.warn(`[packageAfterCopy] WARNING: Found ${unexpectedEmpty.length} zero-byte files:`);
              unexpectedEmpty.slice(0, 5).forEach(f => console.warn(`  - ${f}`));
            }
          }
        } catch (e) {
          // Ignore - diagnostic only
        }
        
        // Count total files for EMFILE risk assessment
        try {
          const fileCount = execSync(`find "${resourcesDir}" -type f 2>/dev/null | wc -l`, { encoding: "utf8" }).trim();
          console.log(`[packageAfterCopy] Total files in bundle: ${fileCount}`);
        } catch (e) {
          // Ignore - diagnostic only
        }
      }

      // Step 10: Generate app-update.yml for Windows auto-updates
      // electron-builder with --prepackaged doesn't generate this file, so we must create it
      // This ensures the runtime uses the correct update URL (supports UPDATE_FEED_PATH for isolated testing)
      if (platform === "win32") {
        console.log("[packageAfterCopy] Step 10: Generating app-update.yml for Windows auto-updates...");
        const appUpdateBasePath = process.env.UPDATE_FEED_PATH || (isBeta ? "updates-beta" : "updates");
        const appUpdateUrl = `https://storage.googleapis.com/mindstone-rebel/${appUpdateBasePath}/win32/x64/`;
        const appUpdateYml = `provider: generic
url: ${appUpdateUrl}
channel: ${isBeta ? "beta" : "latest"}
useMultipleRangeRequest: false
updaterCacheDirName: ${internalName}
`;
        const appUpdateYmlPath = path.join(resourcesDir, "app-update.yml");
        await fsp.writeFile(appUpdateYmlPath, appUpdateYml, "utf8");
        console.log(`[packageAfterCopy] Generated app-update.yml with URL: ${appUpdateUrl}`);
      }

      console.log("[packageAfterCopy] All steps complete");
    },

    // NOTE: Re-signing of node-bundle binaries is now handled by
    // electron-osx-sign via the optionsForFile callback in osxSignConfig.
    // This ensures all executables get our entitlements with allow-jit and
    // allow-unsigned-executable-memory, which are required for V8 JIT on Intel Macs.
  },

  makers,

  plugins: [
    {
      name: "@electron-forge/plugin-vite",
      config: {
        // Main process build configuration
        build: [
          {
            // Main process entry
            entry: "src/main/bootstrap.ts",
            config: "vite.main.config.mjs",
            target: "main",
          },
          // Note: embeddingWorker is built separately via scripts/build-worker.mjs
          // in the generateAssets hook because electron-vite doesn't support
          // multiple entry points for Worker Threads properly
          {
            // Preload script - use full path so [name] becomes unique
            entry: "src/preload/index.ts",
            config: "vite.preload.config.mjs",
            target: "preload",
          },
        ],

        // Renderer process configuration
        renderer: [
          {
            name: "main_window",
            config: "vite.renderer.config.mjs",
            entry: "src/renderer/index.html",
          },
        ],

        // Prevent memory issues with native modules
        concurrent: 2,
      },
    },
  ],
};
