import { describe, it, expect, beforeEach, vi } from 'vitest';
import { updateAliases, resolveAlias, clearAliases } from '../toolAliasCache';

describe('toolAliasCache', () => {
  beforeEach(() => {
    clearAliases();
  });

  describe('resolveAlias', () => {
    it('returns canonical name for a known alias', () => {
      updateAliases('gmail', {
        send_email: 'send_workspace_email',
        search_emails: 'search_workspace_emails',
      });

      expect(resolveAlias('gmail', 'send_email')).toBe('send_workspace_email');
      expect(resolveAlias('gmail', 'search_emails')).toBe('search_workspace_emails');
    });

    it('returns input unchanged for an unknown alias', () => {
      updateAliases('gmail', {
        send_email: 'send_workspace_email',
      });

      expect(resolveAlias('gmail', 'nonexistent_tool')).toBe('nonexistent_tool');
    });

    it('returns input unchanged for an unknown package', () => {
      expect(resolveAlias('unknown_package', 'some_tool')).toBe('some_tool');
    });
  });

  describe('updateAliases', () => {
    it('replaces existing aliases for a package', () => {
      updateAliases('gmail', {
        send_email: 'send_workspace_email',
      });
      expect(resolveAlias('gmail', 'send_email')).toBe('send_workspace_email');

      // Replace with a different alias map
      updateAliases('gmail', {
        compose_email: 'send_workspace_email',
      });

      // Old alias should no longer resolve
      expect(resolveAlias('gmail', 'send_email')).toBe('send_email');
      // New alias should resolve
      expect(resolveAlias('gmail', 'compose_email')).toBe('send_workspace_email');
    });

    it('removes package entry when given an empty alias map', () => {
      updateAliases('gmail', {
        send_email: 'send_workspace_email',
      });
      expect(resolveAlias('gmail', 'send_email')).toBe('send_workspace_email');

      // Update with empty map should remove entry
      updateAliases('gmail', {});
      expect(resolveAlias('gmail', 'send_email')).toBe('send_email');
    });
  });

  describe('clearAliases', () => {
    it('removes all entries', () => {
      updateAliases('gmail', { send_email: 'send_workspace_email' });
      updateAliases('slack', { post_msg: 'post_message' });

      expect(resolveAlias('gmail', 'send_email')).toBe('send_workspace_email');
      expect(resolveAlias('slack', 'post_msg')).toBe('post_message');

      clearAliases();

      expect(resolveAlias('gmail', 'send_email')).toBe('send_email');
      expect(resolveAlias('slack', 'post_msg')).toBe('post_msg');
    });
  });
});
