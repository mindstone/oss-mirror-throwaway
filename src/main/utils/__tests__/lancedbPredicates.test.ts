import { describe, expect, it } from 'vitest';
import { escapeValue, eq, and, gte, inAny, isNull, likePrefix, notEq, or } from '../lancedbPredicates';

describe('lancedbPredicates', () => {
  describe('escapeValue', () => {
    it('escapes single quotes', () => {
      expect(escapeValue("it's")).toBe("it''s");
    });
    it('passes through safe strings unchanged', () => {
      expect(escapeValue('hello')).toBe('hello');
    });
  });

  describe('eq', () => {
    it('produces backtick-quoted column = value', () => {
      expect(eq('sessionId', 'abc-123')).toBe("`sessionId` = 'abc-123'");
    });
    it('escapes single quotes in value', () => {
      expect(eq('title', "it's a test")).toBe("`title` = 'it''s a test'");
    });
  });

  describe('notEq', () => {
    it('produces backtick-quoted column != value', () => {
      expect(notEq('path', '/tmp/source.md')).toBe("`path` != '/tmp/source.md'");
    });

    it('escapes single quotes in value', () => {
      expect(notEq('title', "isn't source")).toBe("`title` != 'isn''t source'");
    });

    it('backtick-escapes column names', () => {
      expect(notEq('co`l', 'value')).toBe("`co``l` != 'value'");
    });

    it('leaves value backticks literal', () => {
      expect(notEq('path', 'tick`value')).toBe("`path` != 'tick`value'");
    });

    it('composes with and predicates', () => {
      expect(and(notEq('path', 'a'), eq('extension', '.md'))).toBe(
        "`path` != 'a' AND `extension` = '.md'"
      );
    });
  });

  describe('and', () => {
    it('joins predicates with AND', () => {
      expect(and(eq('a', '1'), eq('b', '2'))).toBe("`a` = '1' AND `b` = '2'");
    });
  });

  describe('likePrefix', () => {
    it('produces backtick-quoted column LIKE prefix%', () => {
      expect(likePrefix('relativePath', 'src/main')).toBe("`relativePath` LIKE 'src/main%' ESCAPE '\\'");
    });
    it('escapes single quotes in prefix', () => {
      expect(likePrefix('path', "it's")).toBe("`path` LIKE 'it''s%' ESCAPE '\\'");
    });
    it('escapes percent wildcards in prefix', () => {
      expect(likePrefix('path', '100% real')).toBe("`path` LIKE '100\\% real%' ESCAPE '\\'");
    });
    it('escapes underscore wildcards in prefix', () => {
      expect(likePrefix('path', 'file_name')).toBe("`path` LIKE 'file\\_name%' ESCAPE '\\'");
    });
    it('escapes backslashes in prefix', () => {
      expect(likePrefix('path', String.raw`folder\name`)).toBe("`path` LIKE 'folder\\\\name%' ESCAPE '\\'");
    });
  });

  describe('inAny', () => {
    it('returns false predicate for empty arrays', () => {
      expect(inAny('col', [])).toBe('1=0');
    });

    it('returns eq-equivalent predicate for one value', () => {
      expect(inAny('col', ['a'])).toBe("`col` = 'a'");
    });

    it('returns IN predicate for multiple values', () => {
      expect(inAny('col', ['a', 'b', 'c'])).toBe("`col` IN ('a', 'b', 'c')");
    });

    it('escapes single quotes in values', () => {
      expect(inAny('col', ["it's"])).toBe("`col` = 'it''s'");
    });

    it('backtick-escapes column names while leaving value backticks literal', () => {
      expect(inAny('co`l', ['tick`value'])).toBe("`co``l` = 'tick`value'");
    });

    it('composes with or predicates', () => {
      expect(or(inAny('a', ['1', '2']), eq('b', '3'))).toBe(
        "(`a` IN ('1', '2') OR `b` = '3')"
      );
    });
  });

  describe('gte', () => {
    it('produces a backtick-quoted column >= unquoted numeric literal', () => {
      expect(gte('updatedAt', 1750000000000)).toBe('`updatedAt` >= 1750000000000');
    });
    it('backtick-escapes column names', () => {
      expect(gte('up`dated', 5)).toBe('`up``dated` >= 5');
    });
    it('rejects non-finite values (no NaN/Infinity in DataFusion SQL)', () => {
      expect(() => gte('updatedAt', Number.NaN)).toThrow();
      expect(() => gte('updatedAt', Number.POSITIVE_INFINITY)).toThrow();
    });
    it('composes with or + isNull (the recency grace-fallback predicate)', () => {
      expect(or(gte('updatedAt', 100), isNull('updatedAt'))).toBe(
        '(`updatedAt` >= 100 OR `updatedAt` IS NULL)'
      );
    });
  });

  describe('isNull', () => {
    it('produces a backtick-quoted column IS NULL', () => {
      expect(isNull('updatedAt')).toBe('`updatedAt` IS NULL');
    });
    it('backtick-escapes column names', () => {
      expect(isNull('co`l')).toBe('`co``l` IS NULL');
    });
  });

  describe('or', () => {
    it('returns false predicate for zero args', () => {
      expect(or()).toBe('1=0');
    });
    it('returns the predicate unchanged for one arg', () => {
      expect(or(eq('a', '1'))).toBe("`a` = '1'");
    });
    it('wraps two predicates in parentheses', () => {
      expect(or(eq('a', '1'), eq('b', '2'))).toBe("(`a` = '1' OR `b` = '2')");
    });
    it('wraps three or more predicates in parentheses', () => {
      expect(or(eq('a', '1'), eq('b', '2'), eq('c', '3'))).toBe(
        "(`a` = '1' OR `b` = '2' OR `c` = '3')"
      );
    });
    it('composes with eq predicates', () => {
      expect(or(eq('sessionId', 'abc'), eq('sessionId', 'def'))).toBe(
        "(`sessionId` = 'abc' OR `sessionId` = 'def')"
      );
    });
  });
});
