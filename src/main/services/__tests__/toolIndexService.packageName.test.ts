/**
 * Tests for buildToolSearchText helper in toolIndexService.
 *
 * Verifies the pure function that assembles the combined search text
 * used for both content hashing and embedding generation.
 */

import { describe, expect, it } from 'vitest';
import { buildToolSearchText } from '../toolIndexService';

describe('buildToolSearchText', () => {
  it('includes package_name in output', () => {
    const tool = {
      name: 'send_email',
      description: 'Send an email message',
      package_name: 'GoogleWorkspace',
    };

    const result = buildToolSearchText(tool, '');
    expect(result).toContain('GoogleWorkspace');
  });

  it('includes tool name, description, and param names', () => {
    const tool = {
      name: 'search_emails',
      description: 'Search through emails',
      package_name: 'GoogleWorkspace',
    };

    const result = buildToolSearchText(tool, 'query max_results');
    expect(result).toContain('search_emails');
    expect(result).toContain('Search through emails');
    expect(result).toContain('query max_results');
    expect(result).toContain('GoogleWorkspace');
  });

  it('two tools differing only in package_name produce different search text', () => {
    const toolA = {
      name: 'post_message',
      description: 'Post a message to a channel',
      package_name: 'Slack',
    };
    const toolB = {
      name: 'post_message',
      description: 'Post a message to a channel',
      package_name: 'Discord',
    };

    const resultA = buildToolSearchText(toolA, 'channel text');
    const resultB = buildToolSearchText(toolB, 'channel text');

    expect(resultA).not.toBe(resultB);
    expect(resultA).toContain('Slack');
    expect(resultB).toContain('Discord');
  });

  it('summary takes precedence over description when both present', () => {
    const tool = {
      name: 'create_task',
      summary: 'Create a new task in the project',
      description: 'This is a longer description that should not appear',
      package_name: 'Todoist',
    };

    const result = buildToolSearchText(tool, 'title');
    expect(result).toContain('Create a new task in the project');
    expect(result).not.toContain('This is a longer description that should not appear');
  });

  it('falls back to description when summary is undefined', () => {
    const tool = {
      name: 'list_items',
      description: 'List all items in the workspace',
      package_name: 'Notion',
    };

    const result = buildToolSearchText(tool, '');
    expect(result).toContain('List all items in the workspace');
  });

  it('falls back to description when summary is empty string', () => {
    const tool = {
      name: 'list_items',
      summary: '',
      description: 'List all items in the workspace',
      package_name: 'Notion',
    };

    const result = buildToolSearchText(tool, '');
    expect(result).toContain('List all items in the workspace');
  });
});
