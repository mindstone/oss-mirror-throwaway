import { describe, expect, it } from 'vitest';
import {
  buildTrustBoundaryLogEvent,
  deriveSourcePackageFamily,
  hashSourcePackageId,
} from '../safeLogging';

describe('mcpAppsTrust safeLogging', () => {
  it('derives safe source package families without raw instance suffixes', () => {
    expect(deriveSourcePackageFamily('GoogleWorkspace-joshua-example-com')).toBe('Google Workspace');
    expect(deriveSourcePackageFamily('custom-tool-user-12345')).toBe('Custom Tool');
  });

  it('builds structured log events without raw sourcePackageId', () => {
    const event = buildTrustBoundaryLogEvent({
      sourcePackageId: 'CustomTool-user-12345',
      sessionId: 'session-1',
      conversationId: 'conversation-1',
      method: 'ui/updateModelContext',
      nonce: 'nonce-1',
      reason: 'permission_denied',
      kind: 'permission_denial',
      attemptedContentBytes: 42,
      toolUseId: 'tool-1',
    });

    expect(event).toMatchObject({
      boundary: 'mcp-apps-bidirectional-trust',
      sourcePackageFamily: 'Custom Tool',
      sourcePackageHash: hashSourcePackageId('CustomTool-user-12345'),
      method: 'ui/updateModelContext',
      reason: 'permission_denied',
      attemptedContentBytes: 42,
      toolUseId: 'tool-1',
    });
    expect(JSON.stringify(event)).not.toContain('CustomTool-user-12345');
  });

  it('hashes source package IDs to 16 hex characters', () => {
    expect(hashSourcePackageId('CustomTool-user-12345')).toMatch(/^[a-f0-9]{16}$/);
  });
});
