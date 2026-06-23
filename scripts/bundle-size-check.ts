#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const repoRoot = path.resolve(__dirname, '..');

// Office bundle moved to @mindstone-engineering/mcp-server-office (OSS package);
// CI for that bundle lives in mindstone/mcp-servers. This script now only checks
// the in-repo browser extension. See docs/plans/260422_rebeloffice_oss_migration.md.

const extension = {
  baselinePath: path.join(repoRoot, 'packages', 'browser-extension', '.bundle-size-baseline.json'),
  assetsDir: path.join(repoRoot, 'packages', 'browser-extension', 'dist', 'assets'),
  growthThresholdBytes: 1024,
};

interface BundleMeasurement {
  bytes: number;
  gzipBytes: number;
}

interface BundleBaseline {
  assetsJs?: {
    bytes?: unknown;
    gzipBytes?: unknown;
  };
}

function readJson(filePath: string): BundleBaseline {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing file: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as BundleBaseline;
}

function measureFile(filePath: string): BundleMeasurement {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing bundle file: ${filePath}`);
  }
  const data = fs.readFileSync(filePath);
  return {
    bytes: data.length,
    gzipBytes: zlib.gzipSync(data).length,
  };
}

function measureExtensionAssets(assetsDir: string): BundleMeasurement & { fileCount: number } {
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`Missing assets directory: ${assetsDir}`);
  }
  const jsFiles = (fs.readdirSync(assetsDir) as string[])
    .filter((name) => name.endsWith('.js'))
    .sort();

  if (jsFiles.length === 0) {
    throw new Error(`No JS assets found in ${assetsDir}`);
  }

  let bytes = 0;
  let gzipBytes = 0;
  for (const fileName of jsFiles) {
    const fullPath = path.join(assetsDir, fileName);
    const data = fs.readFileSync(fullPath);
    bytes += data.length;
    gzipBytes += zlib.gzipSync(data).length;
  }

  return { bytes, gzipBytes, fileCount: jsFiles.length };
}

function percentDelta(current: number, baseline: number): number {
  if (baseline <= 0) {
    return current > baseline ? Infinity : 0;
  }
  return ((current - baseline) / baseline) * 100;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return '∞';
  }
  return `${value.toFixed(2)}%`;
}

function main() {
  const extensionBaseline = readJson(extension.baselinePath);
  const extensionBaselineEntry = extensionBaseline.assetsJs;
  if (
    !extensionBaselineEntry ||
    typeof extensionBaselineEntry.bytes !== 'number' ||
    typeof extensionBaselineEntry.gzipBytes !== 'number'
  ) {
    throw new Error(`Invalid extension baseline format in ${extension.baselinePath}`);
  }

  const extensionCurrent = measureExtensionAssets(extension.assetsDir);

  const extensionRawDelta = extensionCurrent.bytes - extensionBaselineEntry.bytes;
  const extensionGzipDelta = extensionCurrent.gzipBytes - extensionBaselineEntry.gzipBytes;

  const extensionFailed = extensionRawDelta > extension.growthThresholdBytes;

  console.log('Bundle size check');
  console.log('=================');
  console.log(
    `Extension assets/*.js (${extensionCurrent.fileCount} files): baseline ${extensionBaselineEntry.bytes}B raw / ${extensionBaselineEntry.gzipBytes}B gz -> current ${extensionCurrent.bytes}B raw / ${extensionCurrent.gzipBytes}B gz (delta ${extensionRawDelta}B raw, ${extensionGzipDelta}B gz)`
  );

  if (extensionFailed) {
    console.error('\nBundle size check failed.');
    console.error(
      `- Extension raw JS assets grew by ${extensionRawDelta}B (threshold ${extension.growthThresholdBytes}B).`
    );
    process.exit(1);
  }

  console.log('\nBundle size check passed.');
}

try {
  main();
} catch (error) {
  console.error('Bundle size check failed with an unexpected error.');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
