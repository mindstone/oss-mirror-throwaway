import { describe, expect, it } from 'vitest';
import { buildOwnerTagArgs, parseOwnerTagFromCmdline } from './superMcpOwnerTag';

const VALID_OWNER_ID = '11111111-1111-4111-8111-111111111111';
const VALID_OWNER_PID = 1234;
const VALID_OWNER_START = 1_730_000_000_000;

describe('superMcpOwnerTag', () => {
  it('round-trips buildOwnerTagArgs output through parseOwnerTagFromCmdline', () => {
    const input = {
      ownerId: VALID_OWNER_ID,
      ownerPid: VALID_OWNER_PID,
      ownerStartTimeMs: VALID_OWNER_START,
    };

    const args = buildOwnerTagArgs(input);
    expect(args).toEqual([
      '--rebel-owner-id',
      VALID_OWNER_ID,
      '--rebel-owner-pid',
      String(VALID_OWNER_PID),
      '--rebel-owner-start',
      String(VALID_OWNER_START),
    ]);

    const parsed = parseOwnerTagFromCmdline(args.join(' '));
    expect(parsed).toEqual(input);
  });

  it('parses owner tags regardless of token order', () => {
    const cmdline =
      `--rebel-owner-start ${VALID_OWNER_START} --rebel-owner-id ${VALID_OWNER_ID} --rebel-owner-pid ${VALID_OWNER_PID}`;

    expect(parseOwnerTagFromCmdline(cmdline)).toEqual({
      ownerId: VALID_OWNER_ID,
      ownerPid: VALID_OWNER_PID,
      ownerStartTimeMs: VALID_OWNER_START,
    });
  });

  it('ignores surrounding unrelated flags and parses owner tags', () => {
    const cmdline =
      `node super-mcp --port 3105 --rebel-owner-id ${VALID_OWNER_ID} --rebel-owner-pid ${VALID_OWNER_PID} `
      + `--rebel-owner-start ${VALID_OWNER_START} --some-other-flag value`;

    expect(parseOwnerTagFromCmdline(cmdline)).toEqual({
      ownerId: VALID_OWNER_ID,
      ownerPid: VALID_OWNER_PID,
      ownerStartTimeMs: VALID_OWNER_START,
    });
  });

  it('returns null when cmdline is truncated mid-value', () => {
    const cmdline =
      `node super-mcp --rebel-owner-id ${VALID_OWNER_ID} --rebel-owner-pid ${VALID_OWNER_PID} --rebel-owner-start`;

    expect(parseOwnerTagFromCmdline(cmdline)).toBeNull();
  });

  it('returns null when one required owner-tag flag is missing', () => {
    const cmdline = `--rebel-owner-id ${VALID_OWNER_ID} --rebel-owner-pid ${VALID_OWNER_PID}`;
    expect(parseOwnerTagFromCmdline(cmdline)).toBeNull();
  });

  it('returns null for malformed ownerPid values', () => {
    const makeCmdline = (ownerPidValue: string) =>
      `--rebel-owner-id ${VALID_OWNER_ID} --rebel-owner-pid ${ownerPidValue} --rebel-owner-start ${VALID_OWNER_START}`;

    expect(parseOwnerTagFromCmdline(makeCmdline('abc'))).toBeNull();
    expect(parseOwnerTagFromCmdline(makeCmdline('0'))).toBeNull();
    expect(parseOwnerTagFromCmdline(makeCmdline('-5'))).toBeNull();
  });

  it('returns null for malformed ownerStartTimeMs values (negative or zero)', () => {
    const makeCmdline = (ownerStartValue: string) =>
      `--rebel-owner-id ${VALID_OWNER_ID} --rebel-owner-pid ${VALID_OWNER_PID} --rebel-owner-start ${ownerStartValue}`;

    expect(parseOwnerTagFromCmdline(makeCmdline('-1'))).toBeNull();
    expect(parseOwnerTagFromCmdline(makeCmdline('0'))).toBeNull();
  });

  it('returns null for an empty cmdline string', () => {
    expect(parseOwnerTagFromCmdline('')).toBeNull();
  });

  it('parses quoted owner-tag values', () => {
    const cmdline =
      `--rebel-owner-id "${VALID_OWNER_ID}" --rebel-owner-pid "${VALID_OWNER_PID}" --rebel-owner-start "${VALID_OWNER_START}"`;

    expect(parseOwnerTagFromCmdline(cmdline)).toEqual({
      ownerId: VALID_OWNER_ID,
      ownerPid: VALID_OWNER_PID,
      ownerStartTimeMs: VALID_OWNER_START,
    });
  });

  it('parses with extra spaces and tabs between tokens', () => {
    const cmdline =
      `  --rebel-owner-id\t${VALID_OWNER_ID}   --rebel-owner-pid\t${VALID_OWNER_PID}     --rebel-owner-start\t${VALID_OWNER_START}  `;

    expect(parseOwnerTagFromCmdline(cmdline)).toEqual({
      ownerId: VALID_OWNER_ID,
      ownerPid: VALID_OWNER_PID,
      ownerStartTimeMs: VALID_OWNER_START,
    });
  });
});
