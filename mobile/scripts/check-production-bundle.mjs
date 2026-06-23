import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Production-mode mobile bundle smoke.
//
// The dev-mode integrity harness (`test-metro-runtime-integrity.mjs`) bundles
// with `dev=true`, where the lenient transform tolerates `import.meta` and other
// Node-only constructs. EAS production builds use the Hermes production transform
// (`dev=false`, minified), which rejects them. A Node-only / `import.meta` leak
// into the RN bundle graph therefore slipped past the dev check and only surfaced
// days later in an EAS build (see docs/project/RELEASE_TO_MOBILE.md §5).
//
// This script closes that gap: it runs a real production `expo export` and FAILS
// at PR time if the bundle can't build.
//
// CRITICAL: `npx expo export` returns exit code 0 EVEN WHEN bundling fails — the
// failure shows only as `Bundling failed` / `SyntaxError` / `Unable to resolve`
// lines in its output, and the Hermes `.hbc` artifact is simply absent. So we do
// NOT trust the exit code. Belt-and-suspenders: (a) scan combined stdout+stderr
// for failure markers, AND (b) assert the expected `.hbc` artifact exists.

const EXPORT_TIMEOUT_MS = 8 * 60 * 1000; // 8 min — a hang fails loudly rather than hanging CI.
const PLATFORM = 'android'; // Android-only is sufficient: the Node-only / import.meta class is
// platform-agnostic (same Hermes production transform); keeps CI fast.

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Case-insensitive markers that indicate a bundling failure in expo/Metro output.
const FAILURE_MARKERS = ['bundling failed', 'syntaxerror', 'unable to resolve', 'error:', 'failed to'];

function runExport(outputDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      npmCmd,
      ['exec', '--', 'expo', 'export', '--platform', PLATFORM, '--output-dir', outputDir],
      {
        cwd: projectRoot,
        env: { ...process.env, CI: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      },
    );

    let combined = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(
        new Error(
          `expo export timed out after ${EXPORT_TIMEOUT_MS / 1000}s — treating as failure.\n${combined.slice(-4000)}`,
        ),
      );
    }, EXPORT_TIMEOUT_MS);

    const onChunk = (chunk) => {
      const text = chunk.toString();
      combined += text;
      // Stream through so CI logs show progress in real time.
      process.stdout.write(text);
    };

    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // NOTE: deliberately resolve regardless of exit code — expo export exits 0
      // on bundle failure. The caller validates output + artifact instead.
      resolve({ code, signal, output: combined });
    });
  });
}

function findHermesBundle(outputDir) {
  const bundleDir = path.join(outputDir, '_expo', 'static', 'js', PLATFORM);
  if (!existsSync(bundleDir)) {
    return null;
  }
  const entries = readdirSync(bundleDir).filter((name) => name.endsWith('.hbc') || name.endsWith('.js'));
  if (entries.length === 0) {
    return null;
  }
  return path.join(bundleDir, entries[0]);
}

function buildFailureMessage(reason, output) {
  let msg = `\n[production-bundle] FAILED\n${reason}\n`;
  msg +=
    '\nA Node-only module (or other unsupported construct, e.g. `import.meta`) likely leaked into the\n' +
    'React Native bundle graph. The production Hermes transform rejects it even though the dev-mode\n' +
    'check tolerates it.\n\n' +
    'To diagnose locally:\n' +
    '  cd mobile && npx expo export --platform android\n' +
    'and look for `Bundling failed` / `SyntaxError` / `Unable to resolve` in the output.\n\n' +
    'See docs/project/RELEASE_TO_MOBILE.md §5 for the boundary rules and the import-edge trace technique.';
  if (output) {
    msg += '\n\n--- tail of expo export output ---\n' + output.slice(-4000);
  }
  return msg;
}

async function main() {
  const outputDir = mkdtempSync(path.join(os.tmpdir(), 'rebel-prod-bundle-'));
  console.log(`[production-bundle] Running production expo export (platform=${PLATFORM}) → ${outputDir}`);

  let result = { ok: false, message: '' };

  try {
    const { code, signal, output } = await runExport(outputDir);

    // (a) Scan output for failure markers (case-insensitive). expo export exits 0
    //     even on failure, so this is the primary signal.
    const lower = output.toLowerCase();
    const matchedMarker = FAILURE_MARKERS.find((marker) => lower.includes(marker));
    if (matchedMarker) {
      result = {
        ok: false,
        message: buildFailureMessage(
          `expo export output contained failure marker: "${matchedMarker}" (exit code ${String(code)}, signal ${String(signal)}).`,
          output,
        ),
      };
    } else {
      // (b) Assert the Hermes bundle artifact was actually written. A missing artifact
      //     means bundling failed silently even if no marker matched.
      const artifact = findHermesBundle(outputDir);
      if (!artifact) {
        result = {
          ok: false,
          message: buildFailureMessage(
            `expo export produced no bundle artifact under ${path.join(outputDir, '_expo', 'static', 'js', PLATFORM)} ` +
              `(exit code ${String(code)}, signal ${String(signal)}).`,
            output,
          ),
        };
      } else {
        result = {
          ok: true,
          message: `\n[production-bundle] OK — production bundle built successfully: ${path.relative(outputDir, artifact)}`,
        };
      }
    }
  } finally {
    try {
      rmSync(outputDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of the temp dir; non-fatal.
      console.warn(`[production-bundle] Warning: could not clean up temp dir ${outputDir}`);
    }
  }

  if (result.ok) {
    console.log(result.message);
    process.exit(0);
  } else {
    console.error(result.message);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('\n[production-bundle] FAILED (unexpected error)');
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
