#!/usr/bin/env node

/**
 * Bundle a relocatable Node.js distribution (with npm/npx) for the Electron app
 * so the packaged app works on fresh machines without system Node.js installed.
 * 
 * Supports:
 * - macOS (darwin): Downloads .tar.gz, extracts with tar
 * - Windows (win32): Downloads .zip, extracts with PowerShell
 */

import { createWriteStream, existsSync, mkdtempSync, mkdirSync, rmSync, readdirSync, renameSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import https from 'https';
import { pipeline } from 'stream/promises';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const bundleDir = join(projectRoot, 'resources', 'node-bundle');
const manifestPath = join(bundleDir, '.bundle-manifest.json');
const supportedPlatforms = new Set(['darwin', 'win32', 'linux']);
const supportedArch = new Set(['arm64', 'x64']);

if (!supportedPlatforms.has(process.platform)) {
  console.log(`ℹ️  Skipping Node.js bundling on unsupported platform: ${process.platform}`);
  process.exit(0);
}

const requestedVersion = process.env.BUNDLE_NODE_VERSION || process.version;
const nodeVersion = requestedVersion.startsWith('v') ? requestedVersion : `v${requestedVersion}`;

// Allow CI to override target architecture (e.g., building x64 package on arm64 runner)
const targetArch = process.env.BUNDLE_NODE_ARCH || process.arch;

if (!supportedArch.has(targetArch)) {
  console.error(`❌ Unsupported architecture: ${targetArch}`);
  process.exit(1);
}

// Windows uses 'win' in the filename, not 'win32'
const platformName = process.platform === 'win32' ? 'win' : process.platform;
const isWindows = process.platform === 'win32';
const archiveExt = isWindows ? 'zip' : 'tar.gz';
const archiveName = `node-${nodeVersion}-${platformName}-${targetArch}.${archiveExt}`;
const downloadUrl = `https://nodejs.org/dist/${nodeVersion}/${archiveName}`;

async function download(url, destination) {
  console.log(`⬇️  Downloading ${url}`);
  await new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(response.headers.location, destination).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download Node.js (${response.statusCode})`));
        return;
      }
      const fileStream = createWriteStream(destination);
      pipeline(response, fileStream).then(resolve).catch(reject);
    }).on('error', reject);
  });
}

function extractTarball(tarballPath, destinationDir) {
  console.log('📦 Extracting tarball...');
  execSync(`tar -xzf "${tarballPath}" -C "${destinationDir}" --strip-components=1`);
}

function extractZip(zipPath, destinationDir) {
  console.log('📦 Extracting zip archive...');
  // Use PowerShell's Expand-Archive which is available on all modern Windows
  const tempExtractDir = join(dirname(destinationDir), 'node-bundle-extract-temp');
  
  // Clean up temp dir if it exists
  if (existsSync(tempExtractDir)) {
    rmSync(tempExtractDir, { recursive: true, force: true });
  }
  mkdirSync(tempExtractDir, { recursive: true });
  
  // Extract to temp directory
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tempExtractDir}' -Force"`,
    { stdio: 'inherit' }
  );
  
  // The zip contains a folder like "node-v20.10.0-win-x64", we need to move its contents
  const extractedContents = readdirSync(tempExtractDir);
  if (extractedContents.length !== 1) {
    throw new Error(`Unexpected zip structure: expected 1 top-level folder, found ${extractedContents.length}`);
  }
  
  const innerDir = join(tempExtractDir, extractedContents[0]);
  
  // Move contents from inner directory to destination
  for (const item of readdirSync(innerDir)) {
    renameSync(join(innerDir, item), join(destinationDir, item));
  }
  
  // Clean up temp directory
  rmSync(tempExtractDir, { recursive: true, force: true });
}

function verifyBinaryMacOS(binaryPath) {
  console.log('🔍 Verifying bundled binary for absolute dylib references...');
  try {
    const output = execSync(`otool -L "${binaryPath}"`, { encoding: 'utf8' });
    const forbiddenPatterns = [/\/opt\/homebrew\//, /\/usr\/local\//];
    const offending = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => forbiddenPatterns.some((pattern) => pattern.test(line)));
    if (offending.length > 0) {
      throw new Error(`Bundled node binary references local shared libraries:\n${offending.join('\n')}`);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.warn('⚠️  otool not available; skipping dylib verification');
      return;
    }
    throw error;
  }
}

