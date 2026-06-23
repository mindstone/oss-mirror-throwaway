/**
 * Parity test for the OSS MCP release pipeline.
 *
 * Single assertion: **No orphan `??` fallbacks for `@mindstone/mcp-server-*`
 * packages.** All rebel-oss connectors must read their npx pin from the
 * catalog only, with a structured error on miss. This test scans the
 * codebase for the dropped-fallback pattern to catch re-introductions.
 *
 * Detects three variants:
 *  - `?? ['-y', '@mindstone/mcp-server-X@x.y.z']` (versioned)
 *  - `?? ['-y', '@mindstone/mcp-server-X']` (unversioned — caught the
 *     Salesforce regression that the v1 parity test missed)
 *  - `args: ['-y', '@mindstone/mcp-server-X@x.y.z']` (hardcoded literal)
 *
 * Whole-file scan (multiline pattern), not line-by-line, so multi-line
 * fallback definitions don't slip through.
 *
 * See docs/plans/260525_oss_release_automation.md (v2) for context.
 *
 * Note: previous versions of this file also asserted parity between
 * MICROSOFT_REBEL_OSS_DEFS.packageSpec and the catalog. As of 2026-05-26
 * (Track A v2 cleanup) the Microsoft 5 dropped their packageSpec field and
 * are now treated uniformly with all other rebel-oss connectors — the
 * catalog is the sole source of truth, with structured errors on miss.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('MCP release pipeline parity', () => {
  describe('No orphan ?? hardcoded-pin fallbacks for @mindstone/mcp-server-*', () => {
    const SCAN_DIRS = [
      path.join(REPO_ROOT, 'src/main'),
      path.join(REPO_ROOT, 'src/core'),
      path.join(REPO_ROOT, 'src/renderer'),
      path.join(REPO_ROOT, 'src/preload'),
      path.join(REPO_ROOT, 'src/shared'),
      path.join(REPO_ROOT, 'cloud-service/src'),
      path.join(REPO_ROOT, 'cloud-client/src'),
    ];

    // Multiline-aware. Each pattern uses [\s\S] to match across line breaks
    // because a real codebase can split these literals across lines.
    //
    // Pattern A (versioned ??-fallback):
    //   ?? ['-y', '@mindstone/mcp-server-X@x.y.z']
    const VERSIONED_FALLBACK = /\?\?\s*\[\s*['"]-y['"]\s*,\s*['"]@(mindstone|mindstone-engineering)\/mcp-server-[a-z0-9-]+@\d+\.\d+\.\d+['"]\s*\]/;
    // Pattern B (UNVERSIONED ??-fallback — Salesforce regression):
    //   ?? ['-y', '@mindstone/mcp-server-X']
    const UNVERSIONED_FALLBACK = /\?\?\s*\[\s*['"]-y['"]\s*,\s*['"]@(mindstone|mindstone-engineering)\/mcp-server-[a-z0-9-]+['"]\s*\]/;
    // Pattern C (hardcoded args literal, with version):
    //   args: ['-y', '@mindstone/mcp-server-X@x.y.z']
    const HARDCODED_ARGS_VERSIONED = /args:\s*\[\s*['"]-y['"]\s*,\s*['"]@(mindstone|mindstone-engineering)\/mcp-server-[a-z0-9-]+@\d+\.\d+\.\d+['"]\s*\]/;

    function* walk(dir: string): Generator<string> {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name.startsWith('.')) continue;
          yield* walk(full);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
          if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
          if (entry.name.endsWith('.fixture.ts') || entry.name.endsWith('.fixtures.ts')) continue;
          yield full;
        }
      }
    }

    function lineNumberAt(content: string, index: number): number {
      let line = 1;
      for (let i = 0; i < index; i++) {
        if (content[i] === '\n') line++;
      }
      return line;
    }

    function scanWholeFile(content: string, regex: RegExp, label: string): Array<{ line: number; match: string; pattern: string }> {
      const found: Array<{ line: number; match: string; pattern: string }> = [];
      let working = content;
      let offset = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const m = regex.exec(working);
        if (!m) break;
        const absoluteIndex = offset + m.index;
        found.push({
          line: lineNumberAt(content, absoluteIndex),
          match: m[0],
          pattern: label,
        });
        offset += m.index + m[0].length;
        working = working.slice(m.index + m[0].length);
      }
      return found;
    }

    const offenders: Array<{ file: string; line: number; pattern: string; match: string }> = [];

    for (const dir of SCAN_DIRS) {
      for (const file of walk(dir)) {
        const content = fs.readFileSync(file, 'utf8');
        for (const m of scanWholeFile(content, VERSIONED_FALLBACK, 'versioned-??-fallback')) {
          offenders.push({ file: path.relative(REPO_ROOT, file), line: m.line, pattern: m.pattern, match: m.match });
        }
        for (const m of scanWholeFile(content, UNVERSIONED_FALLBACK, 'unversioned-??-fallback')) {
          offenders.push({ file: path.relative(REPO_ROOT, file), line: m.line, pattern: m.pattern, match: m.match });
        }
        for (const m of scanWholeFile(content, HARDCODED_ARGS_VERSIONED, 'hardcoded-args')) {
          offenders.push({ file: path.relative(REPO_ROOT, file), line: m.line, pattern: m.pattern, match: m.match });
        }
      }
    }

    it('finds no ?? hardcoded-pin fallbacks (versioned, unversioned, or args:[]) outside tests/fixtures', () => {
      if (offenders.length > 0) {
        const message =
          'Found re-introduced hardcoded MCP package pins. The connector catalog is the sole source of truth for OSS package pins (see docs/plans/260525_oss_release_automation.md v2):\n' +
          offenders.map((o) => `  ${o.file}:${o.line}  [${o.pattern}]  ${o.match}`).join('\n');
        throw new Error(message);
      }
      expect(offenders).toEqual([]);
    });
  });
});
