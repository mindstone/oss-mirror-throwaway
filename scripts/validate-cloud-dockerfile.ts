#!/usr/bin/env npx tsx
/**
 * CI Validation: Cloud Dockerfile integrity
 *
 * Five checks (1–4 below, plus Check 5: build.mjs build-time dependency closure
 * — every file build.mjs imports or execs must be COPYed into the builder
 * stage; see the Check 5 section comment near extractBuildMjsBuildTimeDeps):
 * 1. Every esbuild alias target in cloud-service/build.mjs has a matching
 *    COPY in the Dockerfile builder stage.
 * 2. Every COPY --from=builder in the production stage references a path
 *    that is either COPYed or RUN-generated in the builder stage.
 * 3. The production stage installs ffmpeg (which provides both `ffmpeg` and
 *    `ffprobe` binaries) WITHOUT `--no-install-recommends`. ffmpeg + ffprobe
 *    are load-bearing for cloud meeting-recording — `cloud-service/server.ts`
 *    logs a runtime WARN if absent and services/{ffmpegMediaConcatProcessor,
 *    silenceBoundaryService}.ts spawn them. This makes presence a HARD,
 *    statically-verifiable build-time check.
 *
 *    Guards the regression in
 *    docs/postmortems/260412_ffmpeg_cloud_meeting_recording_broken_postmortem.md:
 *    `apt-get install -y ffmpeg --no-install-recommends` skipped the libav*
 *    shared libraries (shipped as Recommends:, not Depends:), so the binaries
 *    were present but HUNG on every invocation. The static check below cannot
 *    detect a hang at runtime, but it CAN enforce the build-contract invariant
 *    (ffmpeg installed, recommends not suppressed) that prevents the regression
 *    from re-landing. A defence-in-depth container-runtime `ffmpeg -version`
 *    smoke step in build-cloud.yml is the complementary runtime gate (see the
 *    implementer report; deferred here as a CI-YAML follow-up).
 * 4. The production stage sets `NODE_ENV=production`. `cloud-service/src/auth.ts`
 *    intentionally allows tokenless requests outside production mode, so the
 *    packaged Docker runtime must force production mode.
 *
 * Catches bugs where local builds succeed (pre-built artifacts exist)
 * but Docker builds fail (clean checkout, nothing pre-built), and where a
 * required runtime binary is installed in a way that cannot actually run.
 *
 * Run: npx tsx scripts/validate-cloud-dockerfile.ts
 * Wired into: npm run validate:fast
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
const BUILD_MJS = path.join(ROOT, 'cloud-service/build.mjs');
const DOCKERFILE = path.join(ROOT, 'cloud-service/Dockerfile');

// ---------------------------------------------------------------------------
// Check 1: esbuild aliases → builder COPY coverage
// ---------------------------------------------------------------------------

const ALIAS_RE = /['"](@[\w/.-]+)['"]\s*:\s*path\.join\(projectRoot,\s*['"]([^'"]+)['"]\)/g;

function extractAliasTargets(buildSrc: string): Array<{ alias: string; relPath: string }> {
  const results: Array<{ alias: string; relPath: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = ALIAS_RE.exec(buildSrc)) !== null) {
    results.push({ alias: match[1], relPath: match[2] });
  }
  return results;
}

interface BuilderStageInfo {
  /**
   * All paths in the builder image that exist after build, in absolute form
   * rooted at `/app` (or other absolute roots). Derived from COPY destinations
   * resolved against the active WORKDIR plus RUN-generated paths.
   */
  generatedPaths: string[];
}

