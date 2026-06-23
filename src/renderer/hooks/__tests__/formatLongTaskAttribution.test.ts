import { describe, it, expect } from 'vitest';
import { formatLongTaskAttribution } from '../useDevPerformanceMonitor';

/**
 * Tests for the formatLongTaskAttribution pure function.
 *
 * Uses plain objects cast to PerformanceEntry since we only access
 * the non-standard `attribution` property via feature detection.
 */

function makeEntry(attribution?: unknown): PerformanceEntry {
  return { attribution } as unknown as PerformanceEntry;
}

describe('formatLongTaskAttribution', () => {
  it('returns null when entry has no attribution property', () => {
    const entry = {} as PerformanceEntry;
    expect(formatLongTaskAttribution(entry)).toBeNull();
  });

  it('returns null when attribution is undefined', () => {
    const entry = makeEntry(undefined);
    expect(formatLongTaskAttribution(entry)).toBeNull();
  });

  it('returns null when attribution is not an array', () => {
    const entry = makeEntry('not-an-array');
    expect(formatLongTaskAttribution(entry)).toBeNull();
  });

  it('returns null when attribution is an empty array', () => {
    const entry = makeEntry([]);
    expect(formatLongTaskAttribution(entry)).toBeNull();
  });

  it('formats containerType + containerName when both present', () => {
    const entry = makeEntry([{
      containerType: 'window',
      containerSrc: '',
      containerName: 'main',
      containerId: '',
    }]);
    expect(formatLongTaskAttribution(entry)).toBe('window(main)');
  });

  it('formats containerType + containerSrc when containerName is empty', () => {
    const entry = makeEntry([{
      containerType: 'iframe',
      containerSrc: 'https://example.com/widget.js',
      containerName: '',
      containerId: '',
    }]);
    expect(formatLongTaskAttribution(entry)).toBe('iframe(https://example.com/widget.js)');
  });

  it('prefers containerName over containerSrc when both present', () => {
    const entry = makeEntry([{
      containerType: 'window',
      containerSrc: 'https://example.com/app.js',
      containerName: 'main-frame',
      containerId: 'app',
    }]);
    expect(formatLongTaskAttribution(entry)).toBe('window(main-frame)');
  });

  it('returns containerType alone when both name and src are empty', () => {
    const entry = makeEntry([{
      containerType: 'window',
      containerSrc: '',
      containerName: '',
      containerId: '',
    }]);
    expect(formatLongTaskAttribution(entry)).toBe('window');
  });

  it('defaults containerType to "unknown" when missing', () => {
    const entry = makeEntry([{
      containerType: '',
      containerSrc: '',
      containerName: 'main',
      containerId: '',
    }]);
    expect(formatLongTaskAttribution(entry)).toBe('unknown(main)');
  });

  it('uses first attribution when multiple are present', () => {
    const entry = makeEntry([
      { containerType: 'window', containerSrc: '', containerName: 'first', containerId: '' },
      { containerType: 'iframe', containerSrc: '', containerName: 'second', containerId: '' },
    ]);
    expect(formatLongTaskAttribution(entry)).toBe('window(first)');
  });

  it('handles missing fields gracefully (partial attribution object)', () => {
    const entry = makeEntry([{ containerType: 'window' }]);
    expect(formatLongTaskAttribution(entry)).toBe('window');
  });

  it('handles null as first element in attribution array', () => {
    const entry = makeEntry([null]);
    expect(formatLongTaskAttribution(entry)).toBeNull();
  });
});
