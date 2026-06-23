import type http from 'node:http';
import { getCloudCapabilitiesHeader } from './capabilities';

export const ACCESS_CONTROL_ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
export const ACCESS_CONTROL_EXPOSE_HEADERS = 'X-Rebel-Capabilities, X-Rebel-Cloud-Version';

/**
 * Every custom request header the cloud-client (or any first-party client) may send
 * MUST be listed here, or the browser will fail CORS preflight before the request
 * is dispatched. Pure additions are safe; removals are a breaking change for any
 * client version still on the wire.
 *
 * Keep this synchronised with the headers set in `cloud-client/src/cloudClient.ts`.
 */
export const ACCESS_CONTROL_ALLOW_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Rebel-Surface',
  'X-Rebel-Client-Id',
  'X-Rebel-Capability-Fingerprint',
].join(', ');

export function getCloudVersionHeader(): string {
  return typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'unknown';
}

export function applyCommonResponseHeaders(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', ACCESS_CONTROL_ALLOW_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ACCESS_CONTROL_ALLOW_HEADERS);
  res.setHeader('Access-Control-Expose-Headers', ACCESS_CONTROL_EXPOSE_HEADERS);
  res.setHeader('X-Rebel-Cloud-Version', getCloudVersionHeader());
  res.setHeader('X-Rebel-Capabilities', getCloudCapabilitiesHeader());
}