function parseBuilderStage(dockerfile: string): BuilderStageInfo {
  const generatedPaths: string[] = [];
  let inBuilderStage = false;
  let currentWorkdir = '/app';

  const lines = dockerfile.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('FROM ') && trimmed.includes(' AS builder')) {
      inBuilderStage = true;
      continue;
    }
    if (trimmed.startsWith('FROM ') && inBuilderStage) {
      break;
    }
    if (!inBuilderStage) continue;

    // Track WORKDIR changes
    const workdirMatch = trimmed.match(/^WORKDIR\s+(\S+)/);
    if (workdirMatch) {
      currentWorkdir = workdirMatch[1];
      continue;
    }

    // COPY directives (not --from=)
    const copyMatch = trimmed.match(/^COPY\s+(?!--from)(\S+)\s+(\S+)/);
    if (copyMatch) {
      const dest = copyMatch[2];

      // Track the destination path (absolute) where the COPY actually lands.
      // Relative destinations are resolved against the current WORKDIR — this
      // is the key check that catches WORKDIR/COPY path-drift bugs.
      let resolvedDest: string;
      if (dest.startsWith('/')) {
        resolvedDest = dest;
      } else {
        resolvedDest = currentWorkdir.replace(/\/+$/, '') + '/' + dest;
      }
      generatedPaths.push(resolvedDest.replace(/\/+$/, ''));
    }

    // Collect RUN commands (may span multiple lines via \ continuation or &&)
    if (trimmed.startsWith('RUN')) {
      let fullCmd = trimmed.slice(3).trim();
      let j = i + 1;
      while (fullCmd.endsWith('\\') && j < lines.length) {
        fullCmd = fullCmd.slice(0, -1) + ' ' + lines[j].trim();
        j++;
      }
      const wd = currentWorkdir.replace(/\/+$/, '');

      if (/npm\s+ci|npm\s+install/.test(fullCmd)) {
        generatedPaths.push(wd + '/node_modules');
      }
      if (/\btsc\b/.test(fullCmd)) {
        generatedPaths.push(wd + '/dist');
      }
      if (/node\s+build\.mjs/.test(fullCmd)) {
        generatedPaths.push(wd + '/dist');
      }
      if (/vite\s+build/.test(fullCmd)) {
        generatedPaths.push(wd + '/dist');
      }
      // Inline node scripts that create directories via mkdirSync/cpSync.
      // Match both literal paths: mkdirSync('/app/foo') and variable-based:
      // const dest = '/app/foo'; ... mkdirSync(dest)
      const mkdirLiteralMatches = fullCmd.matchAll(/(?:mkdirSync|cpSync)\(\s*['"]([^'"]+)['"]/g);
      for (const m of mkdirLiteralMatches) {
        generatedPaths.push(m[1].replace(/\/+$/, ''));
      }
      // Match variable assignments that look like output paths used with mkdirSync/cpSync
      const destVarMatches = fullCmd.matchAll(/(?:const|let|var)\s+\w+\s*=\s*['"](\/(app|build)[^'"]+)['"]/g);
      for (const m of destVarMatches) {
        generatedPaths.push(m[1].replace(/\/+$/, ''));
      }
      // node scripts/build-bundled-mcps.mjs generates resources/mcp-generated/
      if (/build-bundled-mcps/.test(fullCmd)) {
        generatedPaths.push(wd + '/resources/mcp-generated');
      }
    }
  }

  return { generatedPaths };
}

// Extract COPY --from=builder paths in the production stage
function extractProductionFromBuilderCopies(
  dockerfile: string,
): Array<{ srcPath: string; line: number }> {
  const results: Array<{ srcPath: string; line: number }> = [];
  let inProductionStage = false;
  let passedBuilder = false;

  const lines = dockerfile.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('FROM ') && trimmed.includes(' AS builder')) {
      passedBuilder = true;
      continue;
    }
    if (trimmed.startsWith('FROM ') && passedBuilder && !inProductionStage) {
      inProductionStage = true;
      continue;
    }
    if (!inProductionStage) continue;

    const match = trimmed.match(/^COPY\s+--from=builder\s+(\S+)/);
    if (match) {
      results.push({ srcPath: match[1].replace(/\/+$/, ''), line: i + 1 });
    }
  }
  return results;
}

function isPathCoveredByGenerated(absPath: string, generatedPaths: string[]): boolean {
  const normalized = absPath.replace(/\/+$/, '');
  return generatedPaths.some((gen) => {
    const normalizedGen = gen.replace(/\/+$/, '');
    return normalized === normalizedGen || normalized.startsWith(normalizedGen + '/');
  });
}

// ---------------------------------------------------------------------------
// Check 3: ffmpeg/ffprobe runtime-binary presence in the production stage
// ---------------------------------------------------------------------------

/**
 * Flatten every RUN command in the production (final) stage into single
 * logical strings, joining `\`-continuation and stripping the leading `RUN`.
 *
 * The production stage is the LAST `FROM` (the one not declared `AS builder`).
 * Exported for unit testing against synthetic Dockerfile fragments.
 */
