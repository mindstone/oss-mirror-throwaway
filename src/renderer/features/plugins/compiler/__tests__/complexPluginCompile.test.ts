/**
 * Compile tests for complex example plugins and boundary tests.
 *
 * Validates that:
 * - Bundled plugins (research-hub, sources-browser) compile successfully
 * - Multi-component plugins work
 * - Disallowed imports are caught
 * - fetch() and window.api ARE blocked by AST validator (security hardening W4-2)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { compilePluginSource } from '../pluginCompiler';

function readBundledPlugin(pluginId: string): string {
  return readFileSync(resolve(process.cwd(), 'rebel-system', 'plugins', pluginId, 'index.tsx'), 'utf-8');
}

function readFixture(filename: string): string {
  return readFileSync(resolve(__dirname, 'fixtures', filename), 'utf-8');
}

describe('Complex plugin compilation', () => {
  it('Research Hub plugin compiles successfully', () => {
    const source = readBundledPlugin('research-hub');
    const result = compilePluginSource(source);

    if (!result.ok) {
      console.error('Research Hub plugin errors:', result.errors.map((e) => e.message));
    }

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain('exports.default');
      expect(result.code).toContain('__REBEL_MODULES__["react"]');
      expect(result.code).toContain('__REBEL_MODULES__["@rebel/plugin-api"]');
      expect(result.code).toContain('__REBEL_MODULES__["@rebel/plugin-ui"]');
      expect(result.code).not.toContain('globalThis.__REBEL_MODULES__');
    }
  });

  it('Sources Browser plugin compiles successfully', () => {
    const source = readBundledPlugin('sources-browser');
    const result = compilePluginSource(source);

    if (!result.ok) {
      console.error('Sources Browser plugin errors:', result.errors.map((e) => e.message));
    }

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain('exports.default');
      expect(result.code).toContain('__REBEL_MODULES__["react"]');
      expect(result.code).toContain('__REBEL_MODULES__["@rebel/plugin-api"]');
      expect(result.code).toContain('__REBEL_MODULES__["@rebel/plugin-ui"]');
      expect(result.code).not.toContain('globalThis.__REBEL_MODULES__');
    }
  });
});

describe('Boundary test compilation', () => {
  it('Boundary A: lodash import is rejected', () => {
    const source = readFixture('boundary-test-a-lodash.tsx');
    const result = compilePluginSource(source);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes('Disallowed require() module "lodash"'))).toBe(true);
    }
  });

  it('Boundary B: fetch() IS blocked by AST validator (security hardening)', () => {
    const source = readFixture('boundary-test-b-fetch.tsx');
    const result = compilePluginSource(source);

    // fetch() is blocked as part of Layer 3 static network restrictions
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes('fetch()'))).toBe(true);
    }
  });

  it('Boundary C: window.api access IS blocked by AST validator (security hardening)', () => {
    const source = readFixture('boundary-test-c-window-api.tsx');
    const result = compilePluginSource(source);

    // window is blocked as part of Layer 1 API surface lockdown
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.message.includes('window is not allowed'))).toBe(true);
    }
  });

  it('Boundary D: multi-component file compiles successfully', () => {
    const source = readFixture('boundary-test-d-multi-component.tsx');
    const result = compilePluginSource(source);

    if (!result.ok) {
      console.error('Multi-component plugin errors:', result.errors.map((e) => e.message));
    }

    expect(result.ok).toBe(true);
    if (result.ok) {
      // All helper components should be compiled as local functions/variables
      expect(result.code).toContain('exports.default');
      // Helper components should exist as named functions in the output
      expect(result.code).toContain('SectionHeader');
      expect(result.code).toContain('StatRow');
      expect(result.code).toContain('ConvoItem');
      expect(result.code).toContain('EmptyState');
      expect(result.code).toContain('TabBar');
    }
  });

  it('iframe and SVG elements compile successfully (YouTube embed pattern)', () => {
    const source = `
import React, { useState } from 'react';
import { Card, Stack, Input, Button } from '@rebel/plugin-ui';

export default function YouTubePlayer() {
  const [url, setUrl] = useState('');
  const [embedId, setEmbedId] = useState('');

  const extractId = (input: string) => {
    const match = input.match(/(?:youtu\\.be\\/|youtube\\.com\\/(?:embed\\/|v\\/|watch\\?v=))([^&?\\s]+)/);
    return match ? match[1] : input;
  };

  return (
    <Stack gap="md">
      <div style={{ padding: '1rem' }}>
        <Stack gap="sm">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Paste YouTube URL..."
          />
          <Button onClick={() => setEmbedId(extractId(url))}>Play</Button>
        </Stack>
      </div>
      {embedId && (
        <iframe
          src={\`https://www.youtube.com/embed/\${embedId}\`}
          style={{ width: '100%', height: '300px', border: 'none', borderRadius: '0.5rem' }}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope"
          allowFullScreen
        />
      )}
      <svg width={100} height={100}>
        <circle cx={50} cy={50} r={40} fill="var(--color-accent)" />
      </svg>
    </Stack>
  );
}
`;
    const result = compilePluginSource(source);

    if (!result.ok) {
      console.error('YouTube plugin errors:', result.errors.map((e) => e.message));
    }

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toContain('exports.default');
      expect(result.code).toContain('iframe');
      expect(result.code).toContain('svg');
      expect(result.code).toContain('circle');
    }
  });
});