function verifyBinaryLinux(binaryPath) {
  console.log('🔍 Verifying bundled node binary exists...');
  if (!existsSync(binaryPath)) {
    throw new Error(`Node binary not found at ${binaryPath}`);
  }
  // Basic verification - check it's executable
  try {
    const output = execSync(`"${binaryPath}" --version`, { encoding: 'utf8' });
    console.log(`   Bundled Node.js version: ${output.trim()}`);
  } catch (error) {
    throw new Error(`Failed to verify node binary: ${error.message}`);
  }
}

function verifyBinaryWindows(binaryPath) {
  console.log('🔍 Verifying bundled node.exe exists...');
  if (!existsSync(binaryPath)) {
    throw new Error(`Node binary not found at ${binaryPath}`);
  }
  // Basic verification - check it's a valid executable
  try {
    const output = execSync(`"${binaryPath}" --version`, { encoding: 'utf8' });
    console.log(`   Bundled Node.js version: ${output.trim()}`);
  } catch (error) {
    throw new Error(`Failed to verify node.exe: ${error.message}`);
  }
}

function ensureBundleDirClean() {
  if (existsSync(bundleDir)) {
    console.log('🧹 Cleaning existing bundle...');
    rmSync(bundleDir, { recursive: true, force: true });
  }
  mkdirSync(bundleDir, { recursive: true });
}

function isBundleCurrent() {
  try {
    if (!existsSync(manifestPath)) return false;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const binaryPath = isWindows ? join(bundleDir, 'node.exe') : join(bundleDir, 'bin', 'node');
    return (
      manifest.version === nodeVersion &&
      manifest.arch === targetArch &&
      manifest.platform === process.platform &&
      existsSync(binaryPath)
    );
  } catch {
    return false;
  }
}

function writeManifest() {
  writeFileSync(manifestPath, JSON.stringify({
    version: nodeVersion,
    arch: targetArch,
    platform: process.platform,
    createdAt: new Date().toISOString(),
  }, null, 2));
}

async function main() {
  console.log('🚀 Bundling Node.js with npm/npx...');
  console.log(`   Platform: ${process.platform}`);
  console.log(`   Version: ${nodeVersion}`);
  console.log(`   Architecture: ${targetArch}`);
  console.log(`   Target:  ${bundleDir}`);

  if (isBundleCurrent()) {
    console.log(`✅ Node.js bundle already up-to-date (${nodeVersion} ${targetArch}), skipping download`);
    return;
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'node-bundle-'));
  const archivePath = join(tempRoot, archiveName);

  try {
    await download(downloadUrl, archivePath);
    ensureBundleDirClean();
    console.log('📂 Extracting Node.js distribution into resources...');
    mkdirSync(bundleDir, { recursive: true });

    if (isWindows) {
      extractZip(archivePath, bundleDir);
      // Windows: node.exe is at the root of the bundle, not in bin/
      const nodeBinaryPath = join(bundleDir, 'node.exe');
      verifyBinaryWindows(nodeBinaryPath);
    } else {
      extractTarball(archivePath, bundleDir);
      // macOS/Linux: node is in bin/
      const nodeBinaryPath = join(bundleDir, 'bin', 'node');
      if (!existsSync(nodeBinaryPath)) {
        throw new Error('Node binary missing after extraction');
      }
      if (process.platform === 'darwin') {
        verifyBinaryMacOS(nodeBinaryPath);
      } else {
        verifyBinaryLinux(nodeBinaryPath);
      }
    }

    writeManifest();

    // Get bundle size (platform-specific command)
    let size;
    if (isWindows) {
      // PowerShell to get folder size in human-readable format
      try {
        const sizeBytes = execSync(
          `powershell -NoProfile -Command "(Get-ChildItem -Recurse '${bundleDir}' | Measure-Object -Property Length -Sum).Sum"`,
          { encoding: 'utf8' }
        ).trim();
        const sizeMB = (parseInt(sizeBytes, 10) / 1024 / 1024).toFixed(1);
        size = `${sizeMB}M`;
      } catch {
        size = 'unknown';
      }
    } else {
      size = execSync(`du -sh "${bundleDir}"`, { encoding: 'utf8' }).split('\t')[0];
    }
    
    console.log('✅ Node.js bundle created successfully!');
    console.log(`   Size: ${size}`);
  } finally {
    if (existsSync(tempRoot)) {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error('❌ Failed to bundle Node.js');
  console.error(error.message);
  process.exit(1);
});
