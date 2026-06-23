/**
 * Unit tests for readOnlyHook.ts
 */

import { describe, it, expect } from 'vitest';
import { isWriteOperation } from '../readOnlyHook';

describe('isWriteOperation', () => {
  describe('built-in write tools', () => {
    it.each([
      'Edit',
      'Create',
      'Write',
      'str_replace_editor',
      'write_file',
    ])('returns true for built-in write tool: %s', (toolName) => {
      expect(isWriteOperation(toolName)).toBe(true);
    });

    it('is case-sensitive for built-in tools', () => {
      expect(isWriteOperation('edit')).toBe(false); // lowercase
      expect(isWriteOperation('EDIT')).toBe(false); // uppercase
      expect(isWriteOperation('Edit')).toBe(true);  // exact match
    });
  });

  describe('shell/execution tools', () => {
    it.each([
      'bash',
      'shell',
      'execute',
      'exec',
      'run',
      'terminal',
      'command',
      'Execute', // case-insensitive
      'Bash',    // case-insensitive
    ])('returns true for shell tool: %s', (toolName) => {
      expect(isWriteOperation(toolName)).toBe(true);
    });

    it('does not match compound names like run_command', () => {
      // The shell regex uses ^ and $ anchors, so compound names don't match
      expect(isWriteOperation('run_command')).toBe(false);
    });
  });

  describe('MCP tools', () => {
    it.each([
      'mcp__filesystem__write_file',
      'mcp__server__create_document',
      'mcp__git__delete_branch',
      'mcp__db__update_record',
      'mcp__api__patch_resource',
      'mcp__files__insert_text',
      'mcp__server__remove_item',
    ])('returns true for MCP write tool: %s', (toolName) => {
      expect(isWriteOperation(toolName)).toBe(true);
    });

    it.each([
      'mcp__filesystem__read_file',
      'mcp__server__get_document',
      'mcp__git__list_branches',
      'mcp__db__query_records',
      'mcp__api__fetch_resource',
      'mcp__rebel-diagnostics__rebel_diagnostics_quick',
    ])('returns false for MCP read tool: %s', (toolName) => {
      expect(isWriteOperation(toolName)).toBe(false);
    });
  });

  describe('allowed overrides', () => {
    it('returns false for rebel_diagnostics_export', () => {
      expect(isWriteOperation('rebel_diagnostics_export')).toBe(false);
    });

    it('returns false for create_search', () => {
      expect(isWriteOperation('create_search')).toBe(false);
    });

    it('returns false for MCP override tools', () => {
      expect(isWriteOperation('mcp__rebel__rebel_diagnostics_export')).toBe(false);
    });
  });

  describe('read-only tools', () => {
    it.each([
      'Read',
      'Glob',
      'Grep',
      'LS',
      'WebSearch',
      'WebFetch',
      'rebel_diagnostics_check',
      'rebel_diagnostics_quick',
    ])('returns false for read tool: %s', (toolName) => {
      expect(isWriteOperation(toolName)).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      expect(isWriteOperation('')).toBe(false);
    });

    it('handles partial MCP format', () => {
      expect(isWriteOperation('mcp__server')).toBe(false); // Only 2 parts
    });

    it('handles tool names with numbers', () => {
      expect(isWriteOperation('write_file_v2')).toBe(false); // Not in built-in list
      expect(isWriteOperation('mcp__fs__write_v2')).toBe(true); // Pattern match
    });
  });
});
