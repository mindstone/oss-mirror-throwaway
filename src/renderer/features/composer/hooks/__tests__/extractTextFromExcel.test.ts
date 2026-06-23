/**
 * Regression test for extractTextFromExcel after the xlsx 0.18.5 -> 0.20.3 swap.
 *
 * The byte-for-byte CSV output of sheet_to_csv is the contract downstream attachment
 * pipelines (composer previews, agent tool input) depend on. If this test drifts,
 * investigate whether the xlsx version changed before "updating the golden".
 *
 * Fixtures were generated with xlsx 0.18.5 using scripts in /tmp/xlsx_rudder_spike/
 * (see docs/plans/260421_xlsx_and_rudderstack_security_bumps.md Stage 2b).
 *
 * The test exercises the *production code path* (calls extractTextFromExcel
 * exported from useFileAttachments.ts) rather than reimplementing the logic —
 * see docs/project/TESTING_AUTOMATION_OVERVIEW.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractTextFromExcel } from '../useFileAttachments';

const FIXTURE_DIR = resolve(__dirname, 'fixtures');

function loadFixture(name: string): ArrayBuffer {
  const buf = readFileSync(resolve(FIXTURE_DIR, name));
  // Return a real ArrayBuffer view (the slice ensures we don't hand over the whole Buffer pool)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

describe('extractTextFromExcel (xlsx 0.20.3)', () => {
  it('extracts a single-sheet xlsx with simple string/number cells', async () => {
    const out = await extractTextFromExcel(loadFixture('simple.xlsx'));
    expect(out).toBe(
      '=== Sheet: People ===\n' +
      'Name,Age,City\n' +
      'Alice,30,London\n' +
      'Bob,25,Paris\n' +
      'Carol,42,Tokyo'
    );
  });

  it('extracts a multi-sheet xlsx preserving sheet order, formulas evaluated', async () => {
    const out = await extractTextFromExcel(loadFixture('multisheet_formulas.xlsx'));
    // Formulas are evaluated in the written fixture (xlsx.write precomputes the result).
    expect(out).toContain('=== Sheet: Invoice ===');
    expect(out).toContain('Item,Qty,Price,Total');
    expect(out).toContain('Widget,3,9.99');
    expect(out).toContain('=== Sheet: Notes ===');
    expect(out).toContain('This sheet has just one column.');
    // Verify sheet order (Invoice before Notes)
    const invoiceIdx = out.indexOf('=== Sheet: Invoice ===');
    const notesIdx = out.indexOf('=== Sheet: Notes ===');
    expect(invoiceIdx).toBeGreaterThan(-1);
    expect(notesIdx).toBeGreaterThan(invoiceIdx);
  });

  it('extracts a sheet with merged cells without duplicating the merged value', async () => {
    const out = await extractTextFromExcel(loadFixture('merged.xlsx'));
    expect(out).toContain('=== Sheet: Q1 ===');
    expect(out).toContain('Q1 Report');
    expect(out).toContain('Region,Revenue,Profit');
    expect(out).toContain('North,1000,200');
    expect(out).toContain('South,1500,350');
    // The merged A1:C1 cell ("Q1 Report") should appear exactly once on row 1,
    // followed by the empty merged cells rendered as trailing commas.
    const lines = out.split('\n');
    const headerLine = lines.find((l) => l.startsWith('Q1 Report'));
    expect(headerLine).toBeDefined();
    // In sheet_to_csv, merged cells produce the value in the anchor + trailing commas.
    // This assertion just verifies Q1 Report isn't duplicated into B1/C1.
    expect(headerLine!.split(',').filter((c) => c === 'Q1 Report').length).toBe(1);
  });

  it('extracts legacy binary .xls (BIFF8) — .xls support preserved after 0.20.3 swap', async () => {
    // The xls format is one of the explicit reasons we kept SheetJS rather than switching to exceljs.
    // See docs/research/260421_xlsx_exploitability.md Option A rejection rationale.
    const out = await extractTextFromExcel(loadFixture('legacy.xls'));
    expect(out).toBe(
      '=== Sheet: Data ===\n' +
      'Year,Revenue\n' +
      '2023,100000\n' +
      '2024,150000'
    );
  });

  it('strips leading/trailing whitespace via trim()', async () => {
    // The function joins with '\n' then calls .trim(); verify a non-empty result doesn't end in newline.
    const out = await extractTextFromExcel(loadFixture('simple.xlsx'));
    expect(out).not.toMatch(/\n$/);
    expect(out).not.toMatch(/^\n/);
  });
});
