import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Construction guard (260619 PDF-blank fix).
 *
 * The packaged in-app PDF preview rendered a blank grey panel. The leading
 * cross-family hypothesis was that Chromium's out-of-process PDF viewer
 * (MimeHandlerView) cannot fetch a renderer-owned `blob:file://…` source — but
 * that exact mechanism is runtime-UNCONFIRMED (a standalone unpackaged repro
 * rendered the old blob path fine). Either way, serving PDFs over the
 * origin-independent `rebel-media://` protocol is the robust packaged path (it
 * eliminates every plausible packaged-only blob/origin cause), so the
 * renderer-origin blob must not come back.
 *
 * This test fails by construction if anyone reintroduces `URL.createObjectURL`
 * (a renderer-origin blob) into the PDF render path — both the file-IO hook and
 * the DocumentRenderers component. It is deliberately a source-text assertion so
 * it can't be defeated by a refactor that keeps the behaviour but moves the call.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const docEditorRoot = path.resolve(here, '..', '..');

const read = (relPath: string): string =>
  readFileSync(path.join(docEditorRoot, relPath), 'utf8');

describe('PDF preview never uses a renderer-origin blob', () => {
  it('useDocumentFileIO does not call URL.createObjectURL', () => {
    const src = read('hooks/useDocumentFileIO.ts');
    expect(src).not.toMatch(/createObjectURL/);
  });

  it('DocumentRenderers does not call URL.createObjectURL', () => {
    const src = read('components/DocumentRenderers.tsx');
    expect(src).not.toMatch(/createObjectURL/);
  });

  it('the PDF branch resolves a rebel-media:// URL via getMediaProtocolUrl', () => {
    const src = read('hooks/useDocumentFileIO.ts');
    // The PDF branch (category === 'pdf') must route through getMediaProtocolUrl,
    // the same helper the video/audio branch uses.
    const pdfBranchStart = src.indexOf("if (category === 'pdf')");
    expect(pdfBranchStart).toBeGreaterThan(-1);
    const pdfBranch = src.slice(pdfBranchStart, pdfBranchStart + 1200);
    expect(pdfBranch).toMatch(/getMediaProtocolUrl/);
    expect(pdfBranch).not.toMatch(/new Blob\(/);
  });
});
