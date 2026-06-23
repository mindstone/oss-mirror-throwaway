import { describe, expect, it } from 'vitest';
import { reviewPluginSecurity } from '../pluginSecurityReview';

describe('reviewPluginSecurity', () => {
  // ── Backwards-compatible tests ────────────────────────────────────────

  it('detects React and plugin hooks as API usage (info severity)', () => {
    const source = `
import { useEffect, useState } from 'react';
import { useConversations, useMemorySearch, usePluginStorage } from '@rebel/plugin-api';

export default function Plugin() {
  const [count, setCount] = useState(0);
  const [savedCount, setSavedCount] = usePluginStorage('count', 0);
  const { data } = useConversations();
  const { results } = useMemorySearch('meeting');

  useEffect(() => {
    setSavedCount(count + data.length + results.length);
  }, [count, data.length, results.length, setSavedCount]);

  return <div>{savedCount}</div>;
}
`;

    const report = reviewPluginSecurity(source);

    expect(report.passed).toBe(true);
    expect(report.maxSeverity).toBe('info');
    expect(report.warnings).toEqual([]);
    expect(report.apiUsage).toEqual(
      expect.arrayContaining([
        'React hook: useState()',
        'React hook: useEffect()',
        'Plugin hook: usePluginStorage()',
        'Plugin hook: useMemorySearch()',
        'Plugin hook: useConversations()',
      ]),
    );
    // Verify findings have info severity
    for (const finding of report.findings) {
      expect(finding.severity).toBe('info');
    }
  });

  it('flags network-related patterns as block severity', () => {
    const source = `
export default function Plugin() {
  fetch('https://example.com');
  const socket = new WebSocket('wss://example.com/events');
  navigator.sendBeacon('/track', 'analytics');
  return <div>{String(socket)}</div>;
}
`;

    const report = reviewPluginSecurity(source);

    expect(report.passed).toBe(false);
    expect(report.maxSeverity).toBe('block');
    expect(report.apiUsage).toEqual(
      expect.arrayContaining([
        'Network API: fetch()',
        'Network API: WebSocket',
        'Network API: navigator.sendBeacon()',
      ]),
    );
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('fetch()'),
        expect.stringContaining('WebSocket'),
        expect.stringContaining('navigator.sendBeacon()'),
      ]),
    );
  });

  it('flags DOM manipulation as warn and dynamic execution as block', () => {
    const source = `
export default function Plugin() {
  const panel = document.querySelector('#panel');
  if (panel) {
    panel.innerHTML = '<p>Hi</p>';
  }

  const runner = Function('return 42');
  eval('runner()');

  return <div>{String(runner)}</div>;
}
`;

    const report = reviewPluginSecurity(source);

    expect(report.passed).toBe(false);
    expect(report.maxSeverity).toBe('block');
    expect(report.apiUsage).toEqual(
      expect.arrayContaining([
        'DOM API: document.querySelector()',
        'DOM API: innerHTML',
        'Dynamic execution: Function()',
        'Dynamic execution: eval()',
      ]),
    );
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('document.querySelector()'),
        expect.stringContaining('innerHTML'),
        expect.stringContaining('Function()'),
        expect.stringContaining('eval()'),
      ]),
    );
  });

  it('returns a clean summary when no suspicious patterns are found', () => {
    const source = `
export default function Plugin() {
  return <div>hello</div>;
}
`;

    const report = reviewPluginSecurity(source);

    expect(report.passed).toBe(true);
    expect(report.maxSeverity).toBe('info');
    expect(report.apiUsage).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.summary).toContain('No notable API usage detected by static review.');
    expect(report.summary).toContain('No suspicious patterns detected by static review.');
    expect(report.findings).toEqual([]);
  });

  // ── Severity-specific tests ───────────────────────────────────────────

  describe('severity classification', () => {
    it('eval() → block', () => {
      const report = reviewPluginSecurity(`eval('1+1');`);
      expect(report.maxSeverity).toBe('block');
      expect(report.passed).toBe(false);
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ severity: 'block', pattern: 'eval()' }),
        ]),
      );
    });

    it('Function() → block', () => {
      const report = reviewPluginSecurity(`const fn = Function('return 42');`);
      expect(report.maxSeverity).toBe('block');
      expect(report.passed).toBe(false);
    });

    it('raw fetch() → block', () => {
      const report = reviewPluginSecurity(`fetch('https://evil.com');`);
      expect(report.maxSeverity).toBe('block');
      expect(report.passed).toBe(false);
    });

    it('XMLHttpRequest → block', () => {
      const report = reviewPluginSecurity(`new XMLHttpRequest();`);
      expect(report.maxSeverity).toBe('block');
      expect(report.passed).toBe(false);
    });

    it('WebSocket → block', () => {
      const report = reviewPluginSecurity(`new WebSocket('wss://evil.com');`);
      expect(report.maxSeverity).toBe('block');
      expect(report.passed).toBe(false);
    });

    it('setTimeout with string arg → block', () => {
      const report = reviewPluginSecurity(`setTimeout('alert(1)', 100);`);
      expect(report.maxSeverity).toBe('block');
      expect(report.passed).toBe(false);
    });

    it('setInterval with string arg → block', () => {
      const report = reviewPluginSecurity(`setInterval('doThing()', 1000);`);
      expect(report.maxSeverity).toBe('block');
      expect(report.passed).toBe(false);
    });

    it('document.querySelector() → warn', () => {
      const report = reviewPluginSecurity(`document.querySelector('.panel');`);
      expect(report.maxSeverity).toBe('warn');
      expect(report.passed).toBe(true);
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ severity: 'warn', pattern: 'document.querySelector()' }),
        ]),
      );
    });

    it('innerHTML → warn', () => {
      const report = reviewPluginSecurity(`el.innerHTML = '<p>hi</p>';`);
      expect(report.maxSeverity).toBe('warn');
      expect(report.passed).toBe(true);
    });

    it('localStorage → warn', () => {
      const report = reviewPluginSecurity(`localStorage.setItem('key', 'value');`);
      expect(report.maxSeverity).toBe('warn');
      expect(report.passed).toBe(true);
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ severity: 'warn', pattern: 'localStorage' }),
        ]),
      );
    });

    it('sessionStorage → warn', () => {
      const report = reviewPluginSecurity(`sessionStorage.getItem('key');`);
      expect(report.maxSeverity).toBe('warn');
      expect(report.passed).toBe(true);
    });

    it('dynamic import() → warn', () => {
      const report = reviewPluginSecurity(`const mod = await import('./other');`);
      expect(report.maxSeverity).toBe('warn');
      expect(report.passed).toBe(true);
    });

    it('document.cookie → warn', () => {
      const report = reviewPluginSecurity(`const c = document.cookie;`);
      expect(report.maxSeverity).toBe('warn');
      expect(report.passed).toBe(true);
    });

    it('React hooks → info (no warnings)', () => {
      const report = reviewPluginSecurity(`const [x, setX] = useState(0); useEffect(() => {}, []);`);
      expect(report.maxSeverity).toBe('info');
      expect(report.passed).toBe(true);
      expect(report.warnings).toEqual([]);
    });

    it('plugin hooks → info (no warnings)', () => {
      const report = reviewPluginSecurity(`const [val, setVal] = usePluginStorage('key', 0);`);
      expect(report.maxSeverity).toBe('info');
      expect(report.passed).toBe(true);
    });
  });

  // ── Permission-aware scanning ─────────────────────────────────────────

  describe('permission-aware fetch handling', () => {
    it('raw fetch() without external-fetch permission → block', () => {
      const source = `fetch('https://api.example.com/data');`;
      const report = reviewPluginSecurity(source, { permissions: [] });
      expect(report.maxSeverity).toBe('block');
      expect(report.passed).toBe(false);
    });

    it('raw fetch() WITH external-fetch permission but no mediated reference → block', () => {
      const source = `fetch('https://api.example.com/data');`;
      const report = reviewPluginSecurity(source, { permissions: ['external-fetch'] });
      expect(report.maxSeverity).toBe('block');
      expect(report.passed).toBe(false);
    });

    it('useExternalFetch + external-fetch permission → info (mediated path)', () => {
      const source = `
const { data } = useExternalFetch('https://api.example.com/data');
// fetch() pattern also matches inside useExternalFetch internals
`;
      const report = reviewPluginSecurity(source, { permissions: ['external-fetch'] });

      // The fetch() regex should match but be downgraded to info
      const fetchFindings = report.findings.filter((f) => f.pattern === 'fetch()');
      // If fetch regex doesn't match, that's also fine — useExternalFetch doesn't always contain raw fetch
      if (fetchFindings.length > 0) {
        expect(fetchFindings[0].severity).toBe('info');
      }
      // maxSeverity should be info (hooks are info, fetch downgraded to info)
      expect(report.maxSeverity).toBe('info');
      expect(report.passed).toBe(true);
    });

    it('rebel.fetch() + external-fetch permission → info (mediated path)', () => {
      const source = `
const result = await rebel.fetch('https://api.example.com/data');
`;
      const report = reviewPluginSecurity(source, { permissions: ['external-fetch'] });

      // The raw fetch() regex matches rebel.fetch(... — but the source also has rebel.fetch reference
      const fetchFindings = report.findings.filter((f) => f.pattern === 'fetch()');
      if (fetchFindings.length > 0) {
        expect(fetchFindings[0].severity).toBe('info');
      }
      expect(report.passed).toBe(true);
    });

    it('XMLHttpRequest always blocks regardless of permissions', () => {
      const source = `
const { data } = useExternalFetch('https://api.example.com/data');
const xhr = new XMLHttpRequest();
`;
      const report = reviewPluginSecurity(source, { permissions: ['external-fetch'] });
      expect(report.maxSeverity).toBe('block');
      expect(report.passed).toBe(false);
    });

    it('WebSocket always blocks regardless of permissions', () => {
      const source = `new WebSocket('wss://evil.com');`;
      const report = reviewPluginSecurity(source, { permissions: ['external-fetch'] });
      expect(report.maxSeverity).toBe('block');
      expect(report.passed).toBe(false);
    });
  });

  // ── Backwards compatibility ───────────────────────────────────────────

  describe('backwards compatibility', () => {
    it('passed=true when only warn-severity findings exist', () => {
      const report = reviewPluginSecurity(`document.querySelector('.x');`);
      expect(report.passed).toBe(true);
      expect(report.maxSeverity).toBe('warn');
      expect(report.warnings.length).toBeGreaterThan(0);
    });

    it('passed=false when block-severity findings exist', () => {
      const report = reviewPluginSecurity(`eval('x');`);
      expect(report.passed).toBe(false);
      expect(report.maxSeverity).toBe('block');
    });

    it('warnings array contains messages for both warn and block findings', () => {
      const source = `
document.querySelector('.x');
eval('x');
`;
      const report = reviewPluginSecurity(source);
      expect(report.warnings.length).toBe(2);
    });

    it('apiUsage array includes all detected patterns', () => {
      const source = `
const [x, setX] = useState(0);
document.querySelector('.x');
eval('x');
`;
      const report = reviewPluginSecurity(source);
      expect(report.apiUsage).toEqual(
        expect.arrayContaining([
          'React hook: useState()',
          'DOM API: document.querySelector()',
          'Dynamic execution: eval()',
        ]),
      );
    });

    it('summary array has descriptive messages', () => {
      const source = `const [x, setX] = useState(0);`;
      const report = reviewPluginSecurity(source);
      expect(report.summary.some((s) => s.includes('React hooks detected'))).toBe(true);
    });
  });

  // ── Mixed severity ────────────────────────────────────────────────────

  describe('mixed severity levels', () => {
    it('warn + block → maxSeverity is block', () => {
      const source = `
document.querySelector('.x');
eval('dangerous');
`;
      const report = reviewPluginSecurity(source);
      expect(report.maxSeverity).toBe('block');
      expect(report.passed).toBe(false);
    });

    it('info + warn → maxSeverity is warn', () => {
      const source = `
const [x, setX] = useState(0);
document.querySelector('.x');
`;
      const report = reviewPluginSecurity(source);
      expect(report.maxSeverity).toBe('warn');
      expect(report.passed).toBe(true);
    });

    it('only info → maxSeverity is info', () => {
      const source = `
const [x, setX] = useState(0);
const [val, setVal] = usePluginStorage('key', 0);
`;
      const report = reviewPluginSecurity(source);
      expect(report.maxSeverity).toBe('info');
      expect(report.passed).toBe(true);
    });
  });

  // ── Options handling ──────────────────────────────────────────────────

  describe('options handling', () => {
    it('works without options parameter (backwards compat)', () => {
      const report = reviewPluginSecurity(`eval('x');`);
      expect(report.maxSeverity).toBe('block');
      expect(report.passed).toBe(false);
    });

    it('works with empty permissions array', () => {
      const report = reviewPluginSecurity(`eval('x');`, { permissions: [] });
      expect(report.maxSeverity).toBe('block');
    });

    it('works with undefined permissions', () => {
      const report = reviewPluginSecurity(`eval('x');`, { permissions: undefined });
      expect(report.maxSeverity).toBe('block');
    });
  });
});