export function extractProductionRunCommands(dockerfile: string): string[] {
  const cmds: string[] = [];
  let inProductionStage = false;
  let passedBuilder = false;

  const lines = dockerfile.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('FROM ') && trimmed.includes(' AS builder')) {
      passedBuilder = true;
      continue;
    }
    if (trimmed.startsWith('FROM ') && passedBuilder && !inProductionStage) {
      inProductionStage = true;
      continue;
    }
    if (!inProductionStage) continue;

    if (trimmed.startsWith('RUN')) {
      let fullCmd = trimmed.slice(3).trim();
      let j = i + 1;
      while (fullCmd.endsWith('\\') && j < lines.length) {
        fullCmd = fullCmd.slice(0, -1) + ' ' + lines[j].trim();
        j++;
      }
      cmds.push(fullCmd);
    }
  }
  return cmds;
}

export interface FfmpegContractResult {
  errors: string[];
  /** True if at least one production-stage RUN installs the ffmpeg apt package. */
  installsFfmpeg: boolean;
}

/**
 * Assert the production stage installs ffmpeg (the Debian `ffmpeg` package
 * provides BOTH the `ffmpeg` and `ffprobe` binaries) without suppressing
 * recommended dependencies.
 *
 * Two failure modes guarded:
 *   1. ffmpeg never installed at all → both binaries absent.
 *   2. ffmpeg installed with `--no-install-recommends` → binaries present but
 *      cannot run (the 260412 PM root cause: missing libav* shared libs).
 *
 * We accept either the meta-package `ffmpeg` (provides both binaries) or
 * explicit `ffmpeg` + `ffprobe` package mentions, to stay robust if the
 * Dockerfile ever splits them.
 */
export function checkFfmpegRuntimeContract(productionRunCmds: string[]): FfmpegContractResult {
  const errors: string[] = [];

  // An apt-get install line that mentions ffmpeg as a package token. We match
  // `ffmpeg` as a whole word so it can't be a substring of an unrelated token.
  const aptInstallFfmpeg = productionRunCmds.filter(
    (cmd) => /apt(?:-get)?\s+install\b/.test(cmd) && /\bffmpeg\b/.test(cmd),
  );

  const installsFfmpeg = aptInstallFfmpeg.length > 0;

  if (!installsFfmpeg) {
    errors.push(
      '  [ffmpeg] The production stage never installs the `ffmpeg` package.\n' +
        '    ffmpeg + ffprobe are required for cloud meeting-recording\n' +
        '    (services/ffmpegMediaConcatProcessor.ts + silenceBoundaryService.ts\n' +
        '    spawn them). Add a production-stage:\n' +
        '      RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*',
    );
    return { errors, installsFfmpeg };
  }

  // The 260412 regression: --no-install-recommends drops libav* shared libs so
  // the binaries hang. Any ffmpeg-installing line must NOT suppress recommends.
  for (const cmd of aptInstallFfmpeg) {
    if (/--no-install-recommends/.test(cmd)) {
      errors.push(
        '  [ffmpeg] The ffmpeg install uses `--no-install-recommends`, which\n' +
          '    drops the libav* shared libraries (shipped as Recommends, not\n' +
          '    Depends). ffmpeg/ffprobe will be present but HANG on every\n' +
          '    invocation — re-landing the 260412 cloud meeting-recording\n' +
          '    outage. Remove `--no-install-recommends` from the ffmpeg install.\n' +
          `    Offending RUN: ${cmd}`,
      );
    }
  }

  return { errors, installsFfmpeg };
}

// ---------------------------------------------------------------------------
// Check 4: production-stage auth mode must fail closed
// ---------------------------------------------------------------------------

function tokenizeDockerEnvArgs(args: string): string[] {
  return Array.from(args.matchAll(/"[^"]*"|'[^']*'|\S+/g), (match) => {
    const token = match[0];
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      return token.slice(1, -1);
    }
    return token;
  });
}

function stripDockerEnvValueQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Extract production-stage ENV directives into a key/value map.
 *
 * Supports both Dockerfile ENV forms:
 *   - ENV KEY=value OTHER=value
 *   - ENV KEY value
 *
 * The production stage is the LAST `FROM` (the one not declared `AS builder`).
 * Exported for unit testing against synthetic Dockerfile fragments.
 */
