import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../..');
const LOCAL_MAIN = '1111111111111111111111111111111111111111';
const REMOTE_MAIN = '2222222222222222222222222222222222222222';
const LOCAL_DEV = '3333333333333333333333333333333333333333';
const REMOTE_DEV = '4444444444444444444444444444444444444444';
const LOCAL_OTHER_MAIN = '5555555555555555555555555555555555555555';
const REMOTE_OTHER_MAIN = '6666666666666666666666666666666666666666';

function parsePushedMainRef(input: string): string {
  return execFileSync('sh', ['-c', '. scripts/lib/parse-pushed-main-ref.sh; parse_pushed_main_ref'], {
    input,
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('parse_pushed_main_ref', () => {
  it('detects a single refs/heads/main update', () => {
    expect(parsePushedMainRef(`refs/heads/main ${LOCAL_MAIN} refs/heads/main ${REMOTE_MAIN}\n`))
      .toBe(`1 ${LOCAL_MAIN} ${REMOTE_MAIN}\n`);
  });

  it('detects a push from another local ref to refs/heads/main', () => {
    expect(parsePushedMainRef(`HEAD ${LOCAL_MAIN} refs/heads/main ${REMOTE_MAIN}\n`))
      .toBe(`1 ${LOCAL_MAIN} ${REMOTE_MAIN}\n`);
  });

  it('ignores a refs/heads/dev-only push', () => {
    expect(parsePushedMainRef(`refs/heads/dev ${LOCAL_DEV} refs/heads/dev ${REMOTE_DEV}\n`))
      .toBe('0  \n');
  });

  it('does not match refs/heads/main-experiment', () => {
    expect(parsePushedMainRef(`refs/heads/main-experiment ${LOCAL_MAIN} refs/heads/main-experiment ${REMOTE_MAIN}\n`))
      .toBe('0  \n');
  });

  it('detects main among multiple refs', () => {
    const input = [
      `refs/heads/dev ${LOCAL_DEV} refs/heads/dev ${REMOTE_DEV}`,
      `refs/heads/main ${LOCAL_MAIN} refs/heads/main ${REMOTE_MAIN}`,
    ].join('\n');

    expect(parsePushedMainRef(`${input}\n`)).toBe(`1 ${LOCAL_MAIN} ${REMOTE_MAIN}\n`);
  });

  it('returns an empty main oid tuple for empty stdin', () => {
    expect(parsePushedMainRef('')).toBe('0  \n');
  });

  it('uses the last refs/heads/main tuple when duplicates are present', () => {
    const input = [
      `refs/heads/main ${LOCAL_MAIN} refs/heads/main ${REMOTE_MAIN}`,
      `refs/heads/main ${LOCAL_OTHER_MAIN} refs/heads/main ${REMOTE_OTHER_MAIN}`,
    ].join('\n');

    expect(parsePushedMainRef(`${input}\n`)).toBe(`1 ${LOCAL_OTHER_MAIN} ${REMOTE_OTHER_MAIN}\n`);
  });
});
