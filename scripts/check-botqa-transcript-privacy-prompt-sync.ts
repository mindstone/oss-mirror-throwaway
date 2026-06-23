#!/usr/bin/env -S npx tsx --tsconfig tsconfig.node.json

/**
 * CI Validation: BotQA transcript privacy-guard prompt synchronization
 *
 * The `answerFromTranscript()` production prompt
 * (src/main/services/meetingBot/botQAService.ts) and the eval reproduction
 * prompt `buildTranscriptPrompt()` (evals/botqa-transcript.ts) BOTH carry a
 * "- Privacy guard:" bullet enumerating 6 sensitive-content categories
 * (salary, performance, medical, personal contact, confidential deals,
 * termination) and a fixed redirect template. If the two drift, the eval
 * silently stops reproducing production behavior — a false negative in the
 * privacy safety net (the 260504 botqa privacy design-gap postmortem).
 *
 * Until now the only thing keeping them in lock-step was a human-process
 * `PRIVACY-GUARD` comment. This gate replaces that with static enforcement:
 * extract the privacy bullet from both files, normalize the `${ownerName}`
 * interpolation, and assert the normalized text is identical.
 *
 * Run: npx tsx scripts/check-botqa-transcript-privacy-prompt-sync.ts
 * Wired into: npm run validate:fast (validate:botqa-privacy-prompt-sync)
 *
 * @see docs/plans/260614_recs8-ci-gates/PLAN.md
 * @see docs-private/postmortems/260504_botqa_transcript_privacy_guard_design_gap_postmortem.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const PRODUCTION_PATH = path.join(REPO_ROOT, 'src/main/services/meetingBot/botQAService.ts');
const EVAL_PATH = path.join(REPO_ROOT, 'evals/botqa-transcript.ts');

/** The 6 privacy categories that must remain present in the bullet. */
export const REQUIRED_PRIVACY_CATEGORIES = [
  'salary',
  'performance',
  'medical',
  'personal contact',
  'confidential deals',
  'termination',
] as const;

export interface PromptSyncResult {
  readonly exitCode: 0 | 1;
  readonly errors: readonly string[];
  readonly output: readonly string[];
}

/**
 * Extract the "- Privacy guard:" bullet from a prompt template literal.
 * The bullet runs from `- Privacy guard:` to the end of the template literal
 * (the bullet is intentionally the last instruction, terminated by the closing
 * backtick of the template literal). Returns null if not found.
 */
export function extractPrivacyBullet(source: string): string | null {
  const startIdx = source.indexOf('- Privacy guard:');
  if (startIdx === -1) return null;
  // The bullet ends at the closing backtick of the template literal.
  const backtickIdx = source.indexOf('`', startIdx);
  const end = backtickIdx === -1 ? source.length : backtickIdx;
  return source.slice(startIdx, end).trim();
}

/**
 * Normalize a privacy bullet for comparison: collapse the `${ownerName}`
 * interpolation (and any whitespace runs) so the production prompt and the eval
 * reproduction compare equal modulo template-variable interpolation.
 */
export function normalizePrivacyBullet(bullet: string): string {
  return bullet
    .replace(/\$\{ownerName\}/g, '<OWNER>')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface PromptSyncDeps {
  productionSource: string;
  evalSource: string;
}

export function analyzePrivacyPromptSync(deps: PromptSyncDeps): PromptSyncResult {
  const errors: string[] = [];
  const output: string[] = [];

  const prodBullet = extractPrivacyBullet(deps.productionSource);
  const evalBullet = extractPrivacyBullet(deps.evalSource);

  if (prodBullet === null) {
    errors.push(
      'Production prompt (botQAService.ts answerFromTranscript) is missing the "- Privacy guard:" bullet. Removing it leaks sensitive transcript content in live meetings.',
    );
  }
  if (evalBullet === null) {
    errors.push(
      'Eval reproduction (evals/botqa-transcript.ts buildTranscriptPrompt) is missing the "- Privacy guard:" bullet. The eval no longer reproduces production privacy behavior — a false negative in the safety net.',
    );
  }

  if (prodBullet !== null && evalBullet !== null) {
    const prodNorm = normalizePrivacyBullet(prodBullet);
    const evalNorm = normalizePrivacyBullet(evalBullet);
    if (prodNorm !== evalNorm) {
      errors.push(
        'Privacy-guard bullet drift: the production and eval prompts differ (modulo ${ownerName} interpolation). Re-sync them and re-run the botqa-transcript privacy eval.\n' +
          `      production: ${prodNorm}\n` +
          `      eval:       ${evalNorm}`,
      );
    }

    // Defense in depth: the 6 categories must survive in both bullets.
    for (const bulletName of ['production', 'eval'] as const) {
      const norm = bulletName === 'production' ? prodNorm : evalNorm;
      for (const category of REQUIRED_PRIVACY_CATEGORIES) {
        if (!norm.toLowerCase().includes(category)) {
          errors.push(
            `Privacy-guard bullet (${bulletName}) is missing required category "${category}". The 6 categories are load-bearing safety contracts; do not silently drop one.`,
          );
        }
      }
    }
  }

  if (errors.length > 0) {
    output.push(`✗ BotQA privacy-guard prompt sync: ${errors.length} error(s)`);
    for (const e of errors) output.push(`  - ${e}`);
    return { exitCode: 1, errors, output };
  }

  output.push('✓ BotQA privacy-guard prompt sync: production and eval prompts are in lock-step (6 categories present)');
  return { exitCode: 0, errors, output };
}

function createFsDeps(): PromptSyncDeps {
  return {
    productionSource: fs.readFileSync(PRODUCTION_PATH, 'utf8'),
    evalSource: fs.readFileSync(EVAL_PATH, 'utf8'),
  };
}

if (!process.env.VITEST) {
  let result: PromptSyncResult;
  try {
    result = analyzePrivacyPromptSync(createFsDeps());
  } catch (error) {
    console.error('[check-botqa-transcript-privacy-prompt-sync] fatal:', error);
    process.exit(1);
  }
  for (const line of result.output) {
    if (result.exitCode === 0) console.log(line);
    else console.error(line);
  }
  process.exit(result.exitCode);
}
