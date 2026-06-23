import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { scanEvalSelfExecutionGuards } from '../check-no-legacy-eval-tokens';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function scanFixture(relPath: string, source: string) {
  return scanEvalSelfExecutionGuards(path.join(REPO_ROOT, relPath), source);
}

describe('check-no-legacy-eval-tokens static eval self-execution guard', () => {
  it('flags an unguarded top-level main().catch call', () => {
    const matches = scanFixture('evals/new-harness.ts', 'main().catch(console.error);');

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      file: 'evals/new-harness.ts',
      line: 1,
      code: 'main().catch(console.error);',
    });
  });

  it('allows main().catch inside an isMainEntrypoint guard', () => {
    const matches = scanFixture(
      'evals/new-harness.ts',
      [
        'if (isMainEntrypoint(import.meta.url)) {',
        '  main().catch(err => process.exit(1));',
        '}',
      ].join('\n'),
    );

    expect(matches).toEqual([]);
  });

  it('allows intentional self-execution for allow-listed paths', () => {
    const matches = scanFixture('evals/run.ts', 'main().catch(console.error);');

    expect(matches).toEqual([]);
  });

  it('flags a bare top-level main() call', () => {
    const matches = scanFixture('evals/new-harness.ts', 'main();');

    expect(matches).toHaveLength(1);
    expect(matches[0]?.code).toBe('main();');
  });

  it('flags a top-level await main() call', () => {
    const matches = scanFixture('evals/new-harness.ts', 'await main()');

    expect(matches).toHaveLength(1);
    expect(matches[0]?.code).toBe('await main()');
  });

  it('ignores comment-only references to main().catch', () => {
    const matches = scanFixture('evals/new-harness.ts', '// main().catch(console.error);');

    expect(matches).toEqual([]);
  });

  it('ignores indented main().catch calls', () => {
    const matches = scanFixture('evals/new-harness.ts', '  main().catch(console.error);');

    expect(matches).toEqual([]);
  });

  it('flags a top-level main(opts).catch call', () => {
    const matches = scanFixture('evals/new-harness.ts', 'main(opts).catch(handler);');

    expect(matches).toHaveLength(1);
    expect(matches[0]?.code).toBe('main(opts).catch(handler);');
  });
});
