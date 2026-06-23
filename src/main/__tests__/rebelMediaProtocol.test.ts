import { describe, expect, it } from 'vitest';

import {
  getRebelMediaMimeType,
  parseRebelMediaRange,
  buildRebelMediaResponseInit,
} from '../services/rebelMediaProtocol';

/**
 * Contract test for the rebel-media:// protocol's content-type + range handling
 * (the parts PDFium depends on). The full handler lives as a closure in
 * `index.ts` (needs Electron protocol.handle + a Node read stream for the body),
 * but the contract-bearing pieces are extracted here so they're testable without
 * registering a protocol or touching the real filesystem.
 *
 * PDF preview (260619 fix) is served over rebel-media:// rather than a
 * renderer-origin blob: URL (which left the packaged preview blank; the exact
 * blob:file:// fetch mechanism is runtime-UNCONFIRMED, the protocol path robust
 * regardless). This locks the byte-path PDFium fetches: application/pdf,
 * 200 + Content-Length, and Range → 206 + Content-Range.
 */
describe('rebel-media MIME map', () => {
  it('maps .pdf → application/pdf (the PDFium content-type contract)', () => {
    expect(getRebelMediaMimeType('.pdf')).toBe('application/pdf');
  });

  it('is case-insensitive on the extension', () => {
    expect(getRebelMediaMimeType('.PDF')).toBe('application/pdf');
  });

  it('keeps the existing video/audio mappings', () => {
    expect(getRebelMediaMimeType('.mp4')).toBe('video/mp4');
    expect(getRebelMediaMimeType('.mp3')).toBe('audio/mpeg');
  });

  it('falls back to application/octet-stream for unknown extensions', () => {
    expect(getRebelMediaMimeType('.xyz')).toBe('application/octet-stream');
  });
});

describe('rebel-media response for a .pdf request', () => {
  const fileSize = 338_791; // matches the user's repro PDF
  const contentType = getRebelMediaMimeType('.pdf');

  it('no Range header → 200 with application/pdf + Content-Length + Accept-Ranges', () => {
    const rangeResult = parseRebelMediaRange(null, fileSize);
    expect(rangeResult.kind).toBe('full');

    const init = buildRebelMediaResponseInit(rangeResult, fileSize, contentType);
    expect(init.status).toBe(200);
    expect(init.headers['Content-Type']).toBe('application/pdf');
    expect(init.headers['Content-Length']).toBe(String(fileSize));
    expect(init.headers['Accept-Ranges']).toBe('bytes');
  });

  it('honors a Range header → 206 with application/pdf + Content-Range + chunk Content-Length', () => {
    const rangeResult = parseRebelMediaRange('bytes=0-1023', fileSize);
    expect(rangeResult).toEqual({ kind: 'partial', range: { start: 0, end: 1023 } });

    const init = buildRebelMediaResponseInit(rangeResult, fileSize, contentType);
    expect(init.status).toBe(206);
    expect(init.headers['Content-Type']).toBe('application/pdf');
    expect(init.headers['Content-Range']).toBe(`bytes 0-1023/${fileSize}`);
    expect(init.headers['Content-Length']).toBe('1024');
    expect(init.headers['Accept-Ranges']).toBe('bytes');
  });

  it('open-ended Range (bytes=1024-) clamps end to last byte', () => {
    const rangeResult = parseRebelMediaRange('bytes=1024-', fileSize);
    expect(rangeResult).toEqual({ kind: 'partial', range: { start: 1024, end: fileSize - 1 } });

    const init = buildRebelMediaResponseInit(rangeResult, fileSize, contentType);
    expect(init.status).toBe(206);
    expect(init.headers['Content-Range']).toBe(`bytes 1024-${fileSize - 1}/${fileSize}`);
    expect(init.headers['Content-Length']).toBe(String(fileSize - 1024));
  });

  it('suffix Range (bytes=-500) serves the last 500 bytes', () => {
    const rangeResult = parseRebelMediaRange('bytes=-500', fileSize);
    expect(rangeResult).toEqual({ kind: 'partial', range: { start: fileSize - 500, end: fileSize - 1 } });

    const init = buildRebelMediaResponseInit(rangeResult, fileSize, contentType);
    expect(init.status).toBe(206);
    expect(init.headers['Content-Length']).toBe('500');
  });
});

describe('rebel-media unsatisfiable ranges → 416', () => {
  const fileSize = 1000;

  it('multi-range (comma-separated) → unsatisfiable', () => {
    expect(parseRebelMediaRange('bytes=0-10,20-30', fileSize).kind).toBe('unsatisfiable');
  });

  it('start beyond file size → unsatisfiable', () => {
    expect(parseRebelMediaRange('bytes=5000-', fileSize).kind).toBe('unsatisfiable');
  });

  it('malformed header → unsatisfiable', () => {
    expect(parseRebelMediaRange('weird-not-a-range', fileSize).kind).toBe('unsatisfiable');
  });

  it('builds a 416 with Content-Range: bytes */<size>', () => {
    const init = buildRebelMediaResponseInit({ kind: 'unsatisfiable' }, fileSize, 'application/pdf');
    expect(init.status).toBe(416);
    expect(init.headers['Content-Range']).toBe(`bytes */${fileSize}`);
  });
});
