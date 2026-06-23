import { TRANSCRIPT_SOURCE_SLUGS, isTranscriptSource } from '../isTranscriptSource';

describe('isTranscriptSource', () => {
  it('exports expected transcript source slugs', () => {
    expect(TRANSCRIPT_SOURCE_SLUGS.has('transcript-analysis')).toBe(true);
    expect(TRANSCRIPT_SOURCE_SLUGS.has('process-plaud-recording')).toBe(true);
  });

  it('returns true for transcript source slugs', () => {
    expect(isTranscriptSource('transcript-analysis')).toBe(true);
    expect(isTranscriptSource('process-plaud-recording')).toBe(true);
  });

  it('normalises case and spacing', () => {
    expect(isTranscriptSource('Transcript Analysis')).toBe(true);
    expect(isTranscriptSource('PROCESS PLAUD RECORDING')).toBe(true);
  });

  it('supports source objects', () => {
    expect(isTranscriptSource({ label: 'transcript-analysis' })).toBe(true);
    expect(isTranscriptSource({ label: 'Onboarding Discovery' })).toBe(false);
  });

  it('returns false for unknown or empty inputs', () => {
    expect(isTranscriptSource('wins-and-learnings-uncover')).toBe(false);
    expect(isTranscriptSource(undefined)).toBe(false);
    expect(isTranscriptSource(null)).toBe(false);
    expect(isTranscriptSource('')).toBe(false);
    expect(isTranscriptSource({})).toBe(false);
  });
});
