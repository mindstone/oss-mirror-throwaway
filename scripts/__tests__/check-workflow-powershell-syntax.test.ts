import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { STEPS } from '../run-validate-fast';
import {
  checkWorkflowPowershellSyntax,
  scanScript,
} from '../check-workflow-powershell-syntax';

const STEP_NAME = 'validate:workflow-powershell-syntax';
const TARGET_COMMAND = 'npx tsx scripts/check-workflow-powershell-syntax.ts';

function readPackageJson(): { scripts?: Record<string, string> } {
  const path = join(__dirname, '..', '..', 'package.json');
  return JSON.parse(readFileSync(path, 'utf8')) as { scripts?: Record<string, string> };
}

describe('check-workflow-powershell-syntax', () => {
  it('flags the $Var: scope-qualifier parse-error gotcha', () => {
    // The exact line that shipped in fdb76a7a1 and broke every Windows beta build.
    const bad =
      'Write-Warning "$Operation failed on attempt $attempt/$Attempts: $($_.Exception.Message)"';
    const hits = scanScript(bad);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.token).toBe('$Attempts:');
  });

  it('accepts the ${Var}: delimited fix', () => {
    const good =
      'Write-Warning "$Operation failed on attempt $attempt/${Attempts}: $($_.Exception.Message)"';
    expect(scanScript(good)).toEqual([]);
  });

  it('does not flag valid scope/namespace variable references', () => {
    // $env:, $global:, $script: etc. are valid because the colon is followed by a name char.
    const valid =
      'Write-Output "$env:PATH | $global:foo | $script:bar"; [math]::Pow(2, $attempt)';
    expect(scanScript(valid)).toEqual([]);
  });

  it('catches the colon-before-$ and colon-before-quote variants', () => {
    expect(scanScript('"$x:$y"')).toHaveLength(1); // colon before $
    expect(scanScript('"prefix $count:"')).toHaveLength(1); // colon before end-quote
  });

  it('ignores the pattern inside full-line comments', () => {
    expect(scanScript('# note: $Attempts: is fine in a comment')).toEqual([]);
  });

  it('does not flag $_ member access or $(...) subexpressions', () => {
    expect(scanScript('$($_.Exception.Message)')).toEqual([]);
  });

  it('passes on the real repository workflows (regression guard)', () => {
    const { violations, scannedSteps } = checkWorkflowPowershellSyntax();
    // We must actually be scanning pwsh steps, else the guard is vacuous.
    expect(scannedSteps).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it('is wired into the validate:fast step list', () => {
    const step = STEPS.find((s) => s.name === STEP_NAME);
    expect(step, `${STEP_NAME} must be registered in run-validate-fast.ts STEPS`).toBeDefined();
  });

  it('has a package.json script entry', () => {
    const pkg = readPackageJson();
    const entry = pkg.scripts?.['validate:workflow-powershell-syntax'];
    expect(entry).toBe(TARGET_COMMAND);
  });
});
