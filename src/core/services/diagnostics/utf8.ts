const encoder = new TextEncoder();

export function payloadBytes(payload: unknown): number {
  return encoder.encode(JSON.stringify(payload)).byteLength;
}

export function utf8ByteLength(input: string): number {
  return encoder.encode(input).byteLength;
}

export function clipUtf8Tail(input: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8ByteLength(input) <= maxBytes) return input;
  let low = 0;
  let high = input.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const slice = input.slice(input.length - mid);
    if (utf8ByteLength(slice) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return input.slice(input.length - low);
}