export function extractProductionEnvVars(dockerfile: string): Map<string, string> {
  const envVars = new Map<string, string>();
  let inProductionStage = false;
  let passedBuilder = false;

  const lines = dockerfile.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('FROM ') && trimmed.includes(' AS builder')) {
      passedBuilder = true;
      continue;
    }
    if (trimmed.startsWith('FROM ') && passedBuilder && !inProductionStage) {
      inProductionStage = true;
      continue;
    }
    if (!inProductionStage) continue;

    if (/^ENV\s+/.test(trimmed)) {
      let fullEnv = trimmed.slice(3).trim();
      let j = i + 1;
      while (fullEnv.endsWith('\\') && j < lines.length) {
        fullEnv = fullEnv.slice(0, -1) + ' ' + lines[j].trim();
        j++;
      }

      const tokens = tokenizeDockerEnvArgs(fullEnv);
      if (tokens.length === 0) continue;

      if (tokens[0].includes('=')) {
        for (const token of tokens) {
          const equalsIndex = token.indexOf('=');
          if (equalsIndex <= 0) continue;
          envVars.set(
            token.slice(0, equalsIndex),
            stripDockerEnvValueQuotes(token.slice(equalsIndex + 1)),
          );
        }
        continue;
      }

      if (tokens.length >= 2) {
        envVars.set(tokens[0], stripDockerEnvValueQuotes(tokens.slice(1).join(' ')));
      }
    }
  }

  return envVars;
}

