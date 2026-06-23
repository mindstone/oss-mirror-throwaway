/**
 * String Sanitization Utilities
 *
 * Utilities for sanitizing strings before sending to external APIs.
 */

/**
 * Remove unpaired UTF-16 surrogates from a string.
 *
 * JavaScript strings use UTF-16, where characters above U+FFFF (emoji, rare scripts)
 * are represented as surrogate pairs (high surrogate U+D800-U+DBFF followed by
 * low surrogate U+DC00-U+DFFF). If a string operation like .slice() cuts between
 * a surrogate pair, it creates an unpaired surrogate which produces invalid JSON.
 *
 * This function replaces unpaired surrogates with U+FFFD (replacement character).
 *
 * @example
 * // Normal string with emoji - unchanged
 * sanitizeSurrogates('Hello 🧠 World') // => 'Hello 🧠 World'
 *
 * // String with unpaired high surrogate - replaced
 * sanitizeSurrogates('test\uD83E') // => 'test\uFFFD'
 */
export function sanitizeSurrogates(str: string): string {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);

    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate - check if followed by low surrogate
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // Valid pair - keep both
        result += str[i] + str[i + 1];
        i++; // Skip the low surrogate
      } else {
        // Unpaired high surrogate - replace
        result += '\ufffd';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Low surrogate without preceding high - replace
      result += '\ufffd';
    } else {
      // Normal character
      result += str[i];
    }
  }
  return result;
}
