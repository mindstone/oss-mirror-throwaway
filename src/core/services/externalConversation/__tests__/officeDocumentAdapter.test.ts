import { describe, it, expect } from 'vitest';
import { OfficeDocumentAdapter, OFFICE_DOCUMENT_TOOLS } from '../adapters/officeDocumentAdapter';
import type { OfficeDocumentContext } from '../externalContext';

describe('OfficeDocumentAdapter', () => {
  it('getContextTools returns correct tools', () => {
    const adapter = new OfficeDocumentAdapter();
    expect(adapter.getContextTools()).toEqual(OFFICE_DOCUMENT_TOOLS);
  });

  it('formatInitialPrompt correctly formats the intent', () => {
    const adapter = new OfficeDocumentAdapter();
    const ctx: OfficeDocumentContext = {
      kind: 'office-document',
      identity: { host: 'excel', docId: 'test.xlsx' },
      metadata: { title: 'test.xlsx' },
    };

    const res = adapter.formatInitialPrompt({
      intent: 'summarise',
      context: ctx,
    });
    expect(res).toContain("Summarise the workbook I'm looking at.");
    expect(res).toContain('Workbook: test.xlsx');
  });

  it('deliverResponse returns delivered immediately', async () => {
    const adapter = new OfficeDocumentAdapter();
    const res = await adapter.deliverResponse();
    expect(res.status).toBe('delivered');
  });
});
