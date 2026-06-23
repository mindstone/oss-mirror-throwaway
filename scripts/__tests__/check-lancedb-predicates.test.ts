import { describe, expect, it } from 'vitest';
import { findLanceDbPredicateViolations } from '../check-lancedb-predicates';

describe('findLanceDbPredicateViolations', () => {
  describe('FTS camelCase column rule', () => {
    it('flags camelCase in createIndex', () => {
      const source = `await table.createIndex('searchText', {
        config: lancedb.Index.fts({ stem: true })
      });`;
      const violations = findLanceDbPredicateViolations(source, 'src/main/services/foo.ts');
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toContain('fts-camelcase-column');
      expect(violations[0].rule).toContain('searchText');
    });

    it('flags camelCase in MultiMatchQuery', () => {
      const source = `const ftsQuery = new lancedb.MultiMatchQuery(query, ['searchText']);`;
      const violations = findLanceDbPredicateViolations(source, 'src/main/services/foo.ts');
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toContain('fts-camelcase-column');
    });

    it('allows snake_case in createIndex', () => {
      const source = `await table.createIndex('search_text', {
        config: lancedb.Index.fts({ stem: true })
      });`;
      const violations = findLanceDbPredicateViolations(source, 'src/main/services/foo.ts');
      expect(violations).toHaveLength(0);
    });

    it('allows snake_case in MultiMatchQuery', () => {
      const source = `const ftsQuery = new lancedb.MultiMatchQuery(query, ['title', 'search_text']);`;
      const violations = findLanceDbPredicateViolations(source, 'src/main/services/foo.ts');
      expect(violations).toHaveLength(0);
    });

    it('allows lowercase single-word columns', () => {
      const source = `await table.createIndex('content', {
        config: lancedb.Index.fts({ stem: true })
      });`;
      const violations = findLanceDbPredicateViolations(source, 'src/main/services/foo.ts');
      expect(violations).toHaveLength(0);
    });
  });
});
