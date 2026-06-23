import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as lancedb from '@lancedb/lancedb';
import { eq, or, likePrefix } from '../lancedbPredicates';

/**
 * Real-LanceDB integration tests for the shared predicate utility.
 * Verifies that generated SQL predicates work correctly against actual
 * DataFusion parsing, not just string snapshot assertions.
 */
describe('lancedbPredicates (real LanceDB)', () => {
  let tmpDir: string;
  let db: lancedb.Connection;
  let table: lancedb.Table;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lancedb-pred-test-'));
    db = await lancedb.connect(tmpDir);
    table = await db.createTable('test', [
      { id: '1', relativePath: 'src/main/index.ts', tag: 'normal' },
      { id: '2', relativePath: 'src/100%_coverage/test.ts', tag: 'percent' },
      { id: '3', relativePath: 'src/file_name/utils.ts', tag: 'underscore' },
      { id: '4', relativePath: 'docs/plans/readme.md', tag: 'other' },
      { id: '5', relativePath: 'src/main/services/auth.ts', tag: 'nested' },
    ]);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('eq()', () => {
    it('matches exact row by column value', async () => {
      const rows = await table.query().where(eq('id', '3')).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].tag).toBe('underscore');
    });

    it('returns empty for non-existent value', async () => {
      const rows = await table.query().where(eq('id', 'nonexistent')).toArray();
      expect(rows).toHaveLength(0);
    });

    it('handles values with single quotes', async () => {
      await table.add([{ id: '6', relativePath: "it's/a/test.ts", tag: 'quoted' }]);
      const rows = await table.query().where(eq('relativePath', "it's/a/test.ts")).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].tag).toBe('quoted');
    });
  });

  describe('or()', () => {
    it('matches multiple values with OR', async () => {
      const rows = await table
        .query()
        .where(or(eq('id', '1'), eq('id', '3')))
        .toArray();
      expect(rows).toHaveLength(2);
      const tags = rows.map((r: Record<string, unknown>) => r.tag).sort();
      expect(tags).toEqual(['normal', 'underscore']);
    });

    it('deletes multiple rows with OR predicate', async () => {
      await table.delete(or(eq('id', '1'), eq('id', '2')));
      const remaining = await table.query().toArray();
      expect(remaining).toHaveLength(3);
      expect(remaining.map((r: Record<string, unknown>) => r.id).sort()).toEqual(['3', '4', '5']);
    });
  });

  describe('likePrefix() with ESCAPE clause', () => {
    it('matches rows with matching prefix', async () => {
      const rows = await table.query().where(likePrefix('relativePath', 'src/main')).toArray();
      expect(rows).toHaveLength(2);
      const tags = rows.map((r: Record<string, unknown>) => r.tag).sort();
      expect(tags).toEqual(['nested', 'normal']);
    });

    it('treats literal % in prefix as non-wildcard', async () => {
      const rows = await table.query().where(likePrefix('relativePath', 'src/100%')).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].tag).toBe('percent');
    });

    it('treats literal _ in prefix as non-wildcard', async () => {
      const rows = await table.query().where(likePrefix('relativePath', 'src/file_name')).toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0].tag).toBe('underscore');
    });

    it('returns empty for non-matching prefix', async () => {
      const rows = await table.query().where(likePrefix('relativePath', 'nonexistent')).toArray();
      expect(rows).toHaveLength(0);
    });
  });
});
