#!/usr/bin/env node

/**
 * Prepare app-local MSVC runtime DLLs for Windows packaging.
 *
 * Downloads vc_redist.x64.exe (or uses VC_REDIST_URL override), extracts vc_runtime*.msi,
 * performs an administrative install (msiexec /a), and copies CRT DLLs into:
 *   resources/windows/msvc-runtime/x64/
 *
 * This is intended to run during CI/build (offline installer; no vc_redist execution at install time).
 */

import { createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const isWindows = process.platform === 'win32';

const DEFAULT_VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
const VC_REDIST_URL = process.env.VC_REDIST_URL || DEFAULT_VC_REDIST_URL;

const OUTPUT_DIR = path.join(projectRoot, 'resources', 'windows', 'msvc-runtime', 'x64');

// Keep this list in sync with runtime preflight check.
const REQUIRED_DLLS = [
  'concrt140.dll',
  'msvcp140.dll',
  'msvcp140_1.dll',
  'msvcp140_2.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
];

const DLL_PREFIX_ALLOWLIST = ['concrt', 'msvcp', 'vcruntime'];

async function download(url, destination) {
  console.log(`[msvc-runtime] Downloading: ${url}`);

  await new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();
          download(response.headers.location, destination).then(resolve).catch(reject);
          return;
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download vc_redist (${response.statusCode})`));
          return;
        }

        const fileStream = createWriteStream(destination);
        pipeline(response, fileStream).then(resolve).catch(reject);
      })
      .on('error', reject);
  });
}

async function walkFiles(rootDir) {
  const results = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  }
  await walk(rootDir);
  return results;
}

function findBundled7za() {
  try {
    // Prefer resolving via Node to avoid assuming a particular node_modules layout.
    const mod = require('7zip-bin');
    if (mod?.path7za && typeof mod.path7za === 'string' && existsSync(mod.path7za)) {
      return mod.path7za;
    }
  } catch {
    // ignore
  }

  const archToDir = {
    x64: 'x64',
    ia32: 'ia32',
    arm64: 'arm64',
  };

  const archDir = archToDir[process.arch];
  if (!archDir) return null;

  const candidate = path.join(projectRoot, 'node_modules', '7zip-bin', 'win', archDir, '7za.exe');
  return existsSync(candidate) ? candidate : null;
}

function findSystem7z() {
  try {
    const out = execFileSync('where', ['7z'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    const first = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);

    if (first && existsSync(first)) return first;
  } catch {
    // ignore
  }

  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    path.join(programFiles, '7-Zip', '7z.exe'),
    path.join(programFilesX86, '7-Zip', '7z.exe'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function extractWith7Zip(archivePath, outDir, options = {}) {
  const { cwd } = options;

  const sevenZip = findBundled7za() || findSystem7z();
  if (!sevenZip) {
    throw new Error(
      'No 7-Zip executable found (checked bundled 7zip-bin and system 7z). ' +
        'Install 7-Zip or ensure node_modules are present.',
    );
  }

  execFileSync(sevenZip, ['x', archivePath, `-o${outDir}`, '-y'], { stdio: 'inherit', cwd });
}

function findRuntimeMsis(files) {
  const msiCandidates = files.filter((f) => f.toLowerCase().endsWith('.msi'));
  const runtimeMsis = msiCandidates.filter((f) =>
    path.basename(f).toLowerCase().startsWith('vc_runtime'),
  );
  const runtimeX64Msis = runtimeMsis.filter((f) => {
    const base = path.basename(f).toLowerCase();
    return base.includes('x64') || base.includes('amd64');
  });

  const selected = runtimeX64Msis.length > 0 ? runtimeX64Msis : runtimeMsis;
  return selected.sort((a, b) => a.localeCompare(b));
}

async function findRequiredDllsInDir(dir) {
  if (!existsSync(dir)) return null;

  const entries = await fs.readdir(dir);
  const byLower = new Map(entries.map((name) => [name.toLowerCase(), name]));

  const missing = REQUIRED_DLLS.filter((dll) => !byLower.has(dll.toLowerCase()));
  if (missing.length > 0) return null;

  return REQUIRED_DLLS.map((dll) => ({
    dll,
    sourcePath: path.join(dir, byLower.get(dll.toLowerCase())),
  }));
}

async function assertIsAmd64Pe(filePath) {
  // PE machine types: https://learn.microsoft.com/en-us/windows/win32/debug/pe-format
  // 0x8664 = AMD64
  const buf = await fs.readFile(filePath);
  if (buf.length < 0x40) {
    throw new Error(`Unexpected PE file length for ${filePath}`);
  }

  // DOS header "MZ"
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) {
    throw new Error(`Not a PE file (missing MZ header): ${filePath}`);
  }

  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset + 6 > buf.length) {
    throw new Error(`Invalid PE header offset for ${filePath}`);
  }

  // PE signature "PE\0\0"
  if (
    buf[peOffset] !== 0x50 ||
    buf[peOffset + 1] !== 0x45 ||
    buf[peOffset + 2] !== 0x00 ||
    buf[peOffset + 3] !== 0x00
  ) {
    throw new Error(`Not a PE file (missing PE signature): ${filePath}`);
  }

  const machine = buf.readUInt16LE(peOffset + 4);
  if (machine !== 0x8664) {
    throw new Error(
      `Expected AMD64 PE (0x8664) but found 0x${machine.toString(16)} for ${filePath}`,
    );
  }
}

// Exit codes that indicate the runtime is already installed (not a real failure).
// 1638 = ERROR_PRODUCT_VERSION (same or newer version already installed)
// 3010 = ERROR_SUCCESS_REBOOT_REQUIRED
// 1641 = ERROR_SUCCESS_REBOOT_INITIATED
const VC_REDIST_ALREADY_INSTALLED_CODES = new Set([1638, 3010, 1641]);

function tryExtractVcRedist(redistExe, extractDir, options = {}) {
  const { cwd } = options;

  // vc_redist supports multiple syntaxes depending on version.
  // Try the most common forms.
  const attempts = [
    [redistExe, ['/extract', extractDir, '/quiet', '/norestart']],
    [redistExe, [`/extract:${extractDir}`, '/quiet', '/norestart']],
    // Some versions extract into the current directory when no path is provided.
    [redistExe, ['/extract', '/quiet', '/norestart']],
  ];

  let lastErr;
  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { stdio: 'inherit', cwd });
      return;
    } catch (err) {
      if (VC_REDIST_ALREADY_INSTALLED_CODES.has(err.status)) {
        console.log(
          `[msvc-runtime] vc_redist exited with ${err.status} (runtime already installed); ` +
            'will fall back to 7-Zip extraction or System32 copy.',
        );
        return;
      }
      lastErr = err;
    }
  }

  throw lastErr;
}

async function main() {
  if (!isWindows) {
    console.log(`[msvc-runtime] Skipping on non-Windows platform: ${process.platform}`);
    return;
  }

  if (/^http:\/\//i.test(VC_REDIST_URL)) {
    throw new Error(
      `VC_REDIST_URL must be https:// or a local path (got http://): ${VC_REDIST_URL}`,
    );
  }

  // Idempotency: if DLLs already present, do nothing.
  if (existsSync(OUTPUT_DIR)) {
    const existing = new Set((await fs.readdir(OUTPUT_DIR)).map((f) => f.toLowerCase()));
    const missing = REQUIRED_DLLS.filter((d) => !existing.has(d.toLowerCase()));
    if (missing.length === 0) {
      console.log(`[msvc-runtime] Already prepared (found ${REQUIRED_DLLS.length} required DLLs in ${OUTPUT_DIR})`);
      return;
    }
  }

  console.log('[msvc-runtime] Preparing app-local MSVC runtime...');
  console.log(`  Output: ${OUTPUT_DIR}`);
  console.log(`  Source: ${VC_REDIST_URL}`);

  const tempRoot = await fs.mkdtemp(path.join(tmpdir(), 'mindstone-vc-redist-'));
  const redistExePath = path.join(tempRoot, 'vc_redist.x64.exe');
  const extractDirRel = 'extract';
  const extractDir = path.join(tempRoot, extractDirRel);
  const msiOutRoot = path.join(tempRoot, 'msi-extract');

  try {
    await fs.mkdir(extractDir, { recursive: true });
    await fs.mkdir(msiOutRoot, { recursive: true });

    if (/^https?:\/\//i.test(VC_REDIST_URL)) {
      await download(VC_REDIST_URL, redistExePath);
    } else {
      // Treat override as local path to an already-downloaded vc_redist.x64.exe
      const localPath = path.isAbsolute(VC_REDIST_URL)
        ? VC_REDIST_URL
        : path.join(projectRoot, VC_REDIST_URL);

      if (!existsSync(localPath)) {
        throw new Error(`VC_REDIST_URL override path not found: ${localPath}`);
      }

      await fs.copyFile(localPath, redistExePath);
    }

    console.log('[msvc-runtime] Extracting vc_redist...');
    // Use a stable cwd so extraction doesn't land in the repo root.
    tryExtractVcRedist(redistExePath, extractDirRel, { cwd: tempRoot });

    // Some vc_redist versions may not honor the provided extract path.
    // Scan the whole temp root to find runtime MSIs.
    let extractedFiles = await walkFiles(tempRoot);
    let msiFiles = findRuntimeMsis(extractedFiles);

    if (msiFiles.length === 0) {
      console.log('[msvc-runtime] No MSI files found after vc_redist extraction; trying 7-Zip...');
      extractWith7Zip(redistExePath, extractDir, { cwd: tempRoot });

      extractedFiles = await walkFiles(tempRoot);
      msiFiles = findRuntimeMsis(extractedFiles);
    }

    if (msiFiles.length === 0) {
      // Last-resort fallback: copy from System32 if the machine already has the runtime installed.
      // This keeps the build unblocked when upstream vc_redist packaging/extraction changes.
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const sysnativeDir = path.join(systemRoot, 'Sysnative');
      const system32Dir = existsSync(sysnativeDir) ? sysnativeDir : path.join(systemRoot, 'System32');
      const system32Dlls = await findRequiredDllsInDir(system32Dir);

      if (system32Dlls) {
        console.log('[msvc-runtime] Falling back to System32 MSVC runtime DLLs.');
        console.log(`  Source: ${system32Dir}`);
        await fs.mkdir(OUTPUT_DIR, { recursive: true });

        for (const { dll, sourcePath } of system32Dlls) {
          const destPath = path.join(OUTPUT_DIR, dll);
          await fs.copyFile(sourcePath, destPath);
          await assertIsAmd64Pe(destPath);
          console.log(`  Copied: ${dll}`);
        }

        const finalSet = new Set((await fs.readdir(OUTPUT_DIR)).map((f) => f.toLowerCase()));
        const missingRequired = REQUIRED_DLLS.filter((d) => !finalSet.has(d.toLowerCase()));
        if (missingRequired.length > 0) {
          throw new Error(
            `MSVC runtime output incomplete after System32 fallback. Missing: ${missingRequired.join(', ')}. Output dir: ${OUTPUT_DIR}`,
          );
        }

        console.log('[msvc-runtime] MSVC runtime prepared successfully (System32 fallback).');
        return;
      }

      const foundMsiNames = extractedFiles
        .filter((f) => f.toLowerCase().endsWith('.msi'))
        .map((f) => path.basename(f))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 50);

      const topLevel = (await fs.readdir(tempRoot)).sort((a, b) => a.localeCompare(b)).slice(0, 50);

      throw new Error(
        `No vc_runtime MSI found after extracting vc_redist (searched under ${tempRoot}). ` +
          `Found MSIs: ${foundMsiNames.length > 0 ? foundMsiNames.join(', ') : '(none)'}. ` +
          `Top-level extracted entries: ${topLevel.length > 0 ? topLevel.join(', ') : '(none)'}`,
      );
    }

    console.log(`[msvc-runtime] Found ${msiFiles.length} MSI(s):`);
    for (const msi of msiFiles) {
      console.log(`  - ${msi}`);
    }

    const dllCandidates = new Map();

    for (const msiPath of msiFiles) {
      const label = path.basename(msiPath, '.msi');
      const targetDir = path.join(msiOutRoot, label);
      await fs.mkdir(targetDir, { recursive: true });

      console.log(`[msvc-runtime] Extracting MSI via msiexec /a: ${label}`);
      execFileSync(
        'msiexec',
        ['/a', msiPath, '/qn', `TARGETDIR=${targetDir}`],
        { stdio: 'inherit' },
      );

      const files = await walkFiles(targetDir);
      for (const file of files) {
        if (!file.toLowerCase().endsWith('.dll')) continue;
        const base = path.basename(file).toLowerCase();
        if (!DLL_PREFIX_ALLOWLIST.some((p) => base.startsWith(p))) continue;
        // If duplicates exist across MSIs, prefer the first encountered.
        if (!dllCandidates.has(base)) {
          dllCandidates.set(base, file);
        }
      }
    }

    if (dllCandidates.size === 0) {
      throw new Error('No CRT DLLs found after MSI extraction');
    }

    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    console.log(`[msvc-runtime] Copying ${dllCandidates.size} DLL(s) to output...`);
    for (const [dllName, srcPath] of dllCandidates.entries()) {
      const destPath = path.join(OUTPUT_DIR, dllName);
      await fs.copyFile(srcPath, destPath);
      console.log(`  Copied: ${dllName}`);
    }

    const finalSet = new Set((await fs.readdir(OUTPUT_DIR)).map((f) => f.toLowerCase()));
    const missingRequired = REQUIRED_DLLS.filter((d) => !finalSet.has(d.toLowerCase()));
    if (missingRequired.length > 0) {
      throw new Error(
        `MSVC runtime output incomplete. Missing: ${missingRequired.join(', ')}. Output dir: ${OUTPUT_DIR}`,
      );
    }

    for (const dll of REQUIRED_DLLS) {
      await assertIsAmd64Pe(path.join(OUTPUT_DIR, dll));
    }

    console.log('[msvc-runtime] MSVC runtime prepared successfully.');
  } finally {
    // Best-effort cleanup; keep output in repo.
    try {
      await fs.rm(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error('[msvc-runtime] Failed to prepare MSVC runtime:', err);
  process.exit(1);
});
