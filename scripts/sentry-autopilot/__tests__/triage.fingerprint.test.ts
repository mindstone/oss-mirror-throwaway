import { describe, expect, it } from 'vitest';

import {
  fingerprintLooseHash,
  fingerprintTightHash,
  type StackFrame,
} from '../triage/fingerprint.ts';
import { extractStackFrames } from '../sentryRest.ts';

const frames: StackFrame[] = [
  { filename: '/app/src/main.ts', function: 'handleError', lineno: 10 },
  { filename: '/app/src/worker.ts', function: 'runWorker', lineno: 20 },
  { filename: '/app/src/index.ts', function: 'main', lineno: 30 },
];

describe('fingerprint helpers', () => {
  it('returns deterministic hashes for the same frames', () => {
    expect(fingerprintLooseHash(frames)).toBe(fingerprintLooseHash([...frames]));
    expect(fingerprintTightHash(frames)).toBe(fingerprintTightHash([...frames]));
  });

  it('keeps loose hashes stable while tight hashes differ when line numbers change', () => {
    const shifted = frames.map((frame) => ({ ...frame, lineno: (frame.lineno ?? 0) + 100 }));

    expect(fingerprintLooseHash(shifted)).toBe(fingerprintLooseHash(frames));
    expect(fingerprintTightHash(shifted)).not.toBe(fingerprintTightHash(frames));
  });

  it('normalizes absolute node_modules prefixes before hashing', () => {
    const a: StackFrame[] = [
      { filename: '/Users/foo/node_modules/x/index.js', function: 'DoThing', lineno: 1 },
    ];
    const b: StackFrame[] = [
      { filename: '/home/bar/node_modules/x/index.js', function: 'dothing', lineno: 1 },
    ];

    expect(fingerprintLooseHash(a)).toBe(fingerprintLooseHash(b));
  });

  it('returns null for missing or empty frames', () => {
    expect(fingerprintLooseHash([])).toBeNull();
    expect(fingerprintLooseHash(null)).toBeNull();
    expect(fingerprintTightHash([])).toBeNull();
    expect(fingerprintTightHash(undefined)).toBeNull();
  });

  it('returns null from tight hash when any top-three frame lacks a line number', () => {
    const missingLine = [
      frames[0],
      { filename: '/app/src/worker.ts', function: 'runWorker' },
      frames[2],
    ];

    expect(fingerprintLooseHash(missingLine)).not.toBeNull();
    expect(fingerprintTightHash(missingLine)).toBeNull();
  });

  it('extracts frames from Sentry latestEvent exception entries', () => {
    const detail = {
      latestEvent: {
        entries: [
          {
            data: {
              values: [
                {
                  stacktrace: {
                    frames,
                  },
                },
              ],
            },
          },
        ],
      },
    };

    expect(extractStackFrames(detail)).toEqual(frames);
  });
});
