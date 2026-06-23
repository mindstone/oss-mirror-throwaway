/**
 * SHA-256 hex digest of a UTF-8 string (Web Crypto). Matches main-process hashing for shared-skill baselines.
 */
export async function sha256HexUtf8(text: string): Promise<string> {
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