export function checkProductionAuthModeContract(envVars: Map<string, string>): { errors: string[] } {
  const nodeEnv = envVars.get('NODE_ENV');
  if (nodeEnv === 'production') {
    return { errors: [] };
  }

  const found = nodeEnv === undefined ? 'absent' : `\`${nodeEnv}\``;
  return {
    errors: [
      '  [auth-mode] The production stage must set `ENV NODE_ENV=production`.\n' +
        `    Found NODE_ENV=${found}. cloud-service/src/auth.ts intentionally\n` +
        '    allows tokenless requests unless process.env.NODE_ENV is exactly\n' +
        '    `production`; omitting this Dockerfile ENV re-lands the 260330\n' +
        '    cloud Docker auth defaults fail-open postmortem for GHCR/self-hosted\n' +
        '    deployments. Keep NODE_ENV=production until auth.ts grows and reads\n' +
        '    an explicit future fail-closed auth mode that this gate can allow.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Check 5: build.mjs build-time dependency closure → builder COPY coverage
// ---------------------------------------------------------------------------

/**
 * cloud-service/build.mjs runs in the builder stage at WORKDIR
 * `/app/cloud-service` (projectRoot = `/app`). Beyond the esbuild aliases
 * (Check 1), it has *its own* build-time file dependencies that must exist in
 * the builder image or the Docker build fails on a clean checkout:
 *
 *   (a) Top-level relative imports in build.mjs, e.g.
 *         import { ... } from '../scripts/lib/discoverElectronImports.mjs';
 *       → resolves to /app/scripts/lib/discoverElectronImports.mjs
 *   (b) Subprocess targets it execs, e.g.
 *         execSync(`npx tsx "${path.join(projectRoot, 'scripts/print-cloud-schema-fingerprint.ts')}"`)
 *       → resolves to /app/scripts/print-cloud-schema-fingerprint.ts
 *
 * Both are the 260531 + 260425 regression class: a local build succeeds (the
 * file is already on disk) but the Docker build fails because no COPY lands it
 * in the builder stage. Today both happen to be hand-COPYed; this check makes
 * that closure a static invariant so the next added dependency can't silently
 * drift.
 *
 * Exported for unit testing against synthetic build.mjs source.
 */
export function extractBuildMjsBuildTimeDeps(buildSrc: string): string[] {
  const deps = new Set<string>();

  // (a) Top-level relative imports that escape the cloud-service dir (../...).
  // build.mjs lives at /app/cloud-service/build.mjs, so they resolve relative to
  // /app/cloud-service. path.posix.resolve normalizes ../, ../../, etc. correctly.
  const importRe = /\bfrom\s+['"](\.\.\/[^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(buildSrc)) !== null) {
    deps.add(path.posix.resolve('/app/cloud-service', m[1]));
  }

  // (b) Subprocess targets referenced via path.join(projectRoot, '<rel>').
  // projectRoot = /app; path.posix.resolve normalizes any ../ in the relative arg.
  const projectRootJoinRe = /path\.join\(\s*projectRoot\s*,\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = projectRootJoinRe.exec(buildSrc)) !== null) {
    deps.add(path.posix.resolve('/app', m[1]));
  }

  return [...deps];
}

// ---------------------------------------------------------------------------
// Run checks
// ---------------------------------------------------------------------------

const BUILDER_PROJECT_ROOT = '/app';

function main(): void {
  const buildSrc = fs.readFileSync(BUILD_MJS, 'utf8');
  const dockerfileSrc = fs.readFileSync(DOCKERFILE, 'utf8');

  const aliases = extractAliasTargets(buildSrc);
  const { generatedPaths } = parseBuilderStage(dockerfileSrc);
  const prodCopies = extractProductionFromBuilderCopies(dockerfileSrc);
  const prodRunCmds = extractProductionRunCommands(dockerfileSrc);
  const prodEnvVars = extractProductionEnvVars(dockerfileSrc);

  const errors: string[] = [];

  // Check 1: esbuild alias targets resolve to absolute paths that exist in the
  // builder image. esbuild runs at `cwd = /app/cloud-service` with projectRoot
  // = /app, so every alias `path.join(projectRoot, relPath)` must resolve to
  // a path created by some COPY destination or RUN-generated path in the
  // builder stage.
  //
  // This catches WORKDIR/COPY drift bugs where a relative COPY lands files
  // under the wrong absolute path (e.g. `COPY cloud-client/ cloud-client/` at
  // WORKDIR `/app/super-mcp` lands files at `/app/super-mcp/cloud-client/`,
  // not `/app/cloud-client/`).
  for (const { alias, relPath } of aliases) {
    const absTarget = BUILDER_PROJECT_ROOT + '/' + relPath.replace(/^\/+/, '');
    if (!isPathCoveredByGenerated(absTarget, generatedPaths)) {
      errors.push(
        `  [alias] ${alias} -> ${relPath}\n` +
          `    esbuild will resolve to ${absTarget} in the builder image,\n` +
          `    but no COPY destination or RUN output lands a file there.\n` +
          `    Check that a COPY destination (resolved against WORKDIR) creates this path.`,
      );
    }
  }

  // Check 2: production COPY --from=builder paths exist in builder
  for (const { srcPath, line } of prodCopies) {
    if (!isPathCoveredByGenerated(srcPath, generatedPaths)) {
      errors.push(
        `  [production] COPY --from=builder ${srcPath} (line ${line})\n` +
          `    This path is not created by any COPY, npm install, or build step in the builder stage.\n` +
          `    The Docker build will fail on a clean checkout.`,
      );
    }
  }

  // Check 5: build.mjs build-time dependency closure (260531 + 260425 PM guard).
  // Every file build.mjs imports (../scripts/...) or execs
  // (path.join(projectRoot, 'scripts/...')) must be COPYed into the builder image.
  const buildTimeDeps = extractBuildMjsBuildTimeDeps(buildSrc);
  for (const dep of buildTimeDeps) {
    if (!isPathCoveredByGenerated(dep, generatedPaths)) {
      errors.push(
        `  [build-dep] cloud-service/build.mjs depends on ${dep} at build time\n` +
          `    (a relative import or path.join(projectRoot, …) subprocess target),\n` +
          `    but no COPY destination or RUN output lands a file there in the builder stage.\n` +
          `    The Docker build will fail on a clean checkout. Add a builder-stage\n` +
          `    COPY for this path (mirror the existing COPY scripts/… lines).`,
      );
    }
  }

  // Check 3: ffmpeg + ffprobe runtime-binary presence (260412 PM guard).
  const ffmpeg = checkFfmpegRuntimeContract(prodRunCmds);
  errors.push(...ffmpeg.errors);

  // Check 4: production Docker image must select auth.ts fail-closed mode (260330 PM guard).
  const authMode = checkProductionAuthModeContract(prodEnvVars);
  errors.push(...authMode.errors);

  if (errors.length > 0) {
    console.error(
      `\n${errors.length} Dockerfile integrity error(s):\n`,
    );
    for (const err of errors) console.error(err);
    console.error(
      '\nThe Docker build will fail (or ship a broken runtime) even though local builds succeed.',
      '\nUpdate cloud-service/Dockerfile to fix the above.\n',
    );
    process.exit(1);
  }

  console.log(
    `✔ All ${aliases.length} esbuild aliases covered by Dockerfile COPY directives.`,
  );
  console.log(
    `✔ All ${prodCopies.length} production COPY --from=builder paths traceable to builder stage.`,
  );
  console.log(
    '✔ Production stage installs ffmpeg (provides ffmpeg + ffprobe) without --no-install-recommends.',
  );
  console.log(
    '✔ Production stage sets NODE_ENV=production for fail-closed cloud auth defaults.',
  );
  console.log(
    `✔ All ${buildTimeDeps.length} cloud-service/build.mjs build-time deps COPYed into the builder stage.`,
  );
}

if (require.main === module) {
  main();
}
