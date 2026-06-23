import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  checkProductionAuthModeContract,
  checkFfmpegRuntimeContract,
  extractBuildMjsBuildTimeDeps,
  extractProductionEnvVars,
  extractProductionRunCommands,
} from '../validate-cloud-dockerfile';

// ---------------------------------------------------------------------------
// extractProductionRunCommands — only collects RUN lines from the FINAL stage
// ---------------------------------------------------------------------------

describe('extractProductionRunCommands', () => {
  it('collects RUN commands from the production (final) stage, not the builder', () => {
    const dockerfile = [
      'FROM node:22-slim AS builder',
      'RUN npm ci',
      'RUN echo builder-only',
      '',
      'FROM node:22-slim',
      'RUN apt-get update && apt-get install -y ffmpeg',
      'RUN useradd -m rebel',
    ].join('\n');
    const cmds = extractProductionRunCommands(dockerfile);
    expect(cmds).toEqual([
      'apt-get update && apt-get install -y ffmpeg',
      'useradd -m rebel',
    ]);
  });

  it('joins backslash-continued RUN lines into one logical command', () => {
    const dockerfile = [
      'FROM node:22-slim AS builder',
      'RUN npm ci',
      'FROM node:22-slim',
      'RUN apt-get update && \\',
      '    apt-get install -y ffmpeg && \\',
      '    rm -rf /var/lib/apt/lists/*',
    ].join('\n');
    const cmds = extractProductionRunCommands(dockerfile);
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain('apt-get install -y ffmpeg');
    expect(cmds[0]).toContain('rm -rf /var/lib/apt/lists/*');
  });
});

// ---------------------------------------------------------------------------
// checkFfmpegRuntimeContract — presence + no-install-recommends guard
// ---------------------------------------------------------------------------

