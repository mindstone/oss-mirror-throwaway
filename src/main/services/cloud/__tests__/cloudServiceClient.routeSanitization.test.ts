/**
 * Tests for sanitizeRouteForLog: ensures payload_size and Compressing log
 * lines never carry raw session/turn ids in their `route` field.
 */
import { describe, expect, it } from 'vitest';
import {
  getPayloadHistogramSnapshot,
  recordPayloadHistogramSampleForTests,
  resetPayloadHistogramForTests,
  sanitizeRouteForLog,
} from '../cloudServiceClient';

describe('sanitizeRouteForLog', () => {
  it('rewrites session id segments to :id', () => {
    expect(sanitizeRouteForLog('/api/sessions/abc-123-def')).toBe('/api/sessions/:id');
    expect(sanitizeRouteForLog('/api/sessions/abc-123-def/events')).toBe('/api/sessions/:id/events');
  });

  it('strips query strings', () => {
    expect(
      sanitizeRouteForLog('/api/sessions/abc-123/events?sinceSeq=5&limit=100'),
    ).toBe('/api/sessions/:id/events');
  });

  it('rewrites turn id segments', () => {
    expect(sanitizeRouteForLog('/api/turns/turn-uuid-123/state')).toBe('/api/turns/:id/state');
  });

  it('rewrites cloud-mcps id segments', () => {
    expect(sanitizeRouteForLog('/api/cloud-mcps/some-mcp-id')).toBe('/api/cloud-mcps/:id');
  });

  it('rewrites library id segments', () => {
    expect(sanitizeRouteForLog('/api/library/lib-12345')).toBe('/api/library/:id');
  });

  it('rewrites continuity id segments', () => {
    expect(sanitizeRouteForLog('/api/continuity/sess-abc')).toBe('/api/continuity/:id');
  });

  it('passes through routes without ids', () => {
    expect(sanitizeRouteForLog('/api/health')).toBe('/api/health');
    expect(sanitizeRouteForLog('/api/sessions')).toBe('/api/sessions');
  });

  it('handles UUID-like ids with dots, dashes, underscores', () => {
    expect(sanitizeRouteForLog('/api/sessions/8f0b7c32-abcd-1234-ef56_test.json')).toBe('/api/sessions/:id');
  });

  it('does NOT leak any portion of a UUID-shaped id segment', () => {
    const route = sanitizeRouteForLog('/api/sessions/8f0b7c32-1234-5678-9abc-def012345678/events');
    expect(route).not.toContain('8f0b7c32');
    expect(route).not.toContain('def012345678');
  });
});

describe('payload histogram snapshot', () => {
  it('reports p50 p95 max over the 24 hour sample window', () => {
    resetPayloadHistogramForTests();
    const now = Date.parse('2026-05-10T12:00:00.000Z');
    recordPayloadHistogramSampleForTests(100, now - 25 * 60 * 60 * 1000);
    recordPayloadHistogramSampleForTests(10, now - 1000);
    recordPayloadHistogramSampleForTests(20, now - 900);
    recordPayloadHistogramSampleForTests(30, now - 800);
    recordPayloadHistogramSampleForTests(1000, now - 700);

    const snapshot = getPayloadHistogramSnapshot(now);

    expect(snapshot).toEqual({
      payloadBytesP50: 20,
      payloadBytesP95: 1000,
      payloadBytesMax: 1000,
      windowStart: '2026-05-09T12:00:00.000Z',
      windowEnd: '2026-05-10T12:00:00.000Z',
      sampleCount: 4,
    });
  });
});
