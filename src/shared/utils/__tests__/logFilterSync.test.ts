import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
const coreLogFilterPath = path.join(repoRoot, 'src/core/utils/logFieldFilter.ts');
const mobileLogFilterPath = path.join(repoRoot, 'mobile/src/utils/logFilter.ts');

// Why parse source text instead of importing the constants? The mobile copy is a
// DELIBERATE, security-critical duplicate of the desktop allowlist that is kept
// out of the desktop module graph on purpose (see the header of mobile/src/utils/
// logFilter.ts). Importing it would pull mobile into the desktop composite tsconfig
// (TS6307) — coupling we specifically don't want. So we compare the two files as
// text. The one rule that makes this robust: strip comments FIRST, so a quote or
// apostrophe inside a `//` comment can't be mistaken for an allowlist token. The
// previous parser skipped this and broke on "localModelProxyServer's" in a core
// comment, reporting a false drift even though the allowlists were identical.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/\/\/[^\n]*/g, ''); // line comments
}

function extractAllowlistFields(source: string, constantName: string): string[] {
  const withoutComments = stripComments(source);
  const setMatch = withoutComments.match(
    new RegExp(`export const ${constantName}: ReadonlySet<string> = new Set\\(\\[([\\s\\S]*?)\\]\\);`),
  );

  if (!setMatch) {
    throw new Error(`Could not find ${constantName} in log filter source.`);
  }

  // Match single- or double-quoted string literals; comments are already gone.
  const body = setMatch[1];
  const fields = Array.from(body.matchAll(/['"]([^'"]+)['"]/g), ([, field]) => field);
  if (fields.length === 0) {
    throw new Error(`Parsed an empty allowlist for ${constantName} — the extraction regex likely needs updating.`);
  }

  // Reject any NON-LITERAL token in the Set body. The extractor only sees quoted
  // literals, so a spread / computed entry (e.g. `...DESKTOP_ONLY_FIELDS`) would be
  // silently skipped — letting one surface gain a runtime allowlist field the parity
  // check never compares (a FALSE GREEN on a privacy gate). After removing the quoted
  // strings, commas and whitespace, anything left is a non-literal entry: fail loud so
  // the allowlist stays a flat list of string literals (or the extractor is updated).
  const residue = body.replace(/['"][^'"]+['"]/g, '').replace(/[\s,]+/g, '');
  if (residue.length > 0) {
    throw new Error(
      `Non-literal token(s) in ${constantName} Set body: ${JSON.stringify(residue)}. ` +
        `This parity check only understands string literals — keep the allowlist a flat list ` +
        `of quoted strings (no spreads / computed entries), or update the extractor.`,
    );
  }
  return fields;
}

function readAllowlists(filePath: string) {
  const source = fs.readFileSync(filePath, 'utf8');
  return {
    safeFields: extractAllowlistFields(source, 'SAFE_LOG_FIELDS'),
    sanitizedFields: extractAllowlistFields(source, 'SANITIZED_LOG_FIELDS'),
  };
}

// Set equality (order-independent): the allowlist is a membership gate, so what
// matters is the set of fields, not declaration order.
const sortedUnique = (fields: string[]): string[] => [...new Set(fields)].sort();

describe('log filter allowlists stay in sync across desktop and mobile', () => {
  it('keeps SAFE_LOG_FIELDS in sync', () => {
    const core = readAllowlists(coreLogFilterPath);
    const mobile = readAllowlists(mobileLogFilterPath);

    expect(sortedUnique(mobile.safeFields)).toEqual(sortedUnique(core.safeFields));
  });

  it('keeps SANITIZED_LOG_FIELDS in sync', () => {
    const core = readAllowlists(coreLogFilterPath);
    const mobile = readAllowlists(mobileLogFilterPath);

    expect(sortedUnique(mobile.sanitizedFields)).toEqual(sortedUnique(core.sanitizedFields));
  });
});