describe('checkFfmpegRuntimeContract', () => {
  it('passes when ffmpeg is installed without --no-install-recommends', () => {
    const result = checkFfmpegRuntimeContract([
      'apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*',
    ]);
    expect(result.installsFfmpeg).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('fails when ffmpeg is never installed', () => {
    const result = checkFfmpegRuntimeContract([
      'apt-get update && apt-get install -y curl',
      'useradd -m rebel',
    ]);
    expect(result.installsFfmpeg).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/never installs the `ffmpeg` package/);
  });

  it('fails when ffmpeg is installed WITH --no-install-recommends (260412 regression)', () => {
    const result = checkFfmpegRuntimeContract([
      'apt-get update && apt-get install -y --no-install-recommends ffmpeg',
    ]);
    expect(result.installsFfmpeg).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/--no-install-recommends/);
    expect(result.errors[0]).toMatch(/HANG/);
  });

  it('matches `ffmpeg` only as a whole word (no substring false-positives)', () => {
    const result = checkFfmpegRuntimeContract([
      'apt-get update && apt-get install -y ffmpeg-extra-tools',
    ]);
    // `ffmpeg-extra-tools` is matched as a whole word `ffmpeg` boundary at the
    // hyphen, which is acceptable — the real Dockerfile installs the `ffmpeg`
    // package. The point is it does NOT match an unrelated token like
    // `libffmpegthumbnailer`.
    const noMatch = checkFfmpegRuntimeContract([
      'apt-get update && apt-get install -y libffmpegthumbnailer',
    ]);
    expect(result.installsFfmpeg).toBe(true);
    expect(noMatch.installsFfmpeg).toBe(false);
  });

  it('handles `apt install` (no -get) form', () => {
    const result = checkFfmpegRuntimeContract([
      'apt install -y ffmpeg',
    ]);
    expect(result.installsFfmpeg).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractProductionEnvVars/checkProductionAuthModeContract — auth fail-closed guard
// ---------------------------------------------------------------------------

describe('checkProductionAuthModeContract', () => {
  it('passes when the production stage sets ENV NODE_ENV=production', () => {
    const dockerfile = [
      'FROM node:22-slim AS builder',
      'ENV NODE_ENV=development',
      'FROM node:22-slim',
      'ENV REBEL_USER_DATA=/data NODE_ENV=production PORT=8080',
    ].join('\n');

    const envVars = extractProductionEnvVars(dockerfile);
    const result = checkProductionAuthModeContract(envVars);
    expect(envVars.get('NODE_ENV')).toBe('production');
    expect(result.errors).toEqual([]);
  });

  it('fails when the production stage is missing NODE_ENV', () => {
    const dockerfile = [
      'FROM node:22-slim AS builder',
      'RUN npm ci',
      'FROM node:22-slim',
      'ENV REBEL_USER_DATA=/data PORT=8080',
    ].join('\n');

    const result = checkProductionAuthModeContract(extractProductionEnvVars(dockerfile));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/NODE_ENV=absent/);
    expect(result.errors[0]).toMatch(/cloud-service\/src\/auth\.ts/);
    expect(result.errors[0]).toMatch(/260330/);
    expect(result.errors[0]).toMatch(/fail-open/);
  });

  it('fails when the production stage sets NODE_ENV=development', () => {
    const dockerfile = [
      'FROM node:22-slim AS builder',
      'RUN npm ci',
      'FROM node:22-slim',
      'ENV NODE_ENV=development',
    ].join('\n');

    const result = checkProductionAuthModeContract(extractProductionEnvVars(dockerfile));
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/NODE_ENV=`development`/);
  });

  it('passes with the Dockerfile space form: ENV NODE_ENV production', () => {
    const dockerfile = [
      'FROM node:22-slim AS builder',
      'RUN npm ci',
      'FROM node:22-slim',
      'ENV NODE_ENV production',
    ].join('\n');

    const envVars = extractProductionEnvVars(dockerfile);
    const result = checkProductionAuthModeContract(envVars);
    expect(envVars.get('NODE_ENV')).toBe('production');
    expect(result.errors).toEqual([]);
  });

  it('passes when NODE_ENV production is quoted', () => {
    const dockerfile = [
      'FROM node:22-slim AS builder',
      'RUN npm ci',
      'FROM node:22-slim',
      'ENV NODE_ENV="production"',
    ].join('\n');

    const envVars = extractProductionEnvVars(dockerfile);
    const result = checkProductionAuthModeContract(envVars);
    expect(envVars.get('NODE_ENV')).toBe('production');
    expect(result.errors).toEqual([]);
  });

  it('fails when only the builder stage sets NODE_ENV=production', () => {
    const dockerfile = [
      'FROM node:22-slim AS builder',
      'ENV NODE_ENV=production',
      'RUN npm ci',
      'FROM node:22-slim',
      'ENV PORT=8080',
    ].join('\n');

    const envVars = extractProductionEnvVars(dockerfile);
    const result = checkProductionAuthModeContract(envVars);
    expect(envVars.has('NODE_ENV')).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it('parses backslash-continued production ENV key/value pairs', () => {
    const dockerfile = [
      'FROM node:22-slim AS builder',
      'RUN npm ci',
      'FROM node:22-slim',
      'ENV REBEL_USER_DATA=/data \\',
      '    IS_CLOUD_SERVICE=1 \\',
      '    NODE_ENV=production \\',
      '    PORT=8080',
    ].join('\n');

    const envVars = extractProductionEnvVars(dockerfile);
    expect(envVars.get('REBEL_USER_DATA')).toBe('/data');
    expect(envVars.get('IS_CLOUD_SERVICE')).toBe('1');
    expect(envVars.get('NODE_ENV')).toBe('production');
    expect(envVars.get('PORT')).toBe('8080');
    expect(checkProductionAuthModeContract(envVars).errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Real Dockerfile — the live contract must currently pass
// ---------------------------------------------------------------------------

describe('cloud-service/Dockerfile (live)', () => {
  it('installs ffmpeg in the production stage without --no-install-recommends', () => {
    const dockerfile = fs.readFileSync(
      path.join(__dirname, '..', '..', 'cloud-service', 'Dockerfile'),
      'utf8',
    );
    const cmds = extractProductionRunCommands(dockerfile);
    const result = checkFfmpegRuntimeContract(cmds);
    expect(result.installsFfmpeg).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('sets NODE_ENV=production in the production stage', () => {
    const dockerfile = fs.readFileSync(
      path.join(__dirname, '..', '..', 'cloud-service', 'Dockerfile'),
      'utf8',
    );
    const envVars = extractProductionEnvVars(dockerfile);
    const result = checkProductionAuthModeContract(envVars);
    expect(envVars.get('NODE_ENV')).toBe('production');
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractBuildMjsBuildTimeDeps — build.mjs build-time dependency closure
// ---------------------------------------------------------------------------

describe('extractBuildMjsBuildTimeDeps', () => {
  it('captures top-level relative imports escaping the cloud-service dir', () => {
    const src = `import { foo } from '../scripts/lib/discoverElectronImports.mjs';`;
    expect(extractBuildMjsBuildTimeDeps(src)).toContain(
      '/app/scripts/lib/discoverElectronImports.mjs',
    );
  });

  it('captures path.join(projectRoot, ...) subprocess targets', () => {
    const src = `const fp = path.join(projectRoot, 'scripts/print-cloud-schema-fingerprint.ts');`;
    expect(extractBuildMjsBuildTimeDeps(src)).toContain(
      '/app/scripts/print-cloud-schema-fingerprint.ts',
    );
  });

  it('resolves relative imports to /app (build.mjs lives at /app/cloud-service)', () => {
    const src = `import x from '../scripts/build-bundled-mcps.mjs';`;
    expect(extractBuildMjsBuildTimeDeps(src)).toEqual(['/app/scripts/build-bundled-mcps.mjs']);
  });

  it('normalizes multi-level ../../ relative imports correctly', () => {
    const src = `import x from '../../scripts/x.mjs';`;
    // /app/cloud-service/../../scripts/x.mjs → /scripts/x.mjs
    expect(extractBuildMjsBuildTimeDeps(src)).toEqual(['/scripts/x.mjs']);
  });

  it('normalizes ../ inside path.join(projectRoot, …) targets', () => {
    const src = `path.join(projectRoot, '../outside.ts')`;
    expect(extractBuildMjsBuildTimeDeps(src)).toEqual(['/outside.ts']);
  });

  it('does not capture bare/package imports or same-dir relatives', () => {
    const src = [
      `import { build } from 'esbuild';`,
      `import './localThing.mjs';`,
      `import config from './runtimeExternals.json';`,
    ].join('\n');
    expect(extractBuildMjsBuildTimeDeps(src)).toEqual([]);
  });

  it('matches the real build.mjs (regression guard): includes both load-bearing deps', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'cloud-service', 'build.mjs'),
      'utf8',
    );
    const deps = extractBuildMjsBuildTimeDeps(src);
    expect(deps).toContain('/app/scripts/lib/discoverElectronImports.mjs');
    expect(deps).toContain('/app/scripts/print-cloud-schema-fingerprint.ts');
  });
});
