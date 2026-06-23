import type http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { CLOUD_CAPABILITIES, getCloudCapabilities, getCloudCapabilitiesHeader } from '../capabilities';
import {
  ACCESS_CONTROL_ALLOW_HEADERS,
  ACCESS_CONTROL_ALLOW_METHODS,
  ACCESS_CONTROL_EXPOSE_HEADERS,
  applyCommonResponseHeaders,
} from '../serverHeaders';

const EXPECTED_CAPABILITIES = [
  'session-event-delta-push',
  'session-metadata-patch',
  'meeting-trigger-detection',
  'session-delta-chunked',
  'session-content-refs',
  'session-reconcile-handshake',
  'cloud-resource-pressure',
];

function mockRes(): http.ServerResponse & { headers: Map<string, number | string | string[]> } {
  const headers = new Map<string, number | string | string[]>();
  return {
    headers,
    setHeader: vi.fn((name: string, value: number | string | string[]) => {
      headers.set(name, value);
      return undefined as never;
    }),
  } as unknown as http.ServerResponse & { headers: Map<string, number | string | string[]> };
}

describe('server capabilities and CORS headers', () => {
  it('advertises delta push, metadata patch, meeting trigger detection, and chunked delta capabilities', () => {
    expect(CLOUD_CAPABILITIES).toEqual(EXPECTED_CAPABILITIES);
    expect(getCloudCapabilities()).toEqual(EXPECTED_CAPABILITIES);
    expect(getCloudCapabilitiesHeader()).toBe(EXPECTED_CAPABILITIES.join(','));
  });

  it('applies capabilities to every response via common headers', () => {
    const res = mockRes();
    applyCommonResponseHeaders(res);

    expect(res.headers.get('X-Rebel-Capabilities')).toBe(getCloudCapabilitiesHeader());
  });

  it('keeps CloudVersion exposed alongside capabilities', () => {
    const res = mockRes();
    applyCommonResponseHeaders(res);

    expect(res.headers.get('X-Rebel-Cloud-Version')).toEqual(expect.any(String));
    expect(res.headers.get('Access-Control-Expose-Headers')).toBe(ACCESS_CONTROL_EXPOSE_HEADERS);
    expect(ACCESS_CONTROL_EXPOSE_HEADERS).toContain('X-Rebel-Capabilities');
    expect(ACCESS_CONTROL_EXPOSE_HEADERS).toContain('X-Rebel-Cloud-Version');
  });

  it('allows PATCH in CORS preflight methods', () => {
    expect(ACCESS_CONTROL_ALLOW_METHODS).toContain('PATCH');
    const res = mockRes();
    applyCommonResponseHeaders(res);
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe(ACCESS_CONTROL_ALLOW_METHODS);
  });

  it('preserves existing CORS methods while adding PATCH', () => {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
      expect(ACCESS_CONTROL_ALLOW_METHODS).toContain(method);
    }
  });

  // Regression: a missing entry here means any browser-origin request from the
  // cloud-client that includes that header will fail CORS preflight (Failed to
  // fetch) before the request leaves the renderer. The Slack BYOK flow shipped
  // broken end-to-end because X-Rebel-Capability-Fingerprint was missing.
  it('whitelists every custom header the cloud-client may send for CORS preflight', () => {
    const requiredHeaders = [
      'Content-Type',
      'Authorization',
      'X-Rebel-Surface',
      'X-Rebel-Client-Id',
      'X-Rebel-Capability-Fingerprint',
    ];
    for (const header of requiredHeaders) {
      expect(ACCESS_CONTROL_ALLOW_HEADERS).toContain(header);
    }
    const res = mockRes();
    applyCommonResponseHeaders(res);
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe(ACCESS_CONTROL_ALLOW_HEADERS);
  });
});
