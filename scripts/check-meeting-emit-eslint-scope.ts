import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const RULE_ID = 'no-restricted-syntax';
const RULE_MESSAGE_FRAGMENT = 'Route saves through saveMeetingSource';
const EMIT_SELECTOR_FRAGMENT = 'emitTranscriptSaved|emitTranscriptDistributionReady|deferTranscriptSaved';

const TARGET_FIXTURES = [
  'src/main/services/meetingBot/__eslintViolationFixtures__/directEmit.ts',
  'src/main/services/meetingBot/externalProviders/__eslintViolationFixtures__/directEmit.ts',
  'src/main/services/plaud/__eslintViolationFixtures__/directEmit.ts',
  'src/main/services/physicalRecording/__eslintViolationFixtures__/directEmit.ts',
];

const KERNEL_ALLOWLIST_FILE = 'src/core/meetingSource/saveMeetingSource.ts';

function toSeverity(ruleConfig: unknown): number {
  if (typeof ruleConfig === 'number') return ruleConfig;
  if (typeof ruleConfig === 'string') {
    if (ruleConfig === 'off') return 0;
    if (ruleConfig === 'warn') return 1;
    if (ruleConfig === 'error') return 2;
    return 0;
  }
  if (Array.isArray(ruleConfig)) {
    return toSeverity(ruleConfig[0]);
  }
  return 0;
}

function hasEmitSelector(ruleConfig: unknown): boolean {
  return extractSelectors(ruleConfig).some((selector) => selector.includes(EMIT_SELECTOR_FRAGMENT));
}

function extractSelectors(ruleConfig: unknown): string[] {
  if (!Array.isArray(ruleConfig)) {
    return [];
  }

  return ruleConfig
    .slice(1)
    .flatMap((entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      'selector' in entry &&
      typeof entry.selector === 'string'
        ? [entry.selector]
        : [],
    );
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

async function getExpectedBaseSelectors(eslint: ESLint): Promise<string[]> {
  const representativePath = path.join(REPO_ROOT, TARGET_FIXTURES[0]);
  const config = await eslint.calculateConfigForFile(representativePath);
  const ruleConfig = config.rules?.[RULE_ID];

  if (toSeverity(ruleConfig) === 0) {
    throw new Error(`Rule ${RULE_ID} is disabled for representative fixture config`);
  }

  return dedupe(extractSelectors(ruleConfig).filter((selector) => !selector.includes(EMIT_SELECTOR_FRAGMENT)));
}

async function assertKernelAllowlisted(eslint: ESLint, expectedBaseSelectors: string[]): Promise<void> {
  const kernelPath = path.join(REPO_ROOT, KERNEL_ALLOWLIST_FILE);
  const config = await eslint.calculateConfigForFile(kernelPath);
  const ruleConfig = config.rules?.[RULE_ID];
  const severity = toSeverity(ruleConfig);
  if (severity !== 2) {
    throw new Error(
      `Kernel allowlist misconfigured: expected ${RULE_ID}=error for ${KERNEL_ALLOWLIST_FILE}, got ${JSON.stringify(ruleConfig)}`,
    );
  }

  if (hasEmitSelector(ruleConfig)) {
    throw new Error(`Kernel allowlist still includes emit/defer selector(s): ${KERNEL_ALLOWLIST_FILE}`);
  }

  const kernelSelectors = dedupe(extractSelectors(ruleConfig));
  const missingSelectors = expectedBaseSelectors.filter((selector) => !kernelSelectors.includes(selector));
  if (missingSelectors.length > 0) {
    throw new Error(
      `Kernel allowlist dropped ${missingSelectors.length} base selector(s). Example missing selector: ${missingSelectors[0]}`,
    );
  }
}

async function assertFixtureCovered(eslint: ESLint, fixtureRelativePath: string): Promise<void> {
  const fixturePath = path.join(REPO_ROOT, fixtureRelativePath);
  const config = await eslint.calculateConfigForFile(fixturePath);
  const ruleConfig = config.rules?.[RULE_ID];

  if (toSeverity(ruleConfig) === 0) {
    throw new Error(`Rule ${RULE_ID} is disabled for ${fixtureRelativePath}`);
  }

  if (!hasEmitSelector(ruleConfig)) {
    throw new Error(`Rule ${RULE_ID} is missing emit selector for ${fixtureRelativePath}`);
  }

  const [result] = await eslint.lintFiles([fixturePath]);
  const hasViolation = result.messages.some((message) =>
    message.ruleId === RULE_ID &&
    typeof message.message === 'string' &&
    message.message.includes(RULE_MESSAGE_FRAGMENT),
  );

  if (!hasViolation) {
    throw new Error(`Fixture ${fixtureRelativePath} did not trigger ${RULE_ID}`);
  }
}

async function main(): Promise<void> {
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: path.join(REPO_ROOT, 'eslint.config.mjs'),
    ignore: false,
    errorOnUnmatchedPattern: true,
  });

  const expectedBaseSelectors = await getExpectedBaseSelectors(eslint);
  await assertKernelAllowlisted(eslint, expectedBaseSelectors);

  for (const fixture of TARGET_FIXTURES) {
    await assertFixtureCovered(eslint, fixture);
  }

  process.stdout.write('Meeting emit ESLint scope check passed.\n');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Meeting emit ESLint scope check failed: ${message}\n`);
  process.exitCode = 1;
});
