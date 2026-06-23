export function validateContiguousChunkRange(
  state: { chunks: Array<{ index: number }> },
  totalChunks: number,
): { isValid: boolean; missing: number[]; extras: number[] } {
  const indexSet = new Set(state.chunks.map((chunk) => chunk.index));
  const missing: number[] = [];
  for (let i = 0; i < totalChunks; i++) {
    if (!indexSet.has(i)) missing.push(i);
  }

  const extras = state.chunks
    .map((chunk) => chunk.index)
    .filter((index) => index >= totalChunks)
    .sort((a, b) => a - b);

  return {
    isValid: missing.length === 0 && extras.length === 0,
    missing,
    extras,
  };
}
