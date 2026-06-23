export interface SurrogateIssue {
  index: number;
  seq: string;
}

export interface SerdeStrictnessIssues {
  loneSurrogateEscapes: SurrogateIssue[];
  rawLoneSurrogates: number[];
}

/**
 * Escape-aware scan for unpaired surrogate escape sequences in JSON text.
 * JS JSON.parse accepts these, but serde_json rejects them.
 */
export function findLoneSurrogateEscapes(text: string): SurrogateIssue[] {
  const findings: SurrogateIssue[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '\\') {
      i += 1;
      continue;
    }

    const next = text[i + 1];
    if (next === '\\') {
      i += 2;
      continue;
    }

    if (next !== 'u') {
      i += 2;
      continue;
    }

    const hex = text.slice(i + 2, i + 6);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      i += 2;
      continue;
    }

    const code = Number.parseInt(hex, 16);
    if (code >= 0xd800 && code <= 0xdbff) {
      const tail = text.slice(i + 6, i + 12);
      const tailMatch = /^\\u([0-9a-fA-F]{4})$/.exec(tail);
      const tailCode = tailMatch ? Number.parseInt(tailMatch[1], 16) : -1;
      if (tailCode >= 0xdc00 && tailCode <= 0xdfff) {
        i += 12;
        continue;
      }
      findings.push({ index: i, seq: `\\u${hex}` });
      i += 6;
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      findings.push({ index: i, seq: `\\u${hex}` });
      i += 6;
      continue;
    }

    i += 6;
  }

  return findings;
}

/**
 * Scan decoded text for raw unpaired surrogates (U+D800..U+DFFF).
 */
export function findRawLoneSurrogates(text: string): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const nextCode = i + 1 < text.length ? text.charCodeAt(i + 1) : -1;
      if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        i += 1;
        continue;
      }
      indexes.push(i);
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      indexes.push(i);
    }
  }
  return indexes;
}

/**
 * Validate JSON text against serde_json's lone-surrogate strictness.
 */
export function collectSerdeStrictnessIssues(jsonText: string): SerdeStrictnessIssues {
  return {
    loneSurrogateEscapes: findLoneSurrogateEscapes(jsonText),
    rawLoneSurrogates: findRawLoneSurrogates(jsonText),
  };
}
