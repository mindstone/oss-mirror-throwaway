/**
 * MCP Inbox Schema Parity — Ensures rebel_inbox_update accepts all non-add-only
 * fields from rebel_inbox_add, preventing the class of bugs where a field is
 * accepted on add but silently rejected on update (REBEL-13Y).
 *
 * Run: npx vitest run scripts/__tests__/mcp-inbox-schema-parity.test.ts
 *
 * @see resources/mcp/rebel-inbox/server.cjs
 * @see docs-private/postmortems/260430_rebel_inbox_update_category_field_postmortem.md
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const SERVER_PATH = join(__dirname, '..', '..', 'resources', 'mcp', 'rebel-inbox', 'server.cjs');
const source = readFileSync(SERVER_PATH, 'utf8');

/**
 * Extract field names from a z.object({...}) schema definition in the source.
 * Matches lines like `  fieldName: z.something(...)` within the schema block.
 */
function extractSchemaFields(schemaName: string): string[] {
  // Match the schema declaration and its object body
  const schemaRegex = new RegExp(
    `const ${schemaName} = z\\.object\\(\\{([^}]+(?:\\{[^}]*\\}[^}]*)*)\\}\\)`,
    's'
  );
  const match = source.match(schemaRegex);
  if (!match) return [];

  const body = match[1];
  // Extract field names (word at start of line before colon)
  const fieldRegex = /^\s+(\w+)\s*:/gm;
  const fields: string[] = [];
  let fieldMatch;
  while ((fieldMatch = fieldRegex.exec(body)) !== null) {
    fields.push(fieldMatch[1]);
  }
  return fields;
}

describe('MCP Inbox Schema Parity', () => {
  const addFields = extractSchemaFields('addTaskSchema');
  const updateFields = extractSchemaFields('updateTaskSchema');

  it('should parse addTaskSchema fields', () => {
    expect(addFields.length).toBeGreaterThan(5);
    expect(addFields).toContain('title');
    expect(addFields).toContain('category');
    expect(addFields).toContain('tags');
  });

  it('should parse updateTaskSchema fields', () => {
    expect(updateFields.length).toBeGreaterThan(5);
    expect(updateFields).toContain('title');
  });

  // Fields that only make sense on add (not applicable to update).
  // Each exclusion must be justified — this list is intentionally short.
  const ADD_ONLY_FIELDS = new Set([
    'actions',  // Actions are set on creation, not editable via update
    'priority', // Deprecated — update uses urgent/important directly (Eisenhower matrix); applyInboxItemPatch doesn't process priority
  ]);

  // Fields that only exist on update (not applicable to add)
  const UPDATE_ONLY_FIELDS = new Set([
    'id',       // Required to identify which item to update
    'taskId',   // Alias for id
    'archived', // Archive/unarchive — not set on creation
  ]);

  it('updateTaskSchema should accept all non-add-only fields from addTaskSchema', () => {
    const missingInUpdate = addFields.filter(
      (field) => !ADD_ONLY_FIELDS.has(field) && !updateFields.includes(field)
    );
    expect(missingInUpdate).toEqual([]);
  });

  it('updateTaskSchema accepts the advisory archival fields the model emits (REBEL-61R)', () => {
    // When archiving an item with completion evidence, models attach archiveReason
    // and evidenceNote (documenting why + the evidence). These must be accepted, not
    // rejected as unknown fields — 195 users hit the -33003 rejection before this fix.
    expect(updateFields).toContain('archiveReason');
    expect(updateFields).toContain('evidenceNote');
  });

  it('addTaskSchema should not have unexpected fields missing from updateTaskSchema', () => {
    // This is a documentation assertion — any field in ADD_ONLY_FIELDS should
    // have a comment justifying why it's excluded from update
    for (const field of ADD_ONLY_FIELDS) {
      expect(addFields).toContain(field);
    }
  });
});
