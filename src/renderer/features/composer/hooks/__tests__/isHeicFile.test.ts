import { describe, it, expect } from 'vitest';
import { isHeicFile } from '../useFileAttachments';

function makeFile(name: string, type: string): File {
  return new File([''], name, { type });
}

describe('isHeicFile', () => {
  it('detects image/heic MIME type', () => {
    expect(isHeicFile(makeFile('photo.heic', 'image/heic'))).toBe(true);
  });

  it('detects image/heif MIME type', () => {
    expect(isHeicFile(makeFile('photo.heif', 'image/heif'))).toBe(true);
  });

  it('detects MIME type case-insensitively', () => {
    expect(isHeicFile(makeFile('photo.heic', 'IMAGE/HEIC'))).toBe(true);
    expect(isHeicFile(makeFile('photo.heif', 'Image/Heif'))).toBe(true);
  });

  it('detects .heic extension when MIME type is empty', () => {
    expect(isHeicFile(makeFile('IMG_1234.heic', ''))).toBe(true);
  });

  it('detects .heif extension when MIME type is empty', () => {
    expect(isHeicFile(makeFile('IMG_1234.heif', ''))).toBe(true);
  });

  it('detects extension case-insensitively', () => {
    expect(isHeicFile(makeFile('photo.HEIC', ''))).toBe(true);
    expect(isHeicFile(makeFile('photo.Heif', ''))).toBe(true);
  });

  it('detects .heic extension with generic MIME type', () => {
    expect(isHeicFile(makeFile('photo.heic', 'application/octet-stream'))).toBe(true);
  });

  it('rejects standard image types', () => {
    expect(isHeicFile(makeFile('photo.jpg', 'image/jpeg'))).toBe(false);
    expect(isHeicFile(makeFile('photo.png', 'image/png'))).toBe(false);
    expect(isHeicFile(makeFile('photo.gif', 'image/gif'))).toBe(false);
    expect(isHeicFile(makeFile('photo.webp', 'image/webp'))).toBe(false);
  });

  it('rejects non-image files', () => {
    expect(isHeicFile(makeFile('doc.pdf', 'application/pdf'))).toBe(false);
    expect(isHeicFile(makeFile('file.txt', 'text/plain'))).toBe(false);
  });
});
