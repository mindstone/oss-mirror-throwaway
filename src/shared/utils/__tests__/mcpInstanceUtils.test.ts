import { describe, it, expect } from 'vitest';
import {
  generateInstanceId,
  extractEmailSlug,
  parseEmailFromSlug,
  parseMultiInstanceServer,
  isEmailInstanceConnector,
  EMAIL_INSTANCE_CONNECTOR_TYPES,
} from '../mcpInstanceUtils';

describe('mcpInstanceUtils', () => {
  describe('generateInstanceId', () => {
    it('generates valid ID for standard email', () => {
      expect(generateInstanceId('GoogleWorkspace', '[external-email]')).toBe(
        'GoogleWorkspace-greg-work-com'
      );
    });

    it('generates valid ID for email with subdomain', () => {
      expect(generateInstanceId('GoogleWorkspace', '[external-email]')).toBe(
        'GoogleWorkspace-user-mail-example-com'
      );
    });

    it('handles Gmail plus aliases', () => {
      expect(generateInstanceId('GoogleWorkspace', '[external-email]')).toBe(
        'GoogleWorkspace-user-tag-gmail-com'
      );
    });

    it('handles multiple special characters', () => {
      expect(generateInstanceId('GoogleWorkspace', '[external-email]')).toBe(
        'GoogleWorkspace-user-tag-more-sub-domain-com'
      );
    });

    it('handles uppercase in email', () => {
      expect(generateInstanceId('GoogleWorkspace', '[external-email]')).toBe(
        'GoogleWorkspace-greg-detre-work-com'
      );
    });

    it('handles underscores in email', () => {
      expect(generateInstanceId('GoogleWorkspace', '[external-email]')).toBe(
        'GoogleWorkspace-first-last-company-com'
      );
    });

    it('handles numbers in email', () => {
      expect(generateInstanceId('GoogleWorkspace', '[external-email]')).toBe(
        'GoogleWorkspace-user123-domain456-com'
      );
    });

    it('collapses consecutive special chars', () => {
      expect(generateInstanceId('GoogleWorkspace', '[external-email]')).toBe(
        'GoogleWorkspace-user-name-domain-com'
      );
    });

    it('works with different MCP names', () => {
      expect(generateInstanceId('HubSpot', '[external-email]')).toBe('HubSpot-sales-acme-com');
      expect(generateInstanceId('Salesforce', '[external-email]')).toBe('Salesforce-admin-corp-org');
    });

    it('handles edge case: email starting with special char', () => {
      // After replacing non-alphanumeric and trimming leading dash
      expect(generateInstanceId('GoogleWorkspace', '[external-email]')).toBe(
        'GoogleWorkspace-user-domain-com'
      );
    });

    // Direct connector multi-instance tests (Stage 4)
    it('works with direct connector names (Linear, Notion, etc.)', () => {
      expect(generateInstanceId('Linear', '[external-email]')).toBe('Linear-dev-startup-io');
      expect(generateInstanceId('Notion', '[external-email]')).toBe('Notion-team-company-com');
      expect(generateInstanceId('Todoist', '[external-email]')).toBe('Todoist-user-personal-org');
    });

    it('handles empty email gracefully', () => {
      // Empty string produces the MCP name with a trailing dash (edge case)
      expect(generateInstanceId('Linear', '')).toBe('Linear-');
    });

    it('handles whitespace-only email', () => {
      expect(generateInstanceId('Linear', '   ')).toBe('Linear-');
    });

    it('handles email with leading/trailing whitespace', () => {
      // Note: caller should trim; generateInstanceId treats whitespace as non-alphanumeric
      expect(generateInstanceId('Linear', '  [external-email]  ')).toBe('Linear-user-domain-com');
    });
  });

  describe('extractEmailSlug', () => {
    it('extracts slug from valid instance ID', () => {
      expect(extractEmailSlug('GoogleWorkspace-greg-work-com', 'GoogleWorkspace')).toBe(
        'greg-work-com'
      );
    });

    it('returns null for non-matching base name', () => {
      expect(extractEmailSlug('GoogleWorkspace-greg-work-com', 'HubSpot')).toBeNull();
    });

    it('returns null for exact base name match (no email part)', () => {
      expect(extractEmailSlug('GoogleWorkspace', 'GoogleWorkspace')).toBeNull();
    });
  });

  describe('parseEmailFromSlug', () => {
    it('parses standard slug to approximate email', () => {
      expect(parseEmailFromSlug('greg-work-com')).toBe('[external-email]');
    });

    it('handles multi-part domains', () => {
      expect(parseEmailFromSlug('user-mail-example-com')).toBe('[external-email]');
    });

    it('returns slug unchanged if less than 3 parts', () => {
      expect(parseEmailFromSlug('invalid')).toBe('invalid');
      expect(parseEmailFromSlug('also-invalid')).toBe('also-invalid');
    });
  });

  describe('parseMultiInstanceServer', () => {
    it('parses valid GoogleWorkspace instance', () => {
      const result = parseMultiInstanceServer('GoogleWorkspace-greg-work-com');
      expect(result.isInstance).toBe(true);
      expect(result.baseName).toBe('GoogleWorkspace');
      expect(result.emailSlug).toBe('greg-work-com');
    });

    it('parses valid HubSpot instance', () => {
      const result = parseMultiInstanceServer('HubSpot-sales-acme-com');
      expect(result.isInstance).toBe(true);
      expect(result.baseName).toBe('HubSpot');
      expect(result.emailSlug).toBe('sales-acme-com');
    });

    it('returns false for generic GoogleWorkspace', () => {
      const result = parseMultiInstanceServer('GoogleWorkspace');
      expect(result.isInstance).toBe(false);
      expect(result.baseName).toBeNull();
      expect(result.emailSlug).toBeNull();
    });

    it('returns false for unrelated server names', () => {
      const result = parseMultiInstanceServer('Slack');
      expect(result.isInstance).toBe(false);
      expect(result.baseName).toBeNull();
    });

    it('handles edge case: base name with trailing dash only', () => {
      const result = parseMultiInstanceServer('GoogleWorkspace-');
      expect(result.isInstance).toBe(false);
    });
  });

  describe('isEmailInstanceConnector', () => {
    it('returns true for email-based instance connectors', () => {
      expect(isEmailInstanceConnector('GoogleWorkspace')).toBe(true);
      expect(isEmailInstanceConnector('HubSpot')).toBe(true);
      expect(isEmailInstanceConnector('Salesforce')).toBe(true);
    });

    it('returns false for workspace-based or unknown connectors', () => {
      expect(isEmailInstanceConnector('Slack')).toBe(false);
      expect(isEmailInstanceConnector('Linear')).toBe(false);
      expect(isEmailInstanceConnector('Unknown')).toBe(false);
    });
  });

  describe('EMAIL_INSTANCE_CONNECTOR_TYPES', () => {
    it('contains expected email-based connector types', () => {
      expect(EMAIL_INSTANCE_CONNECTOR_TYPES).toContain('GoogleWorkspace');
      expect(EMAIL_INSTANCE_CONNECTOR_TYPES).toContain('HubSpot');
      expect(EMAIL_INSTANCE_CONNECTOR_TYPES).toContain('Salesforce');
    });

    it('contains all 5 Microsoft 365 base names', () => {
      expect(EMAIL_INSTANCE_CONNECTOR_TYPES).toContain('Microsoft365Mail');
      expect(EMAIL_INSTANCE_CONNECTOR_TYPES).toContain('Microsoft365Calendar');
      expect(EMAIL_INSTANCE_CONNECTOR_TYPES).toContain('Microsoft365Files');
      expect(EMAIL_INSTANCE_CONNECTOR_TYPES).toContain('Microsoft365Teams');
      expect(EMAIL_INSTANCE_CONNECTOR_TYPES).toContain('Microsoft365SharePoint');
    });
  });

  // ── Microsoft 365 multi-instance tests ──

  describe('Microsoft 365 multi-instance', () => {
    const MICROSOFT_BASE_NAMES = [
      'Microsoft365Mail',
      'Microsoft365Calendar',
      'Microsoft365Files',
      'Microsoft365Teams',
      'Microsoft365SharePoint',
    ];

    describe('generateInstanceId with Microsoft base names', () => {
      it('generates instance IDs for all 5 Microsoft services', () => {
        expect(generateInstanceId('Microsoft365Mail', '[external-email]')).toBe(
          'Microsoft365Mail-user-outlook-com'
        );
        expect(generateInstanceId('Microsoft365Calendar', '[external-email]')).toBe(
          'Microsoft365Calendar-user-outlook-com'
        );
        expect(generateInstanceId('Microsoft365Files', '[external-email]')).toBe(
          'Microsoft365Files-user-outlook-com'
        );
        expect(generateInstanceId('Microsoft365Teams', '[external-email]')).toBe(
          'Microsoft365Teams-user-outlook-com'
        );
        expect(generateInstanceId('Microsoft365SharePoint', '[external-email]')).toBe(
          'Microsoft365SharePoint-user-outlook-com'
        );
      });

      it('generates distinct IDs for different accounts on same service', () => {
        const id1 = generateInstanceId('Microsoft365Mail', '[external-email]');
        const id2 = generateInstanceId('Microsoft365Mail', '[external-email]');
        expect(id1).not.toBe(id2);
        expect(id1).toBe('Microsoft365Mail-alice-outlook-com');
        expect(id2).toBe('Microsoft365Mail-bob-company-com');
      });
    });

    describe('parseMultiInstanceServer with Microsoft instances', () => {
      it('parses Microsoft365Mail instance', () => {
        const result = parseMultiInstanceServer('Microsoft365Mail-hlatky-outlook-com');
        expect(result.isInstance).toBe(true);
        expect(result.baseName).toBe('Microsoft365Mail');
        expect(result.emailSlug).toBe('hlatky-outlook-com');
        expect(result.instanceType).toBe('email');
      });

      it('parses Microsoft365Calendar instance', () => {
        const result = parseMultiInstanceServer('Microsoft365Calendar-user-company-com');
        expect(result.isInstance).toBe(true);
        expect(result.baseName).toBe('Microsoft365Calendar');
        expect(result.emailSlug).toBe('user-company-com');
      });

      it('parses Microsoft365SharePoint instance', () => {
        const result = parseMultiInstanceServer('Microsoft365SharePoint-admin-corp-org');
        expect(result.isInstance).toBe(true);
        expect(result.baseName).toBe('Microsoft365SharePoint');
        expect(result.emailSlug).toBe('admin-corp-org');
      });

      it('returns false for static Microsoft server names (no email slug)', () => {
        for (const baseName of MICROSOFT_BASE_NAMES) {
          const result = parseMultiInstanceServer(baseName);
          expect(result.isInstance).toBe(false);
          expect(result.baseName).toBeNull();
        }
      });
    });

    describe('isEmailInstanceConnector with Microsoft base names', () => {
      it('returns true for all 5 Microsoft base names', () => {
        for (const baseName of MICROSOFT_BASE_NAMES) {
          expect(isEmailInstanceConnector(baseName)).toBe(true);
        }
      });
    });
  });
});
