import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { walkBlurBudget } from '../check-blur-budget';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-blur-budget-test-'));
});

afterEach(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

function writeFixture(relPath: string, content: string): string {
  const full = path.join(tmpRoot, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

describe('check-blur-budget — walkBlurBudget()', () => {
  it('flags a hardcoded backdrop-filter: blur(<literal>px) declaration as a finding', () => {
    writeFixture(
      'leaky.module.css',
      `.surface {
  position: fixed;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(8px);
}
`,
    );

    const findings = walkBlurBudget(tmpRoot);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'leaky.module.css',
      line: 4,
    });
    expect(findings[0].text).toContain('blur(8px)');
  });

  it('does NOT flag a hardcoded literal that carries an inline `blur-budget-exempt:` comment', () => {
    writeFixture(
      'exempt.module.css',
      `.surface {
  position: fixed;
  background: rgba(0, 0, 0, 0.5);
  /* blur-budget-exempt: this is a foreground modal effect, not chrome. */
  backdrop-filter: blur(8px);
}
`,
    );

    const findings = walkBlurBudget(tmpRoot);

    expect(findings).toHaveLength(0);
  });

  it('does NOT flag a clean file with a tokenized backdrop-filter', () => {
    writeFixture(
      'clean.module.css',
      `.surface {
  position: fixed;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(var(--glass-overlay-blur));
}

.no-blur {
  position: relative;
  color: red;
}
`,
    );

    const findings = walkBlurBudget(tmpRoot);

    expect(findings).toHaveLength(0);
  });
});
