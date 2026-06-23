/**
 * electron-builder configuration for Windows NSIS installer
 * 
 * IMPORTANT: This config is ONLY used for creating Windows NSIS installers.
 * The app is packaged by Electron Forge (`electron-forge package`), then
 * electron-builder creates the NSIS installer using `--prepackaged`.
 * 
 * macOS/Linux continue to use Electron Forge makers exclusively.
 * 
 * Usage:
 *   npm run build:windows:nsis  # Full build pipeline
 *   
 * Or manually:
 *   electron-forge package --platform win32 --arch x64
 *   electron-builder --win --prepackaged out/rebel-app-win32-x64 --config electron-builder.cjs
 */

// =============================================================================
// BUILD CHANNEL CONFIGURATION
// =============================================================================
// Reuse the same BUILD_CHANNEL logic as forge.config.cjs for consistency
const buildChannel = process.env.BUILD_CHANNEL || "stable";
const isBeta = buildChannel === "beta";

const appName = isBeta ? "Mindstone Rebel Beta" : "Mindstone Rebel";
const appId = isBeta ? "com.mindstone.rebel.beta" : "com.mindstone.rebel";
// Allow UPDATE_FEED_PATH override for isolated testing (e.g., nsis-test branch)
// NOTE: Update URL pattern is defined in multiple places - keep in sync:
//   - electron-builder.cjs (here) - build-time publish config
//   - forge.config.cjs - packageAfterCopy Step 10 app-update.yml generation
//   - scripts/build-windows-nsis.mjs - local build app-update.yml generation
//   - src/main/services/autoUpdateService.ts - runtime fallback (2 places: Windows & macOS)
//   - src/main/services/health/checks/updates.ts - health check diagnostics
const updateBasePath = process.env.UPDATE_FEED_PATH || (isBeta ? "updates-beta" : "updates");

// Squirrel.Windows installer names (used for upgrade compatibility)
// CRITICAL: Must match existing Squirrel installer names for seamless migration
const squirrelInstallerName = isBeta ? "MindstoneRebelBeta" : "rebel-app";

// GCS update feed URL (electron-updater reads latest.yml from here)
const updateUrl = `https://storage.googleapis.com/mindstone-rebel/${updateBasePath}/win32/x64`;

console.log(`[electron-builder] Build channel: ${buildChannel}`);
console.log(`[electron-builder] App name: ${appName}`);
console.log(`[electron-builder] App ID: ${appId}`);
console.log(`[electron-builder] Update URL: ${updateUrl}`);

