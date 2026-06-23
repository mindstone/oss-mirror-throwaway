#!/usr/bin/env node

/**
 * Bundle Git distribution for the Electron app.
 * 
 * Platform-specific approach:
 * - Windows: PortableGit from git-for-windows (includes bash.exe (was required by removed Claude Agent SDK; may no longer be needed))
 * - macOS/Linux: dugite-native (minimal git, bash is native on these platforms)
 */

import { createWriteStream, existsSync, mkdirSync, rmSync, createReadStream, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import https from 'https';
import { pipeline } from 'stream/promises';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');
const bundleDir = join(projectRoot, 'resources', 'git-bundle');

// Allow CI to override target architecture
const targetArch = process.env.BUNDLE_GIT_ARCH || process.arch;

// ============================================================================
// Windows: PortableGit from git-for-windows (includes bash.exe)
// ============================================================================
const PORTABLE_GIT_VERSION = '2.52.0';
const PORTABLE_GIT_RELEASE = `v${PORTABLE_GIT_VERSION}.windows.1`;

const PORTABLE_GIT_ASSETS = {
  'x64': {
    name: `PortableGit-${PORTABLE_GIT_VERSION}-64-bit.7z.exe`,
    checksum: '1dc4046dcfb138f62aa04a46b5529adc8abed5033b2af29bb60b66872a836cf8',
  },
  'arm64': {
    name: `PortableGit-${PORTABLE_GIT_VERSION}-arm64.7z.exe`,
    checksum: 'bdc2884b321152225498fadc97cad68c244e047310ea686e4fe18ad7257e5b72',
  },
};

// ============================================================================
// macOS/Linux: dugite-native (minimal git, bash is native)
// ============================================================================
const DUGITE_VERSION = 'v2.47.3-1';
const DUGITE_GIT_VERSION = '2.47.3';
const DUGITE_COMMIT = 'b6d6cfa';

const DUGITE_ASSETS = {
  'darwin-x64': {
    name: `dugite-native-v${DUGITE_GIT_VERSION}-${DUGITE_COMMIT}-macOS-x64.tar.gz`,
    checksum: 'c85f72432af33d621c9a51b0b1a3047f8f11873c16f765d83d916b8a2c47b0d6',
  },
  'darwin-arm64': {
    name: `dugite-native-v${DUGITE_GIT_VERSION}-${DUGITE_COMMIT}-macOS-arm64.tar.gz`,
    checksum: '8fcc58fe84b05af6972cd2d7c62d81abd713778a5dfc20dd0849fd649866001c',
  },
  'linux-x64': {
    name: `dugite-native-v${DUGITE_GIT_VERSION}-${DUGITE_COMMIT}-ubuntu-x64.tar.gz`,
    checksum: 'a6cd111dd8d82a26b521d5bcaf28631d5e335f516aa8ec0a993acbd7229bdd08',
  },
  'linux-arm64': {
    name: `dugite-native-v${DUGITE_GIT_VERSION}-${DUGITE_COMMIT}-ubuntu-arm64.tar.gz`,
    checksum: '51765f4bbda12e55d82410099503baa25be1dcff746a812d3e11894f5687b2d8',
  },
};

// ============================================================================
// Shared utilities
// ============================================================================

async function download(url, destination) {
  console.log(`⬇️  Downloading ${url}`);
  return new Promise((resolve, reject) => {
    const makeRequest = (requestUrl) => {
      https.get(requestUrl, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          makeRequest(response.headers.location);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download (HTTP ${response.statusCode})`));
          return;
        }
        const fileStream = createWriteStream(destination);
        pipeline(response, fileStream).then(resolve).catch(reject);
      }).on('error', reject);
    };
    makeRequest(url);
  });
}

async function verifySha256(filePath, expected) {
  console.log('🔍 Verifying SHA256 checksum...');
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => {
      const actual = hash.digest('hex');
      if (actual !== expected) {
        reject(new Error(`SHA256 mismatch!\n  Expected: ${expected}\n  Got:      ${actual}`));
      } else {
        console.log('   Checksum verified ✓');
        resolve();
      }
    });
    stream.on('error', reject);
  });
}

function cleanAndCreateDir(dir) {
  if (existsSync(dir)) {
    console.log('🧹 Cleaning existing bundle...');
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
}

// ============================================================================
// Windows: PortableGit pruning (AV mitigation)
// ============================================================================

/**
 * Windows Git blocklist - files/directories to REMOVE
 * These are server-side utilities, GUI tools, and documentation that:
 * 1. Trigger AV heuristics (daemon, server utilities)
 * 2. Are unused by the app (GUI tools, documentation)
 * Using blocklist (not allowlist) to avoid breaking Git dispatch/bash operations
 */
const WINDOWS_GIT_BLOCKLIST = {
  // High-risk server executables (commonly flagged by AV)
  executables: [
    'git-daemon.exe',           // Network daemon - high AV suspicion
    'git-upload-pack.exe',      // Git server - not needed for client
    'git-receive-pack.exe',     // Git server - not needed (breaks local bare repo pushes)
    'git-upload-archive.exe',   // Git server utility
    'git-shell.exe',            // Restricted shell for Git servers
    'git-http-backend.exe',     // CGI for Git HTTP servers
    'scalar.exe',               // Repo management - not needed
    'scalar.dll',               // Scalar support library
    // Perl/Python (not needed, can trigger heuristics)
    'perl.exe',
    'python.exe',
    'python3.exe',
    'wish.exe',                 // Tcl/Tk GUI
    'tclsh.exe',                // Tcl interpreter
  ],
  // Entire directories to remove
  directories: [
    'mingw64/share/doc',        // Documentation
    'mingw64/share/git-gui',    // GUI tool
    'mingw64/share/gitk',       // GUI tool
    'mingw64/share/gitweb',     // Web interface
    'usr/share/doc',            // MSYS2 documentation
    'usr/share/man',            // Man pages
    'usr/share/perl5',          // Perl modules
    'usr/lib/perl5',            // Perl libraries
    'mingw64/lib/perl5',        // More Perl
    'mingw64/share/perl5',      // More Perl
  ],
};

/**
 * Prune high-risk/unused files from Windows Git bundle to reduce AV false positives.
 * Uses blocklist approach - removes only known-bad files, keeps everything else.
 */
function pruneWindowsGitBundle(bundlePath) {
  console.log('🔪 Pruning high-risk/unused Git files (AV mitigation)...');
  let removedFiles = 0;
  let removedDirs = 0;

  // Remove blocklisted executables from multiple locations
  const exeDirs = [
    'mingw64/bin',
    'mingw64/libexec/git-core',
    'usr/bin',
  ];

  for (const relDir of exeDirs) {
    const dir = join(bundlePath, relDir);
    if (!existsSync(dir)) continue;

    for (const exe of WINDOWS_GIT_BLOCKLIST.executables) {
      const filePath = join(dir, exe);
      if (existsSync(filePath)) {
        try {
          unlinkSync(filePath);
          console.log(`   Removed: ${relDir}/${exe}`);
          removedFiles++;
        } catch (err) {
          console.warn(`   Warning: Could not remove ${relDir}/${exe}: ${err.message}`);
        }
      }
    }
  }

  // Remove blocklisted directories
  for (const relDir of WINDOWS_GIT_BLOCKLIST.directories) {
    const dir = join(bundlePath, relDir);
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
        console.log(`   Removed directory: ${relDir}`);
        removedDirs++;
      } catch (err) {
        console.warn(`   Warning: Could not remove ${relDir}: ${err.message}`);
      }
    }
  }

  console.log(`   ✓ Pruned ${removedFiles} files, ${removedDirs} directories`);
}

// ============================================================================
// Windows: PortableGit extraction and verification
// ============================================================================

function extractPortableGit(archivePath, destinationDir) {
  console.log('📦 Extracting PortableGit...');

  // Clean up destination if it exists
  if (existsSync(destinationDir)) {
    console.log('🧹 Cleaning existing bundle...');
    rmSync(destinationDir, { recursive: true, force: true });
  }
  mkdirSync(destinationDir, { recursive: true });

  // PortableGit .7z.exe is a self-extracting 7z archive
  // Try 7z first (available on GitHub Actions Windows runners)
  try {
    execSync(
      `7z x "${archivePath}" -o"${destinationDir}" -y`,
      { stdio: 'inherit', timeout: 300000 }
    );
    return;
  } catch (error) {
    // 7z not available, try self-extractor
  }

  // Fall back to running the self-extractor
  // -y: answer yes to all prompts
  // -gm2: silent mode (no GUI)
  // -InstallPath: where to extract
  try {
    execSync(
      `"${archivePath}" -y -gm2 -InstallPath="${destinationDir}"`,
      { stdio: 'inherit', timeout: 300000 }
    );
  } catch (error) {
    throw new Error(`Failed to extract PortableGit: ${error.message}`);
  }
}

function verifyWindowsBundle(bundleDir) {
  console.log('🔍 Verifying Windows bundle...');
  
  // Check bash.exe (historically required by removed Claude Agent SDK)
  const bashPath = join(bundleDir, 'usr', 'bin', 'bash.exe');
  if (!existsSync(bashPath)) {
    throw new Error(`bash.exe not found at expected location: ${bashPath}`);
  }
  
  // Test that bash works
  try {
    const output = execSync(`"${bashPath}" --version`, { encoding: 'utf8' });
    console.log(`   bash: ${output.split('\n')[0]}`);
  } catch (error) {
    throw new Error(`bash.exe exists but failed to run: ${error.message}`);
  }

  // Check git.exe
  const gitPath = join(bundleDir, 'cmd', 'git.exe');
  if (!existsSync(gitPath)) {
    throw new Error(`git.exe not found at expected location: ${gitPath}`);
  }
  
  try {
    const output = execSync(`"${gitPath}" --version`, { encoding: 'utf8' });
    console.log(`   git: ${output.trim()}`);
  } catch (error) {
    throw new Error(`git.exe exists but failed to run: ${error.message}`);
  }

  return { bashPath, gitPath };
}

async function bundleWindows() {
  const asset = PORTABLE_GIT_ASSETS[targetArch];
  if (!asset) {
    console.log(`ℹ️  No PortableGit available for Windows ${targetArch}, skipping`);
    process.exit(0);
  }

  const downloadUrl = `https://github.com/git-for-windows/git/releases/download/${PORTABLE_GIT_RELEASE}/${asset.name}`;

  console.log('🚀 Bundling Git for Windows (PortableGit)...');
  console.log(`   Version: ${PORTABLE_GIT_VERSION}`);
  console.log(`   Architecture: ${targetArch}`);
  console.log(`   Target: ${bundleDir}`);

  const tempDir = join(tmpdir(), `git-bundle-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  const archivePath = join(tempDir, asset.name);

  try {
    await download(downloadUrl, archivePath);
    await verifySha256(archivePath, asset.checksum);
    extractPortableGit(archivePath, bundleDir);
    pruneWindowsGitBundle(bundleDir);
    const { bashPath } = verifyWindowsBundle(bundleDir);

    console.log('✅ Git bundle created successfully!');
    console.log(`   bash.exe: ${bashPath}`);
  } finally {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

// ============================================================================
// macOS/Linux: dugite-native extraction and verification
// ============================================================================

async function extractTarGz(archivePath, destinationDir) {
  console.log('📦 Extracting archive...');
  cleanAndCreateDir(destinationDir);

  // Use tar module for cross-platform extraction
  const { extract } = await import('tar');
  const { createGunzip } = await import('zlib');
  
  await new Promise((resolve, reject) => {
    createReadStream(archivePath)
      .pipe(createGunzip())
      .pipe(extract({ cwd: destinationDir }))
      .on('finish', resolve)
      .on('error', reject);
  });
}

function verifyUnixBundle(bundleDir) {
  console.log('🔍 Verifying Unix bundle...');
  
  const gitPath = join(bundleDir, 'bin', 'git');
  if (!existsSync(gitPath)) {
    throw new Error(`git not found at expected location: ${gitPath}`);
  }

  try {
    const output = execSync(`"${gitPath}" --version`, { encoding: 'utf8' });
    console.log(`   git: ${output.trim()}`);
  } catch (error) {
    throw new Error(`git exists but failed to run: ${error.message}`);
  }

  return { gitPath };
}

async function bundleUnix() {
  const platformKey = `${process.platform}-${targetArch}`;
  const asset = DUGITE_ASSETS[platformKey];
  
  if (!asset) {
    console.log(`ℹ️  No dugite-native available for ${platformKey}, skipping`);
    process.exit(0);
  }

  const downloadUrl = `https://github.com/desktop/dugite-native/releases/download/${DUGITE_VERSION}/${asset.name}`;

  console.log('🚀 Bundling Git (dugite-native)...');
  console.log(`   Platform: ${process.platform}`);
  console.log(`   Architecture: ${targetArch}`);
  console.log(`   Git version: ${DUGITE_GIT_VERSION}`);
  console.log(`   Target: ${bundleDir}`);

  const tempDir = join(tmpdir(), `git-bundle-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  const archivePath = join(tempDir, asset.name);

  try {
    await download(downloadUrl, archivePath);
    await verifySha256(archivePath, asset.checksum);
    await extractTarGz(archivePath, bundleDir);
    const { gitPath } = verifyUnixBundle(bundleDir);

    console.log('✅ Git bundle created successfully!');
    console.log(`   git: ${gitPath}`);
  } finally {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  if (process.platform === 'win32') {
    await bundleWindows();
  } else {
    await bundleUnix();
  }
}

main().catch((error) => {
  console.error('❌ Failed to bundle Git');
  console.error(error.message);
  process.exit(1);
});
