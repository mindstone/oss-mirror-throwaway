/**
 * Tests for Microsoft 365 auth routing logic in mcpService.ts.
 *
 * The routing decision determines which MCP server handles OAuth authentication:
 * - Calendar/Files/Teams → route to Mail instance (authenticate_microsoft_account lives there)
 * - SharePoint → stays on SharePoint (has its own authenticate_sharepoint tool)
 * - Mail → stays on Mail
 */

import { describe, it, expect } from 'vitest';
import { parseMultiInstanceServer } from '@shared/utils/mcpInstanceUtils';
import { resolveMicrosoftAuthServerId } from '../mcpService';

function resolveAuthServerId(serverId: string): string {
  const { baseName } = parseMultiInstanceServer(serverId);
  return resolveMicrosoftAuthServerId(serverId, baseName);
}

describe('Microsoft 365 auth routing decision', () => {
  // ── Instance-based servers (with email slug) ──

  describe('instance-based servers (multi-account)', () => {
    it('Calendar instance routes to Mail instance for same email slug', () => {
      const authServerId = resolveAuthServerId('Microsoft365Calendar-hlatky-outlook-com');
      expect(authServerId).toBe('Microsoft365Mail-hlatky-outlook-com');
    });

    it('Files instance routes to Mail instance for same email slug', () => {
      const authServerId = resolveAuthServerId('Microsoft365Files-hlatky-outlook-com');
      expect(authServerId).toBe('Microsoft365Mail-hlatky-outlook-com');
    });

    it('Teams instance routes to Mail instance for same email slug', () => {
      const authServerId = resolveAuthServerId('Microsoft365Teams-hlatky-outlook-com');
      expect(authServerId).toBe('Microsoft365Mail-hlatky-outlook-com');
    });

    it('SharePoint instance stays on SharePoint (has its own authenticate_sharepoint tool)', () => {
      const authServerId = resolveAuthServerId('Microsoft365SharePoint-hlatky-outlook-com');
      expect(authServerId).toBe('Microsoft365SharePoint-hlatky-outlook-com');
    });

    it('Mail instance stays on itself', () => {
      const authServerId = resolveAuthServerId('Microsoft365Mail-hlatky-outlook-com');
      expect(authServerId).toBe('Microsoft365Mail-hlatky-outlook-com');
    });

    it('preserves email slug when routing Calendar to Mail', () => {
      const authServerId = resolveAuthServerId('Microsoft365Calendar-bob-company-com');
      expect(authServerId).toBe('Microsoft365Mail-bob-company-com');
    });
  });

  // ── Static servers (legacy, no email slug) ──

  describe('static servers (legacy, no email slug)', () => {
    it('static Calendar routes to static Mail', () => {
      const authServerId = resolveAuthServerId('Microsoft365Calendar');
      expect(authServerId).toBe('Microsoft365Mail');
    });

    it('static Files routes to static Mail', () => {
      const authServerId = resolveAuthServerId('Microsoft365Files');
      expect(authServerId).toBe('Microsoft365Mail');
    });

    it('static Teams routes to static Mail', () => {
      const authServerId = resolveAuthServerId('Microsoft365Teams');
      expect(authServerId).toBe('Microsoft365Mail');
    });

    it('static SharePoint stays on itself', () => {
      const authServerId = resolveAuthServerId('Microsoft365SharePoint');
      expect(authServerId).toBe('Microsoft365SharePoint');
    });

    it('static Mail stays on itself', () => {
      const authServerId = resolveAuthServerId('Microsoft365Mail');
      expect(authServerId).toBe('Microsoft365Mail');
    });
  });

  // ── Non-Microsoft servers are unaffected ──

  describe('non-Microsoft servers are not rerouted', () => {
    it('GoogleWorkspace instance stays on itself', () => {
      const authServerId = resolveAuthServerId('GoogleWorkspace-user-gmail-com');
      expect(authServerId).toBe('GoogleWorkspace-user-gmail-com');
    });

    it('Salesforce stays on itself', () => {
      const authServerId = resolveAuthServerId('Salesforce');
      expect(authServerId).toBe('Salesforce');
    });

    it('HubSpot instance stays on itself', () => {
      const authServerId = resolveAuthServerId('HubSpot-sales-acme-com');
      expect(authServerId).toBe('HubSpot-sales-acme-com');
    });
  });
});
