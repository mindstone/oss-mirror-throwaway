import { describe, it, expect } from 'vitest';
import {
  isDeterministicallyReadOnly,
  isBlockedTool,
  requiresSafetyPromptPolicyCheck,
} from '../toolVerbs';

describe('isDeterministicallyReadOnly', () => {
  describe('read-only tools (should return true)', () => {
    it.each([
      'list_files',
      'list_workspace_drafts',
      'list_workspace_labels',
      'list_workspace_label_filters',
      'get_workspace_draft',
      'get_workspace_label',
      'get_message_sender',
      'gmail_search_emails',
      'search_workspace_emails',
      'fetch_data',
      'read_document',
      'describe_table',
      'show_details',
      'check_status',
      'view_profile',
      'inspect_element',
      'lookup_user',
      'find_workspace_emails',
      'count_records',
      'draft_workspace_email',
      'preview_document',
      'load_settings',
      // SAFETY-RELEVANT: see docs/plans/260429_chief_designer_visual_verification_loop.md.
      // Renaming this tool MUST keep a `get` verb to preserve auto-skip.
      'rebel_get_app_screenshot',
    ])('returns true for read-only tool: %s', (toolId) => {
      expect(isDeterministicallyReadOnly(toolId)).toBe(true);
    });
  });

  describe('system trustable allowlist (should return true despite SE verbs)', () => {
    it.each([
      'create_workspace_draft',
      'update_workspace_draft',
    ])('returns true for allowlisted tool: %s', (toolId) => {
      expect(isDeterministicallyReadOnly(toolId)).toBe(true);
    });
  });

  describe('side-effect tools (should return false)', () => {
    it.each([
      'send_email',
      'send_workspace_draft',
      'delete_workspace_draft',
      'delete_workspace_label',
      'delete_workspace_label_filter',
      'create_workspace_label',
      'update_workspace_label',
      'upload_workspace_attachment',
      'delete_workspace_attachment',
      'manage_workspace_draft',
      'manage_workspace_label',
      'manage_workspace_attachment',
      'manage_workspace_label_filter',
      'post_message',
      'remove_item',
      'modify_record',
      'edit_document',
      'add_member',
      'submit_form',
      'publish_page',
      'archive_conversation',
      'move_file',
      'copy_document',
      'transfer_ownership',
      'execute_query',
      'run_script',
      'trigger_workflow',
      'start_process',
      'stop_server',
      'cancel_subscription',
      'approve_request',
      'reject_application',
      'assign_task',
      'unassign_member',
      'replace_content',
    ])('returns false for side-effect tool: %s', (toolId) => {
      expect(isDeterministicallyReadOnly(toolId)).toBe(false);
    });
  });

  describe('composite names with mixed verbs (should return false)', () => {
    it.each([
      'get_and_delete_files',
      'find_and_replace_in_workspace_document',
      'list_and_remove_items',
    ])('returns false for composite tool: %s', (toolId) => {
      expect(isDeterministicallyReadOnly(toolId)).toBe(false);
    });
  });

  describe('no matching verbs (should return false)', () => {
    it.each([
      'some_random_tool',
      'do_thing',
      'process_data',
    ])('returns false for unrecognized tool: %s', (toolId) => {
      expect(isDeterministicallyReadOnly(toolId)).toBe(false);
    });
  });

  describe('PascalCase/camelCase normalization (should match after snake_case conversion)', () => {
    it.each([
      'WebSearch',       // → web_search (search verb)
      'WebFetch',        // → web_fetch (fetch verb)
      'ListFiles',       // → list_files (list verb)
      'SearchEmails',    // → search_emails (search verb)
      'GetUserProfile',  // → get_user_profile (get verb)
      'ReadDocument',    // → read_document (read verb)
      'FindRecords',     // → find_records (find verb)
      'ViewSettings',    // → view_settings (view verb)
      'CountItems',      // → count_items (count verb)
      'LoadConfig',      // → load_config (load verb)
    ])('returns true for PascalCase read-only tool: %s', (toolId) => {
      expect(isDeterministicallyReadOnly(toolId)).toBe(true);
    });

    it.each([
      'SendEmail',       // → send_email (send SE verb)
      'DeleteFile',      // → delete_file (delete SE verb)
      'CreateRecord',    // → create_record (create SE verb)
      'UpdateProfile',   // → update_profile (update SE verb)
      'PostMessage',     // → post_message (post SE verb)
      'RemoveItem',      // → remove_item (remove SE verb)
      'ExecuteQuery',    // → execute_query (execute SE verb)
      'PublishPage',     // → publish_page (publish SE verb)
    ])('returns false for PascalCase side-effect tool: %s', (toolId) => {
      expect(isDeterministicallyReadOnly(toolId)).toBe(false);
    });
  });

  describe('consecutive uppercase abbreviations', () => {
    it.each([
      'HTMLParser',      // → html_parser — no read-only verb → false
      'XMLReader',       // → xml_reader — no read-only verb → false (read ≠ reader at boundary)
    ])('returns false for abbreviation tool without read-only verb: %s', (toolId) => {
      expect(isDeterministicallyReadOnly(toolId)).toBe(false);
    });

    it('handles OAuth2Token (no read-only verb)', () => {
      expect(isDeterministicallyReadOnly('OAuth2Token')).toBe(false);
    });

    it('handles APIGetUser (get verb after abbreviation)', () => {
      expect(isDeterministicallyReadOnly('APIGetUser')).toBe(true);
    });
  });

  describe('word-boundary matching', () => {
    it('does not match "send" in "get_message_sender"', () => {
      expect(isDeterministicallyReadOnly('get_message_sender')).toBe(true);
    });

    it('does not match "edit" in "get_credit_info"', () => {
      expect(isDeterministicallyReadOnly('get_credit_info')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(isDeterministicallyReadOnly('List_Files')).toBe(true);
      expect(isDeterministicallyReadOnly('CREATE_WORKSPACE_DRAFT')).toBe(true);
    });
  });
});

describe('isBlockedTool', () => {
  it.each([
    'mcp__server__Bash',
    'run_shell_command',
    'open_terminal',
    'execute_code',
  ])('blocks tool: %s', (toolName) => {
    expect(isBlockedTool(toolName)).toBe(true);
  });

  it.each([
    'list_files',
    'create_workspace_draft',
    'send_email',
  ])('does not block tool: %s', (toolName) => {
    expect(isBlockedTool(toolName)).toBe(false);
  });
});

describe('requiresSafetyPromptPolicyCheck', () => {
  it.each([
    ['send_email', undefined],
    ['send_workspace_draft', undefined],
    ['post_slack_message', undefined],
    ['send_message', 'slack'],
    ['chat_postMessage', 'slack'],
    ['reply_workspace_email', 'google-workspace'],
  ])('requires current Safety Rules for communication tool %s', (toolId, packageId) => {
    expect(requiresSafetyPromptPolicyCheck(toolId, packageId)).toBe(true);
  });

  it.each([
    ['create_workspace_draft', 'google-workspace'],
    ['update_workspace_draft', 'google-workspace'],
    ['search_workspace_emails', 'google-workspace'],
    ['list_slack_channels', 'slack'],
    ['create_calendar_event', 'google-workspace'],
  ])('does not require policy check for non-send communication tool %s', (toolId, packageId) => {
    expect(requiresSafetyPromptPolicyCheck(toolId, packageId)).toBe(false);
  });
});