module.exports = {
  // Don't use electron-builder's packaging - we use Forge's output
  // The --prepackaged flag tells electron-builder to skip packaging
  buildDependenciesFromSource: false,
  npmRebuild: false,

  // Basic app metadata
  appId: appId,
  productName: appName,
  copyright: `© ${new Date().getFullYear()} Mindstone Learning Limited. All rights reserved.`,

  // OS protocol handlers (Windows NSIS installs from prepackaged Forge output)
  protocols: [
    { name: "Mindstone Rebel OAuth", schemes: ["mindstone"] },
    { name: "Mindstone Rebel Navigation", schemes: ["rebel"] },
  ],

  // Output directory for installers
  directories: {
    output: "release/nsis",
  },

  // =============================================================================
  // NSIS INSTALLER CONFIGURATION
  // =============================================================================
  win: {
    target: [
      {
        target: "nsis",
        arch: ["x64"],
      },
    ],
    icon: isBeta ? "build/icon-beta.ico" : "build/icon.ico",
    // Preserve the executable name from the prepackaged Forge output
    // Without this, electron-builder may rename to "Mindstone Rebel.exe" regardless of channel
    executableName: appName,
    // Azure Trusted Signing for uninstaller (and other executables)
    // Requires AZURE_CLIENT_ID and related env vars from CI
    // This enables electron-builder's two-pass uninstaller signing
    ...(process.env.AZURE_CLIENT_ID ? {
      azureSignOptions: {
        // publisherName must match the CN of the Azure Trusted Signing certificate
        publisherName: "Mindstone Learning Limited",
        endpoint: process.env.AZURE_CODE_SIGNING_ENDPOINT,
        codeSigningAccountName: process.env.AZURE_CODE_SIGNING_ACCOUNT,
        certificateProfileName: process.env.AZURE_CERT_PROFILE_NAME,
      },
      signAndEditExecutable: true,
    } : {}),
  },

  nsis: {
    // One-click installer - no wizard pages, just install and launch
    oneClick: true,
    
    // Per-user install (no admin required)
    // Installs to: %LocalAppData%\Programs\mindstone-rebel\ (stable)
    //              %LocalAppData%\Programs\mindstone-rebel-beta\ (beta)
    // Path derives from sanitizedName (package.json name / extraMetadata name)
    perMachine: false,
    
    // Use custom NSIS script for compression settings
    include: "build/nsis-installer.nsh",
    
    // Use ZIP instead of 7z for app payload extraction
    // - ZIP extracts directly to $INSTDIR (single write pass)
    // - 7z extracts to temp then CopyFiles (double write pass)
    // Trade-off: Potentially larger installer (delta varies with compression setting),
    // but significantly faster install due to reduced file I/O and Defender scanning.
    // Note: ZIP path has less robust locked-file handling than 7z, but this is
    // acceptable for our per-user one-click installer where app is closed during install.
    useZip: true,
    
    // Disable differential package mode to allow useZip to work
    // (electron-builder forces 7z when differentialPackage is enabled)
    // We don't use differential updates anyway (full downloads only)
    differentialPackage: false,
    
    // Allow user to choose install directory in one-click mode
    // false = always use default per-user location (better for auto-updates)
    allowToChangeInstallationDirectory: false,
    
    // Use GUID from existing Squirrel installer for upgrade compatibility
    // This allows NSIS to detect and cleanly upgrade from Squirrel installs
    // The GUID format is standard for Windows installers
    // NOTE: Squirrel doesn't use a traditional GUID, but we need consistent naming
    // for Windows Add/Remove Programs registry
    installerIcon: isBeta ? "build/icon-beta.ico" : "build/icon.ico",
    uninstallerIcon: isBeta ? "build/icon-beta.ico" : "build/icon.ico",
    
    // Installer filenames must match what CI expects
    // Pattern: rebel-app-Setup-{version}.exe or MindstoneRebelBeta-Setup-{version}.exe
    artifactName: `${squirrelInstallerName}-Setup-\${version}.exe`,
    
    // Desktop and Start Menu shortcuts
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: appName,
    
    // Run app after install
    runAfterFinish: true,
    
    // Don't delete user data on uninstall (preserves settings, conversations, etc.)
    deleteAppDataOnUninstall: false,
    
    // Display name in Windows "Apps & features" - matches Squirrel behavior
    // Without this, electron-builder appends the version number
    uninstallDisplayName: appName,
    
    // Loading animation while installing
    installerSidebar: undefined, // Use default NSIS banner
    
    // MUI (Modern User Interface) settings
    // installerHeader: "build/nsis-header.bmp", // TODO: Add custom header if desired
    // installerHeaderIcon: "build/icon.ico",
    
    // License and EULA (optional)
    // license: "LICENSE",
  },

  // =============================================================================
  // PUBLISH/UPDATE CONFIGURATION
  // =============================================================================
  publish: {
    provider: "generic",
    url: updateUrl,
    // Channel for update discovery (stable or beta)
    channel: isBeta ? "beta" : "latest",
  },

  // =============================================================================
  // DIFFERENTIAL UPDATE SETTINGS
  // =============================================================================
  // DISABLED: Differential updates (blockmap files) are problematic:
  // 1. Increases build time significantly
  // 2. Requires maintaining blockmap files on update server
  // 3. Can cause partial update failures that are hard to diagnose
  // 4. Full downloads are fast enough for our ~150MB app
  //
  // To enable in future: Remove this setting (differentialDownload defaults to true)
  // and ensure blockmaps are uploaded alongside installers
  generateUpdatesFilesForAllChannels: false,
  
  // Don't generate blockmap files (saves build time, forces full downloads)
  // electron-builder will still generate latest.yml for electron-updater
  
  // Compression settings
  // "store" = no compression, fastest build & install, larger file (~850MB+)
  // "normal" = balanced ZIP Deflate (level 7), moderate build & install (~15-30s)
  // "maximum" = best compression, slowest build
  compression: "normal",

  // =============================================================================
  // FILES CONFIGURATION
  // =============================================================================
  // When using --prepackaged, electron-builder doesn't need files config
  // The packaged app from Forge is used as-is
  // These settings only apply if building without --prepackaged (not our workflow)
  files: [
    "!node_modules/**/*",
  ],
  
  // Extra resources are already copied by Forge's packageAfterCopy hook
  // No need to specify them here when using --prepackaged

  // =============================================================================
  // BETA/STABLE INSTALL PATH SEPARATION
  // =============================================================================
  // Override package name for beta builds to get separate NSIS install directory.
  // With oneClick: true + perMachine: false, NSIS uses sanitizedName (from package.json name)
  // as the install directory. Without this, both channels install to:
  //   %LocalAppData%\Programs\mindstone-rebel\
  // With this fix:
  //   Stable: %LocalAppData%\Programs\mindstone-rebel\
  //   Beta:   %LocalAppData%\Programs\mindstone-rebel-beta\
  extraMetadata: isBeta ? { name: "mindstone-rebel-beta" } : undefined,
};
