export interface TranscriptSource {
  label?: string;
}

export const TRANSCRIPT_SOURCE_SLUGS = new Set<string>([
  'transcript-analysis',
  'process-plaud-recording',
]);

/**
 * Returns true when the source label identifies a transcript/recording source.
 */
export function isTranscriptSource(source: TranscriptSource | string | null | undefined): boolean {
  const label = typeof source === 'string' ? source : source?.label;
  if (!label) return false;

  const slug = label.toLowerCase().replace(/\s+/g, '-');
  return TRANSCRIPT_SOURCE_SLUGS.has(slug);
}
