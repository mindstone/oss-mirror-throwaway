import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { loadPlugin } from '../pluginLoader';

beforeEach(() => {
  globalThis.__REBEL_MODULES__ = {
    'react': React,
    'react/jsx-runtime': jsxRuntime,
    'react/jsx-dev-runtime': jsxRuntime,
    '@rebel/plugin-api': { useRebel: () => ({}) },
    '@rebel/plugin-ui': {
      Card: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
      Stack: ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children),
    },
  };
});

describe('pluginLoader', () => {
  it('compiles and loads a simple TSX component', async () => {
    const source = `
export default function Hello() {
  return <div>Hello</div>;
}
`;
    const result = await loadPlugin(source);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.component).toBe('function');
      expect(result.revision).toBeGreaterThan(0);
    }
  });

  it('accepts pluginId when provided', async () => {
    const source = `
export default function HelloWithPluginId() {
  return <div>Hello</div>;
}
`;
    const result = await loadPlugin(source, 'my-test-plugin');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.component).toBe('function');
    }
  });

  it('loads a component that uses @rebel/plugin-ui imports', async () => {
    const source = `
import { Card, Stack } from '@rebel/plugin-ui';

export default function MyPlugin() {
  return (
    <Stack>
      <Card>
        <h2>Test Plugin</h2>
      </Card>
    </Stack>
  );
}
`;
    const result = await loadPlugin(source);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.component).toBe('function');
    }
  });

  it('returns compile errors for invalid syntax', async () => {
    const source = `
export default function Broken( {
  // missing closing paren and brace
`;
    const result = await loadPlugin(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].type).toBe('compile');
    }
  });

  it('returns validation error for missing default export', async () => {
    const source = `
function NotExported() {
  return <div>Hello</div>;
}
`;
    const result = await loadPlugin(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].type).toBe('validation');
      expect(result.errors[0].message).toContain('default export');
    }
  });

  it('returns validation error for forbidden require', async () => {
    const source = `
import fs from 'fs';
export default function Bad() {
  return <div>{fs.readFileSync('/')}</div>;
}
`;
    const result = await loadPlugin(source);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toContain('fs');
    }
  });

  it('increments revision on each successful load', async () => {
    const source = `export default function A() { return <div>A</div>; }`;
    const r1 = await loadPlugin(source);
    const r2 = await loadPlugin(source);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r2.revision).toBe(r1.revision + 1);
    }
  });
});
