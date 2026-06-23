import { ANTHROPIC_IMAGE_BYTE_LIMIT, nextDimensionForByteTarget } from '../attachmentLimits';
import { estimateBase64Bytes, getBase64EncodedByteLength } from '../fileAttachmentUtils';

describe('nextDimensionForByteTarget', () => {
  it('returns current dimension unchanged when already under the byte target', () => {
    expect(nextDimensionForByteTarget(8000, ANTHROPIC_IMAGE_BYTE_LIMIT - 1, ANTHROPIC_IMAGE_BYTE_LIMIT)).toBe(8000);
  });

  it('converges in one pass for the production 12.5MB-to-5MB case at 8000px', () => {
    // 12_494_812 is the base64 STRING byte length from the production
    // Anthropic 400 error: "image exceeds 5 MB maximum: 12494812 bytes >
    // 5242880 bytes". This helper compares against the same units.
    const currentBytes = 12_494_812;
    const nextDimension = nextDimensionForByteTarget(8000, currentBytes, ANTHROPIC_IMAGE_BYTE_LIMIT);

    expect(nextDimension).toBe(4923);

    // Approximate PNG/JPEG byte scaling by pixel area (good enough for ladder planning).
    const estimatedBytesAfterSinglePass = Math.ceil(currentBytes * (nextDimension / 8000) ** 2);
    expect(estimatedBytesAfterSinglePass).toBeLessThanOrEqual(ANTHROPIC_IMAGE_BYTE_LIMIT);
  });

  it('floors at 512px when the ratio would reduce below that', () => {
    expect(nextDimensionForByteTarget(600, ANTHROPIC_IMAGE_BYTE_LIMIT * 100, ANTHROPIC_IMAGE_BYTE_LIMIT)).toBe(512);
  });

  it('returns identical dimension when already at the 512px floor and still over limit', () => {
    expect(nextDimensionForByteTarget(512, ANTHROPIC_IMAGE_BYTE_LIMIT * 3, ANTHROPIC_IMAGE_BYTE_LIMIT)).toBe(512);
  });

  it('honors a custom minimum dimension floor', () => {
    expect(nextDimensionForByteTarget(2000, ANTHROPIC_IMAGE_BYTE_LIMIT * 30, ANTHROPIC_IMAGE_BYTE_LIMIT, 0.95, 768)).toBe(768);
  });
});

describe('getBase64EncodedByteLength vs estimateBase64Bytes', () => {
  // Distinct units matter: Anthropic's 5 MB per-image limit is checked on the
  // base64 string byte length (what `getBase64EncodedByteLength` returns),
  // NOT the decoded payload size (what `estimateBase64Bytes` returns).
  // Confusing the two underestimates the budget by ~25% and lets oversize
  // images slip past the byte-aware ladder.

  it('getBase64EncodedByteLength returns the base64 string byte length (not decoded)', () => {
    // Each base64 char is 1 byte (ASCII).
    const base64 = 'A'.repeat(12_494_812);
    expect(getBase64EncodedByteLength(base64)).toBe(12_494_812);
  });

  it('estimateBase64Bytes returns ~75% of the encoded length (decoded size)', () => {
    const base64 = 'A'.repeat(12_494_812);
    expect(estimateBase64Bytes(base64)).toBe(Math.ceil((12_494_812 * 3) / 4));
  });

  it('regression: production 12.5MB base64 must compare with encoded length, not decoded', () => {
    // Reproduces the bug Reviewer 1 caught: comparing decoded bytes against
    // ANTHROPIC_IMAGE_BYTE_LIMIT lets a 6.7MB base64 string slip through
    // (decoded ~5MB) and Anthropic still rejects it.
    const productionBase64Length = 12_494_812;
    const fakeBase64 = 'A'.repeat(productionBase64Length);

    const encodedBytes = getBase64EncodedByteLength(fakeBase64);
    const decodedBytes = estimateBase64Bytes(fakeBase64);

    // Encoded must exceed the limit (this is what Anthropic measures).
    expect(encodedBytes).toBeGreaterThan(ANTHROPIC_IMAGE_BYTE_LIMIT);

    // Decoded would NOT exceed the limit — easy to confuse.
    expect(decodedBytes).toBeLessThan(ANTHROPIC_IMAGE_BYTE_LIMIT * 2);
    expect(decodedBytes).toBeGreaterThan(ANTHROPIC_IMAGE_BYTE_LIMIT);

    // The byte-aware ladder must be told the encoded length to do the right
    // thing. Comparing decoded to the limit would still yield a valid next
    // dimension here, but for borderline cases (~5-6 MB encoded), it would
    // stop too early.
  });
});
