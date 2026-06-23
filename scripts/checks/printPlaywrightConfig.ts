/**
 * Prints a Playwright config's test-discovery surface as JSON (for the
 * orphaned-tests guard). MUST run in its own subprocess per config:
 * `@playwright/test` has a require-once singleton guard, so the root config
 * (root node_modules copy) and web-companion's config (its own copy) cannot
 * both be imported into one process — see checkOrphanedTests.ts.
 *
 * Usage: tsx scripts/checks/printPlaywrightConfig.ts <abs-config-path>
 */
import { pathToFileURL } from 'node:url';

export type SerializedPattern = string | { readonly regexSource: string; readonly regexFlags: string };

export interface SerializedPlaywrightProject {
  readonly testDir?: string;
  readonly testMatch?: readonly SerializedPattern[];
  readonly testIgnore?: readonly SerializedPattern[];
}

export interface SerializedPlaywrightConfig extends SerializedPlaywrightProject {
  readonly projects: readonly SerializedPlaywrightProject[];
}

type RawPattern = string | RegExp | readonly (string | RegExp)[] | undefined;

function serializePatterns(value: RawPattern): readonly SerializedPattern[] | undefined {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value as string | RegExp];
  return list.map((pattern) =>
    pattern instanceof RegExp ? { regexSource: pattern.source, regexFlags: pattern.flags } : pattern,
  );
}

interface RawProject {
  testDir?: string;
  testMatch?: RawPattern;
  testIgnore?: RawPattern;
}

function serializeProject(project: RawProject): SerializedPlaywrightProject {
  return {
    testDir: project.testDir,
    testMatch: serializePatterns(project.testMatch),
    testIgnore: serializePatterns(project.testIgnore),
  };
}

async function main(): Promise<void> {
  const configAbs = process.argv[2];
  if (!configAbs) throw new Error('usage: tsx scripts/checks/printPlaywrightConfig.ts <abs-config-path>');
  const mod = (await import(pathToFileURL(configAbs).href)) as { default?: unknown };
  let config: unknown = mod.default;
  if (typeof config === 'function') config = await (config as () => unknown)();
  const raw = config as RawProject & { projects?: readonly RawProject[] };
  const serialized: SerializedPlaywrightConfig = {
    ...serializeProject(raw),
    projects: (raw.projects ?? []).map(serializeProject),
  };
  process.stdout.write(JSON.stringify(serialized));
}

main().catch((error) => {
  process.stderr.write(String(error?.toString?.() ?? error));
  process.exit(1);
});
