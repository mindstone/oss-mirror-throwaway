import { describe, expect, it } from 'vitest';
import { resolveExternalContextSourceLabel } from '../SessionSurfaceContent';

describe('resolveExternalContextSourceLabel', () => {
  it('uses Office document context when Office is the latest source', () => {
    expect(
      resolveExternalContextSourceLabel({
        appId: 'office-addin',
        tabContext: {
          url: 'https://example.com',
          title: 'Stale browser page',
        },
        documentContext: {
          host: 'word',
          title: 'Quarterly Plan.docx',
        },
      }),
    ).toBe('Quarterly Plan.docx');
  });

  it('uses browser host when the browser extension is the latest source', () => {
    expect(
      resolveExternalContextSourceLabel({
        appId: 'browser-extension',
        tabContext: {
          url: 'https://docs.example.com/reference',
          title: 'Docs',
        },
        documentContext: {
          host: 'word',
          title: 'Stale Draft.docx',
        },
      }),
    ).toBe('docs.example.com');
  });
});
