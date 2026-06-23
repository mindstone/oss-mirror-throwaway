/**
 * LanceDB/DataFusion SQL predicate helpers.
 *
 * LanceDB uses Apache DataFusion for SQL parsing. DataFusion treats double-quoted
 * identifiers as string literals (not column references) for camelCase names, causing
 * predicates like `"sessionId" = 'abc'` to silently match nothing. Backtick quoting
 * (`sessionId`) correctly references columns.
 *
 * Use these helpers instead of hand-rolling SQL predicates to prevent this bug class.
 */

/** Escape a string value for use in a LanceDB SQL predicate (single-quote escaping). */
export function escapeValue(value: string): string {
  return value.replace(/'/g, "''");
}

function quoteIdentifier(column: string): string {
  return `\`${column.replace(/`/g, '``')}\``;
}

/** Build an equality predicate: `column` = 'value' */
export function eq(column: string, value: string): string {
  return `${quoteIdentifier(column)} = '${escapeValue(value)}'`;
}

/** Build an inequality predicate: `column` != 'value' */
export function notEq(column: string, value: string): string {
  return `${quoteIdentifier(column)} != '${escapeValue(value)}'`;
}

/** Build an IN predicate: `column` IN ('value1', 'value2'); empty values match nothing. */
export function inAny(column: string, values: string[]): string {
  if (values.length === 0) {
    return '1=0';
  }
  if (values.length === 1) {
    return eq(column, values[0]);
  }
  return `${quoteIdentifier(column)} IN (${values.map((value) => `'${escapeValue(value)}'`).join(', ')})`;
}

/**
 * Build a "greater than or equal" predicate for a NUMERIC column: `column` >= value.
 *
 * The value is emitted as an unquoted numeric literal (NOT a string literal), so the
 * column must be numeric (e.g. a millisecond timestamp). Non-finite values are rejected
 * to avoid emitting `NaN`/`Infinity` into the SQL, which DataFusion would not parse.
 */
export function gte(column: string, value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`gte(${column}): value must be a finite number, got ${value}`);
  }
  return `${quoteIdentifier(column)} >= ${value}`;
}

/** Build an "IS NULL" predicate: `column` IS NULL */
export function isNull(column: string): string {
  return `${quoteIdentifier(column)} IS NULL`;
}

/** Build a compound AND predicate from multiple conditions. */
export function and(...predicates: string[]): string {
  return predicates.join(' AND ');
}

/** Build a compound OR predicate from multiple conditions. */
export function or(...predicates: string[]): string {
  if (predicates.length === 0) {
    return '1=0';
  }
  if (predicates.length === 1) {
    return predicates[0];
  }
  return `(${predicates.join(' OR ')})`;
}

function escapeLikeValue(value: string): string {
  return escapeValue(value).replace(/[\\%_]/g, (match) => {
    if (match === '\\') {
      return '\\\\';
    }
    return `\\${match}`;
  });
}

/** Build a LIKE prefix predicate: `column` LIKE 'prefix%' ESCAPE '\' */
export function likePrefix(column: string, prefix: string): string {
  return `${quoteIdentifier(column)} LIKE '${escapeLikeValue(prefix)}%' ESCAPE '\\'`;
}
