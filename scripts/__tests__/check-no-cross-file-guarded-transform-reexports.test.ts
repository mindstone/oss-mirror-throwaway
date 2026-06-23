/**
 * Unit tests for the cross-file re-export tripwire.
 *
 * Tests the pure `findGuardedTransformReexports()` detection function
 * against various re-export patterns to ensure the CI rule:
 *   - Catches re-exports with and without trailing semicolons
 *     (Prettier defaults to `semi: true`).
 *   - Catches alias forms in either direction.
 *   - Strips comments before matching (commented-out re-exports are not
 *     flagged).
 *   - Allows the legitimate location (packages/shared/**, where the symbol
 *     lives) — though the file-collection pass already excludes it; this
 *     suite exercises the pure detector.
 *
 * @see scripts/check-no-cross-file-guarded-transform-reexports.ts
 * @see docs/plans/260427_r1_stage2b_factory_refactor.md
 */
import { describe, it, expect } from 'vitest';
import {
  checkMarkdownWrapperPolicyInSources,
  collectMarkdownWrapperSources,
  findMarkdownWrapperPolicyViolations,
  findGuardedTransformReexports,
  type Violation,
} from '../check-no-cross-file-guarded-transform-reexports';

const FILE = 'src/renderer/utils/example.ts';
const ALLOWED_FILE = 'packages/shared/src/index.ts';

function rules(violations: Violation[]): string[] {
  return violations.map((v) => v.rule);
}

describe('findGuardedTransformReexports', () => {
  // ---- Plain re-exports from another module ----

  it('detects re-export from another module without semicolon', () => {
    const source = `export { createGuardedUrlTransform } from '@rebel/shared'`;
    const violations = findGuardedTransformReexports(source, FILE);
    expect(violations).toHaveLength(1);
    expect(rules(violations)).toContain('no-cross-file-guarded-transform-reexport');
  });

  it('detects re-export from another module with trailing semicolon', () => {
    const source = `export { createGuardedUrlTransform } from '@rebel/shared';`;
    const violations = findGuardedTransformReexports(source, FILE);
    expect(violations).toHaveLength(1);
    expect(rules(violations)).toContain('no-cross-file-guarded-transform-reexport');
  });

  // ---- Local-scope re-exports (no `from`) ----

  it('detects local-scope re-export without semicolon', () => {
    const source = [
      `import { createGuardedUrlTransform } from '@rebel/shared'`,
      `export { createGuardedUrlTransform }`,
    ].join('\n');
    const violations = findGuardedTransformReexports(source, FILE);
    // Exactly one re-export violation (the import alone is not a re-export).
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(2);
  });

  it('detects local-scope re-export with trailing semicolon', () => {
    const source = `export { createGuardedUrlTransform };`;
    const violations = findGuardedTransformReexports(source, FILE);
    expect(violations).toHaveLength(1);
  });

  // ---- Alias forms ----

  it('detects aliased re-export (createGuardedUrlTransform as guard)', () => {
    const source = `export { createGuardedUrlTransform as guard } from '@rebel/shared';`;
    const violations = findGuardedTransformReexports(source, FILE);
    expect(violations).toHaveLength(1);
  });

  it('detects aliased re-export from local-scope (localGuard as createGuardedUrlTransform)', () => {
    const source = [
      `const localGuard = (u: string) => u;`,
      `export { localGuard as createGuardedUrlTransform };`,
    ].join('\n');
    const violations = findGuardedTransformReexports(source, FILE);
    expect(violations).toHaveLength(1);
  });

  // ---- Re-exports from cloud-client (sibling surface) ----

  it('detects re-export in cloud-client/src/...', () => {
    const source = `export { createGuardedUrlTransform } from '@rebel/shared';`;
    const violations = findGuardedTransformReexports(
      source,
      'cloud-client/src/markdown/index.ts',
    );
    expect(violations).toHaveLength(1);
  });

  // ---- Comment handling (must NOT flag) ----

  it('does not flag a // line-commented re-export', () => {
    const source = [
      `// Old API:`,
      `// export { createGuardedUrlTransform } from '@rebel/shared';`,
      `// Replaced 2026-04-27 by closed-API SafeWebMarkdown`,
    ].join('\n');
    const violations = findGuardedTransformReexports(source, FILE);
    expect(violations).toHaveLength(0);
  });

  it('does not flag a /* block-commented */ re-export', () => {
    const source = [
      `/*`,
      ` * Removed in R1 Stage 2b:`,
      ` * export { createGuardedUrlTransform } from '@rebel/shared';`,
      ` */`,
      `export const ok = 1;`,
    ].join('\n');
    const violations = findGuardedTransformReexports(source, FILE);
    expect(violations).toHaveLength(0);
  });

  // ---- Allowed cases (no violation expected) ----

  it('does not flag a plain import (not a re-export)', () => {
    const source = `import { createGuardedUrlTransform } from '@rebel/shared';`;
    const violations = findGuardedTransformReexports(source, FILE);
    expect(violations).toHaveLength(0);
  });

  it('does not flag a string mention of the symbol', () => {
    const source = `const msg = "createGuardedUrlTransform is closed-API";`;
    const violations = findGuardedTransformReexports(source, FILE);
    expect(violations).toHaveLength(0);
  });

  it('does not flag re-export of unrelated symbols from same module', () => {
    const source = `export { findBlockedUrlScheme } from '@rebel/shared';`;
    const violations = findGuardedTransformReexports(source, FILE);
    expect(violations).toHaveLength(0);
  });

  // ---- The pure detector treats all files alike — file-level allowlist
  //      is enforced by collectScanFiles() (excluding packages/shared/**),
  //      so the detector flags ALLOWED_FILE too if it happens to scan it.
  //      The test below documents this design.
  it('the pure detector flags re-exports anywhere — file-level allowlist is in collectScanFiles', () => {
    const source = `export { createGuardedUrlTransform } from './utils/urlSchemePolicy';`;
    const violations = findGuardedTransformReexports(source, ALLOWED_FILE);
    expect(violations).toHaveLength(1);
  });

  // ---- Multi-line / structured re-exports (out of single-line scope) ----

  it('does not catch multi-line re-export (acknowledged limitation)', () => {
    // The single-line regex doesn't span line breaks; if Prettier ever
    // reformats a long re-export across lines, this would slip through.
    // Acknowledged in the script's documentation; not a current concern
    // because Prettier keeps named-export braces on one line for ≤4
    // members.
    const source = [
      `export {`,
      `  createGuardedUrlTransform`,
      `} from '@rebel/shared';`,
    ].join('\n');
    const violations = findGuardedTransformReexports(source, FILE);
    expect(violations).toHaveLength(0);
  });
});

