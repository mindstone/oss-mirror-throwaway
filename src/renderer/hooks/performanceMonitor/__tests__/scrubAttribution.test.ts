/**
 * PII-scrub unit tests for `scrubAttribution`.
 *
 * Stage 3 of `docs/plans/260423_secondary_process_cpu_observability.md`:
 * any URL/containerSrc/containerName containing identifiable tokens
 * (UUIDs, long hex, emails, base64, userinfo, session IDs, document
 * titles) must be redacted to `labelPath: null`; the category enum is the
 * only free-form signal permitted.
 */

import { describe, it, expect } from 'vitest';
import { scrubAttribution } from '../scrubAttribution';

function makeLongTask(
  attribution: Array<Partial<{
    containerType: string;
    containerSrc: string;
    containerName: string;
    containerId: string;
  }>>,
  entryType = 'longtask',
): PerformanceEntry {
  return {
    entryType,
    attribution,
  } as unknown as PerformanceEntry;
}

describe('scrubAttribution — category derivation', () => {
  it('longtask + containerType=window → script', () => {
    const r = scrubAttribution(makeLongTask([{ containerType: 'window', containerSrc: '/app/main.js' }]));
    expect(r.category).toBe('script');
  });

  it('longtask + containerType=iframe → script', () => {
    const r = scrubAttribution(makeLongTask([{ containerType: 'iframe', containerSrc: '/widget.js' }]));
    expect(r.category).toBe('script');
  });

  it('longtask + containerType=embed → script', () => {
    const r = scrubAttribution(makeLongTask([{ containerType: 'embed', containerSrc: '/e.js' }]));
    expect(r.category).toBe('script');
  });

  it('longtask + unknown containerType → unknown', () => {
    const r = scrubAttribution(makeLongTask([{ containerType: 'weird', containerSrc: '/x.js' }]));
    expect(r.category).toBe('unknown');
  });

  it('longtask with no attribution → script (main JS assumption)', () => {
    const r = scrubAttribution(makeLongTask([]));
    expect(r.category).toBe('script');
    expect(r.labelPath).toBeNull();
  });

  it('layout-shift entry → layout', () => {
    const r = scrubAttribution(makeLongTask([{ containerType: 'window' }], 'layout-shift'));
    expect(r.category).toBe('layout');
  });

  it('paint entry → paint', () => {
    const r = scrubAttribution(makeLongTask([{ containerType: 'window' }], 'paint'));
    expect(r.category).toBe('paint');
  });
});

describe('scrubAttribution — PII-bearing tokens redact to null', () => {
  const redactedSamples: Array<[string, string]> = [
    // UUID in path
    [
      'uuid',
      'https://example.com/api/550e8400-e29b-41d4-a716-446655440000/main.js',
    ],
    // Long hex (session/hash)
    [
      'long-hex',
      'https://example.com/a/1234567890abcdef1234/main.js',
    ],
    // Email in URL
    [
      'email',
      'https://example.com/u/jane.doe@example.com/main.js',
    ],
    // Base64-ish token
    [
      'base64',
      'https://example.com/t/eyJhbGciOiJIUzI1NiJ9ABC123/main.js',
    ],
    // userinfo in URL (host part also gets dropped, but we still redact)
    [
      'userinfo',
      'https://user:pass@example.com/main.js',
    ],
    // Session ID as a long hex name
    [
      'session id name',
      'sessionfedcba9876543210aaaa',
    ],
    // Document title (whitespace → free-form redact)
    [
      'document title',
      'My Secret Document.docx',
    ],
  ];

  for (const [label, input] of redactedSamples) {
    it(`redacts ${label} to null labelPath`, () => {
      // Feed through containerSrc
      const src = scrubAttribution(
        makeLongTask([{ containerType: 'iframe', containerSrc: input }]),
      );
      expect(src.labelPath, `via containerSrc (${label})`).toBeNull();
      // Also validate via containerName
      const name = scrubAttribution(
        makeLongTask([{ containerType: 'iframe', containerName: input }]),
      );
      expect(name.labelPath, `via containerName (${label})`).toBeNull();
    });
  }
});

describe('scrubAttribution — query / fragment stripped, path retained', () => {
  it('query string removed, clean path retained', () => {
    const r = scrubAttribution(
      makeLongTask([{
        containerType: 'window',
        containerSrc: 'https://example.com/app/main.js?sessionId=abc123xyz&user=jane',
      }]),
    );
    expect(r.labelPath).toBe('/app/main.js');
  });

  it('fragment removed, clean path retained', () => {
    const r = scrubAttribution(
      makeLongTask([{
        containerType: 'window',
        containerSrc: 'https://example.com/app/main.js#token=xyz',
      }]),
    );
    expect(r.labelPath).toBe('/app/main.js');
  });
});

describe('scrubAttribution — clean paths pass through', () => {
  it('absolute URL with safe path → path-only', () => {
    const r = scrubAttribution(
      makeLongTask([{ containerType: 'window', containerSrc: 'https://example.com/app/main.js' }]),
    );
    expect(r.category).toBe('script');
    expect(r.labelPath).toBe('/app/main.js');
  });

  it('relative path → unchanged', () => {
    const r = scrubAttribution(
      makeLongTask([{ containerType: 'window', containerSrc: '/app/bundle.js' }]),
    );
    expect(r.labelPath).toBe('/app/bundle.js');
  });

  it('short containerName without whitespace → keeps name', () => {
    const r = scrubAttribution(
      makeLongTask([{ containerType: 'window', containerName: 'main' }]),
    );
    expect(r.labelPath).toBe('main');
  });

  it('strips query even on a clean path', () => {
    const r = scrubAttribution(
      makeLongTask([{ containerType: 'window', containerSrc: 'https://example.com/a.js?x=1' }]),
    );
    // x=1 alone is short; path still wins because we strip the query.
    expect(r.labelPath).toBe('/a.js');
  });

  it('no PII scheme-less path with dot-js → unchanged', () => {
    const r = scrubAttribution(
      makeLongTask([{ containerType: 'window', containerSrc: 'widget.js' }]),
    );
    expect(r.labelPath).toBe('widget.js');
  });
});

describe('scrubAttribution — never exposes raw user content', () => {
  it('URL with multiple risky tokens → null', () => {
    const r = scrubAttribution(
      makeLongTask([
        {
          containerType: 'window',
          containerSrc:
            'https://example.com/u/jane@example.com/session/550e8400-e29b-41d4-a716-446655440000?q=secret',
        },
      ]),
    );
    expect(r.labelPath).toBeNull();
  });

  it('refuses to return empty string — always null or non-empty', () => {
    const r = scrubAttribution(
      makeLongTask([{ containerType: 'window', containerSrc: '' }]),
    );
    expect(r.labelPath).toBeNull();
    expect(r.category).toBe('script');
  });

  it('over-long containerName → null', () => {
    const longName = 'a'.repeat(200);
    const r = scrubAttribution(makeLongTask([{ containerType: 'window', containerName: longName }]));
    expect(r.labelPath).toBeNull();
  });
});
