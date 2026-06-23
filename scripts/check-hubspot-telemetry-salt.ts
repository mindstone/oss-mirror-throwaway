#!/usr/bin/env npx tsx
/**
 * Static regression guard for HubSpot OSS telemetry salt host-env assembly.
 *
 * WHY: postmortem rec #44 (fingerprint 3a61ad642fe45bfb) from
 * 260531_inject_hubspot_telemetry_salt_into_oss_8f909f0 found that the
 * HubSpot OSS connector fails closed to a `[salt-missing]` telemetry sentinel
 * when the host forgets to inject HUBSPOT_TELEMETRY_SALT. Runtime injection is
 * unit-tested, but a later edit could silently remove one spawn/catalog path.
 *
 * Heuristic: this narrow check reads the two host-env assembly files and treats
 * HUBSPOT_SOURCE_LABEL as the marker for a HubSpot OSS env assembly. There are
 * exactly three such assignments today. Every one must have a
 * HUBSPOT_TELEMETRY_SALT assignment within a small local line window, and the
 * three known structural markers must still contain both assignments in their
 * local region. This is intentionally text-based, not a semantic TypeScript
 * proof: it catches the regression class we care about (dropping the salt line)
 * and fails closed if a new HubSpot env site appears or the code structure
 * changes enough that the marker set needs maintenance.
 *
 * Run via: npx tsx scripts/check-hubspot-telemetry-salt.ts
 * Part of validate:fast pipeline.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const HUBSPOT_ENV_ASSEMBLY_FILES = [
  'src/main/services/bundledMcpManager.ts',
  'src/main/services/bundledMcpCloudRegistration.ts',
] as const;

const EXPECTED_SOURCE_LABEL_ASSIGNMENT_COUNT = 3;
const EXPECTED_SALT_ASSIGNMENT_COUNT = 3;
const PAIRING_WINDOW_LINES = 12;

const SOURCE_LABEL_ASSIGNMENT = /\bHUBSPOT_SOURCE_LABEL\b\s*[:=]/;
const SALT_ASSIGNMENT = /\bHUBSPOT_TELEMETRY_SALT\b\s*[:=]/;

interface SourceFileText {
  readonly relPath: string;
  readonly source: string;
}

interface HubSpotAssemblyMarker {
  readonly name: string;
  readonly relPath: typeof HUBSPOT_ENV_ASSEMBLY_FILES[number];
  readonly marker: string;
  readonly searchBeforeChars?: number;
  readonly searchAfterChars: number;
  readonly sourceLabelPattern: RegExp;
  readonly saltPattern: RegExp;
}

export interface AssignmentOccurrence {
  readonly relPath: string;
  readonly line: number;
  readonly text: string;
}

export interface HubSpotTelemetrySaltCheckResult {
  readonly ok: boolean;
  readonly errors: string[];
  readonly sourceLabelAssignments: AssignmentOccurrence[];
  readonly saltAssignments: AssignmentOccurrence[];
}

const HUBSPOT_ASSEMBLY_MARKERS: readonly HubSpotAssemblyMarker[] = [
  {
    name: 'buildPayloadFromCatalog rebel-oss HubSpot env block',
    relPath: 'src/main/services/bundledMcpManager.ts',
    marker: "catalogEntry.provider === 'rebel-oss' && effectiveServerName === 'HubSpot'",
    searchAfterChars: 2_500,
    sourceLabelPattern: /\benv\.HUBSPOT_SOURCE_LABEL\s*=/,
    saltPattern: /\benv\.HUBSPOT_TELEMETRY_SALT\s*=/,
  },
  {
    name: 'migrateBundledConnectorsToNpx HubSpot finalEnv block',
    relPath: 'src/main/services/bundledMcpManager.ts',
    marker: "finalEnv.HUBSPOT_SOURCE_LABEL = finalEnv.HUBSPOT_SOURCE_LABEL || 'Mindstone Rebel';",
    searchBeforeChars: 800,
    searchAfterChars: 800,
    sourceLabelPattern: /\bfinalEnv\.HUBSPOT_SOURCE_LABEL\s*=/,
    saltPattern: /\bfinalEnv\.HUBSPOT_TELEMETRY_SALT\s*=/,
  },
  {
    name: 'discoverHubSpot cloud registration env literal',
    relPath: 'src/main/services/bundledMcpCloudRegistration.ts',
    marker: 'async function discoverHubSpot',
    searchAfterChars: 5_500,
    sourceLabelPattern: /\bHUBSPOT_SOURCE_LABEL\s*:/,
    saltPattern: /\bHUBSPOT_TELEMETRY_SALT\s*:/,
  },
];

function findAssignments(relPath: string, source: string, pattern: RegExp): AssignmentOccurrence[] {
  return source
    .split(/\r?\n/)
    .map((lineText, index): AssignmentOccurrence | undefined => {
      if (!pattern.test(lineText)) return undefined;
      return {
        relPath,
        line: index + 1,
        text: lineText.trim(),
      };
    })
    .filter((occurrence): occurrence is AssignmentOccurrence => occurrence !== undefined);
}

function readTargetFiles(repoRoot: string): { files: SourceFileText[]; errors: string[] } {
  const files: SourceFileText[] = [];
  const errors: string[] = [];

  for (const relPath of HUBSPOT_ENV_ASSEMBLY_FILES) {
    const absPath = join(repoRoot, relPath);
    if (!existsSync(absPath)) {
      errors.push(
        `${relPath} is missing. HubSpot env assembly moved; update scripts/check-hubspot-telemetry-salt.ts.`,
      );
      continue;
    }

    try {
      files.push({
        relPath,
        source: readFileSync(absPath, 'utf8'),
      });
    } catch (error) {
      errors.push(
        `Could not read ${relPath}: ${error instanceof Error ? error.message : String(error)}. ` +
          'Update or fix scripts/check-hubspot-telemetry-salt.ts.',
      );
    }
  }

  return { files, errors };
}

function localWindowForLine(source: string, oneBasedLine: number): string {
  const lines = source.split(/\r?\n/);
  const start = Math.max(0, oneBasedLine - 1 - PAIRING_WINDOW_LINES);
  const end = Math.min(lines.length, oneBasedLine + PAIRING_WINDOW_LINES);
  return lines.slice(start, end).join('\n');
}

function validateSourceLabelPairing(files: readonly SourceFileText[]): string[] {
  const errors: string[] = [];
  const sourceLabelAssignments = files.flatMap((file) => (
    findAssignments(file.relPath, file.source, SOURCE_LABEL_ASSIGNMENT)
  ));
  const saltAssignments = files.flatMap((file) => (
    findAssignments(file.relPath, file.source, SALT_ASSIGNMENT)
  ));

  if (sourceLabelAssignments.length !== EXPECTED_SOURCE_LABEL_ASSIGNMENT_COUNT) {
    errors.push(
      `Expected exactly ${EXPECTED_SOURCE_LABEL_ASSIGNMENT_COUNT} HUBSPOT_SOURCE_LABEL env assignments ` +
        `across HubSpot host-env files, found ${sourceLabelAssignments.length}. If a HubSpot env ` +
        'assembly site was added, removed, or moved, update this guard and ensure each site injects ' +
        'HUBSPOT_TELEMETRY_SALT.',
    );
  }

  if (saltAssignments.length !== EXPECTED_SALT_ASSIGNMENT_COUNT) {
    errors.push(
      `Expected exactly ${EXPECTED_SALT_ASSIGNMENT_COUNT} HUBSPOT_TELEMETRY_SALT env assignments ` +
        `across HubSpot host-env files, found ${saltAssignments.length}. A missing assignment would ` +
        'make the HubSpot OSS package emit the [salt-missing] telemetry sentinel.',
    );
  }

  const byRelPath = new Map(files.map((file) => [file.relPath, file.source] as const));
  for (const sourceLabel of sourceLabelAssignments) {
    const source = byRelPath.get(sourceLabel.relPath);
    if (!source) continue;

    const windowText = localWindowForLine(source, sourceLabel.line);
    if (!SALT_ASSIGNMENT.test(windowText)) {
      errors.push(
        `${sourceLabel.relPath}:${sourceLabel.line} sets HUBSPOT_SOURCE_LABEL without a ` +
          `${PAIRING_WINDOW_LINES}-line-nearby HUBSPOT_TELEMETRY_SALT assignment. Add the salt ` +
          'to the same HubSpot env assembly block.',
      );
    }
  }

  return errors;
}

function validateExpectedMarkers(files: readonly SourceFileText[]): string[] {
  const errors: string[] = [];
  const byRelPath = new Map(files.map((file) => [file.relPath, file.source] as const));

  for (const expected of HUBSPOT_ASSEMBLY_MARKERS) {
    const source = byRelPath.get(expected.relPath);
    if (source === undefined) continue;

    const markerIndex = source.indexOf(expected.marker);
    if (markerIndex === -1) {
      errors.push(
        `${expected.relPath}: expected HubSpot env-assembly marker not found for ` +
          `"${expected.name}". File structure changed; update scripts/check-hubspot-telemetry-salt.ts.`,
      );
      continue;
    }

    const regionStart = Math.max(0, markerIndex - (expected.searchBeforeChars ?? 0));
    const regionEnd = Math.min(source.length, markerIndex + expected.marker.length + expected.searchAfterChars);
    const region = source.slice(regionStart, regionEnd);

    if (!expected.sourceLabelPattern.test(region)) {
      errors.push(
        `${expected.relPath}: "${expected.name}" no longer contains the expected HUBSPOT_SOURCE_LABEL ` +
          'env assignment near its marker. Update this guard if the env assembly moved.',
      );
    }
    if (!expected.saltPattern.test(region)) {
      errors.push(
        `${expected.relPath}: "${expected.name}" no longer injects HUBSPOT_TELEMETRY_SALT near its ` +
          'HubSpot env-assembly marker. Add the salt assignment back to that block.',
      );
    }
  }

  return errors;
}

export function checkHubSpotTelemetrySalt(repoRoot: string = REPO_ROOT): HubSpotTelemetrySaltCheckResult {
  const { files, errors: readErrors } = readTargetFiles(repoRoot);
  const errors = [...readErrors];

  if (files.length !== HUBSPOT_ENV_ASSEMBLY_FILES.length) {
    return {
      ok: false,
      errors,
      sourceLabelAssignments: [],
      saltAssignments: [],
    };
  }

  const combinedSource = files.map((file) => file.source).join('\n');
  if (!SOURCE_LABEL_ASSIGNMENT.test(combinedSource)) {
    errors.push(
      'No HUBSPOT_SOURCE_LABEL env assignments found in HubSpot host-env files. File structure changed; ' +
        'update scripts/check-hubspot-telemetry-salt.ts instead of passing vacuously.',
    );
  }
  if (!SALT_ASSIGNMENT.test(combinedSource)) {
    errors.push(
      'No HUBSPOT_TELEMETRY_SALT env assignments found in HubSpot host-env files. HubSpot OSS telemetry ' +
        'salt injection must be restored before this guard can pass.',
    );
  }

  errors.push(...validateSourceLabelPairing(files));
  errors.push(...validateExpectedMarkers(files));

  return {
    ok: errors.length === 0,
    errors,
    sourceLabelAssignments: files.flatMap((file) => (
      findAssignments(file.relPath, file.source, SOURCE_LABEL_ASSIGNMENT)
    )),
    saltAssignments: files.flatMap((file) => (
      findAssignments(file.relPath, file.source, SALT_ASSIGNMENT)
    )),
  };
}

function main(): void {
  console.log('HubSpot Telemetry Salt Static Check');
  console.log('===================================\n');

  const result = checkHubSpotTelemetrySalt();
  if (result.ok) {
    console.log(
      `OK: ${result.sourceLabelAssignments.length} HubSpot env assembly site(s) all include ` +
        'HUBSPOT_TELEMETRY_SALT.',
    );
    return;
  }

  console.error('FAILED: HubSpot OSS host-env assembly is missing required telemetry salt coverage.\n');
  for (const error of result.errors) {
    console.error(`- ${error}`);
  }
  console.error(
    '\nFix: add HUBSPOT_TELEMETRY_SALT to every HubSpot env assembly site, or update this guard ' +
      'if the host-env structure intentionally changed.',
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
