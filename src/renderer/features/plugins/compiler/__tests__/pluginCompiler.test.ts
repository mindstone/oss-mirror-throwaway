import { describe, expect, it } from 'vitest';
import { compilePluginSource } from '../pluginCompiler';

describe('compilePluginSource', () => {
  it('compiles valid TSX and rewrites allowed imports', () => {
    const source = `
import { Card } from '@rebel/plugin-ui';

type Props = {
  title: string;
};

export default function PluginCard({ title }: Props) {
  return <Card>{title}</Card>;
}
`;

    const result = compilePluginSource(source);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected successful compilation');
    }

    expect(result.code).toContain('__REBEL_MODULES__["@rebel/plugin-ui"]');
    expect(result.code).toContain('__REBEL_MODULES__["react/jsx-runtime"]');
    expect(result.code).not.toContain('globalThis.__REBEL_MODULES__');
    expect(result.code).toContain('exports.default');
    expect(result.code).not.toContain('type Props');
    expect(result.code).not.toContain('require("@rebel/plugin-ui")');
  });

  it('returns structured compile errors with line and column', () => {
    const source = `
export default function Broken() {
  return <div>
}
`;

    const result = compilePluginSource(source);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected compilation to fail');
    }

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].type).toBe('compile');
    expect(result.errors[0].line).toBeTypeOf('number');
    expect(result.errors[0].column).toBeTypeOf('number');
    expect(result.errors[0].fullSource).toBe(source);
  });

  it('returns validation errors for missing default export', () => {
    const source = `
export const value = 123;
`;

    const result = compilePluginSource(source);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected validation to fail');
    }

    expect(result.errors.some((error) => error.type === 'validation')).toBe(true);
    expect(result.errors.some((error) => error.message.includes('default export'))).toBe(true);
  });

  it('returns validation errors for forbidden imports', () => {
    const source = `
import fs from 'fs';

export default function Plugin() {
  return <div>{String(fs)}</div>;
}
`;

    const result = compilePluginSource(source);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected validation to fail');
    }

    expect(result.errors.some((error) => error.message.includes('Disallowed require() module "fs"'))).toBe(
      true,
    );
  });

  it('returns validation errors for forbidden patterns', () => {
    const source = `
export default function Plugin() {
  eval('2 + 2');
  return <div />;
}
`;

    const result = compilePluginSource(source);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected validation to fail');
    }

    expect(result.errors.some((error) => error.message.includes('eval() is not allowed'))).toBe(true);
  });

  it('returns warnings for suspicious React key usage', () => {
    const source = `
import { Card } from '@rebel/plugin-ui';

export default function Plugin() {
  const items = [{ id: '1' }];
  return <div>{items.map(item => <Card key={item}>text</Card>)}</div>;
}
`;

    const result = compilePluginSource(source);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected successful compile');

    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
    expect(result.warnings![0].type).toBe('suspicious-key');
    expect(result.warnings![0].message).toContain('item');
  });

  it('returns no warnings for correct key usage', () => {
    const source = `
import { Card } from '@rebel/plugin-ui';

export default function Plugin() {
  const items = [{ id: '1', name: 'Test' }];
  return <div>{items.map(item => <Card key={item.id}>{item.name}</Card>)}</div>;
}
`;

    const result = compilePluginSource(source);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Expected successful compile');

    expect(result.warnings).toBeUndefined();
  });

  it('auto-imports bare plugin hook references (REBEL-4Z5 / REBEL-4GF fix)', () => {
    // Simulates AI-generated plugin code that uses useMemorySearch without importing it
    const source = `
import { Card } from '@rebel/plugin-ui';

export default function DashboardPlugin() {
  const { results } = useMemorySearch("recent meetings");
  return <Card>{results.length} results</Card>;
}
`;

    const result = compilePluginSource(source);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`Expected successful compilation, got: ${result.errors.map(e => e.message).join(', ')}`);
    }

    // The bare useMemorySearch should be rewritten to __autoPluginApi.useMemorySearch
    expect(result.code).toContain('__autoPluginApi.useMemorySearch');
    expect(result.code).toContain('var __autoPluginApi');
  });

  it('does not inject auto-import when plugin properly imports hooks', () => {
    const source = `
import { useMemorySearch } from '@rebel/plugin-api';
import { Card } from '@rebel/plugin-ui';

export default function DashboardPlugin() {
  const { results } = useMemorySearch("query");
  return <Card>{results.length} results</Card>;
}
`;

    const result = compilePluginSource(source);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`Expected successful compilation, got: ${result.errors.map(e => e.message).join(', ')}`);
    }

    // Should NOT have __autoPluginApi because the import is proper
    expect(result.code).not.toContain('__autoPluginApi');
    // Should have the proper module reference
    expect(result.code).toContain('__REBEL_MODULES__["@rebel/plugin-api"]');
  });
});