describe('markdown wrapper policy check', () => {
  it('passes on the current refactored wrapper sources', () => {
    const violations = checkMarkdownWrapperPolicyInSources(
      collectMarkdownWrapperSources(process.cwd()),
    );

    expect(violations).toEqual([]);
  });

  it('fails an un-guarded, non-inert ReactMarkdown block without a PARITY-EXEMPT marker', () => {
    const source = [
      `import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';`,
      `import { createGuardedUrlTransform, findBlockedUrlScheme } from '@rebel/shared';`,
      `const guardedUrlTransform = createGuardedUrlTransform(defaultUrlTransform);`,
      `export function SafeMarkdown({ children }: { children: string }) {`,
      `  return (`,
      `    <ReactMarkdown`,
      `      components={{`,
      `        a: ({ href, children }) => <a href={href}>{children}</a>,`,
      `        img: ({ src }) => { findBlockedUrlScheme(src); findBlockedUrlScheme(href); return <img src={src} />; },`,
      `      }}`,
      `    >`,
      `      {children}`,
      `    </ReactMarkdown>`,
      `  );`,
      `}`,
    ].join('\n');

    const violations = findMarkdownWrapperPolicyViolations(
      source,
      'src/renderer/components/SafeMarkdown.tsx',
    );

    expect(rules(violations)).toContain(
      'markdown-wrapper-react-markdown-must-be-guarded-or-inert',
    );
  });

  it('sanctions an un-guarded, non-inert ReactMarkdown block with a PARITY-EXEMPT marker', () => {
    const source = [
      `import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';`,
      `import { createGuardedUrlTransform, findBlockedUrlScheme } from '@rebel/shared';`,
      `const guardedUrlTransform = createGuardedUrlTransform(defaultUrlTransform);`,
      `export function SafeMarkdown({ children }: { children: string }) {`,
      `  return (`,
      `    // PARITY-EXEMPT: deliberately renders raw href for the trusted preview slot`,
      `    <ReactMarkdown`,
      `      components={{`,
      `        a: ({ href, children }) => <a href={href}>{children}</a>,`,
      `        img: ({ src }) => { findBlockedUrlScheme(src); findBlockedUrlScheme(href); return <img src={src} />; },`,
      `      }}`,
      `    >`,
      `      {children}`,
      `    </ReactMarkdown>`,
      `  );`,
      `}`,
    ].join('\n');

    const violations = findMarkdownWrapperPolicyViolations(
      source,
      'src/renderer/components/SafeMarkdown.tsx',
    );

    expect(rules(violations)).not.toContain(
      'markdown-wrapper-react-markdown-must-be-guarded-or-inert',
    );
  });

  it('a bare PARITY-EXEMPT marker with no reason does NOT sanction the divergence', () => {
    const source = [
      `import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';`,
      `import { createGuardedUrlTransform, findBlockedUrlScheme } from '@rebel/shared';`,
      `const guardedUrlTransform = createGuardedUrlTransform(defaultUrlTransform);`,
      `export function SafeMarkdown({ children }: { children: string }) {`,
      `  return (`,
      `    // PARITY-EXEMPT:`,
      `    <ReactMarkdown`,
      `      components={{`,
      `        a: ({ href, children }) => <a href={href}>{children}</a>,`,
      `        img: ({ src }) => { findBlockedUrlScheme(src); findBlockedUrlScheme(href); return <img src={src} />; },`,
      `      }}`,
      `    >`,
      `      {children}`,
      `    </ReactMarkdown>`,
      `  );`,
      `}`,
    ].join('\n');

    const violations = findMarkdownWrapperPolicyViolations(
      source,
      'src/renderer/components/SafeMarkdown.tsx',
    );

    expect(rules(violations)).toContain(
      'markdown-wrapper-react-markdown-must-be-guarded-or-inert',
    );
  });

  it('a PARITY-EXEMPT marker above an earlier sibling does NOT leak to a later unguarded block', () => {
    const source = [
      `import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';`,
      `import { createGuardedUrlTransform, findBlockedUrlScheme } from '@rebel/shared';`,
      `const guardedUrlTransform = createGuardedUrlTransform(defaultUrlTransform);`,
      `export function SafeMarkdown({ children }: { children: string }) {`,
      `  findBlockedUrlScheme(children); findBlockedUrlScheme(href);`,
      `  const first = (`,
      `    // PARITY-EXEMPT: this sanctions ONLY the first block directly below`,
      `    <ReactMarkdown components={{ a: ({ href, children }) => <a href={href}>{children}</a> }}>`,
      `      {children}`,
      `    </ReactMarkdown>`,
      `  );`,
      `  const second = (`,
      `    <ReactMarkdown components={{ a: ({ href, children }) => <a href={href}>{children}</a> }}>`,
      `      {children}`,
      `    </ReactMarkdown>`,
      `  );`,
      `  return <>{first}{second}</>;`,
      `}`,
    ].join('\n');

    const violations = findMarkdownWrapperPolicyViolations(
      source,
      'src/renderer/components/SafeMarkdown.tsx',
    );

    // Exactly one guarded-or-inert violation: the SECOND (later) block. The
    // first is sanctioned by the marker directly above it; the marker must NOT
    // leak down to the second (whose only preceding line is `const second = (`).
    const blockViolations = violations.filter(
      (v) => v.rule === 'markdown-wrapper-react-markdown-must-be-guarded-or-inert',
    );
    expect(blockViolations).toHaveLength(1);
  });

  it('a PARITY-EXEMPT substring inside a string literal does NOT sanction the block', () => {
    const source = [
      `import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';`,
      `import { createGuardedUrlTransform, findBlockedUrlScheme } from '@rebel/shared';`,
      `const guardedUrlTransform = createGuardedUrlTransform(defaultUrlTransform);`,
      `export function SafeMarkdown({ children }: { children: string }) {`,
      `  const note = "PARITY-EXEMPT: not a real comment";`,
      `  return (`,
      `    <ReactMarkdown`,
      `      components={{`,
      `        a: ({ href, children }) => <a href={href}>{children}</a>,`,
      `        img: ({ src }) => { findBlockedUrlScheme(src); findBlockedUrlScheme(href); return <img src={src} />; },`,
      `      }}`,
      `    >`,
      `      {children}`,
      `    </ReactMarkdown>`,
      `  );`,
      `}`,
    ].join('\n');

    const violations = findMarkdownWrapperPolicyViolations(
      source,
      'src/renderer/components/SafeMarkdown.tsx',
    );

    expect(rules(violations)).toContain(
      'markdown-wrapper-react-markdown-must-be-guarded-or-inert',
    );
  });

  it('fails when a wrapper hand-rolls a local javascript scheme predicate', () => {
    const source = [
      `import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';`,
      `import { createGuardedUrlTransform } from '@rebel/shared';`,
      `const guardedUrlTransform = createGuardedUrlTransform(defaultUrlTransform);`,
      `function isBlockedSchemeLink(href?: string): boolean {`,
      `  return /^javascript:/i.test(href ?? '');`,
      `}`,
      `export function SafeMarkdown({ children }: { children: string }) {`,
      `  return (`,
      `    <ReactMarkdown`,
      `      urlTransform={guardedUrlTransform}`,
      `      components={{`,
      `        a: ({ href, children }) => isBlockedSchemeLink(href) ? <a>{children}</a> : <a href={href}>{children}</a>,`,
      `        img: ({ src, alt }) => <img src={src} alt={alt} />,`,
      `      }}`,
      `    >`,
      `      {children}`,
      `    </ReactMarkdown>`,
      `  );`,
      `}`,
    ].join('\n');

    const violations = findMarkdownWrapperPolicyViolations(
      source,
      'src/renderer/components/SafeMarkdown.tsx',
    );

    expect(rules(violations)).toContain('no-local-markdown-scheme-predicate');
  });
});
