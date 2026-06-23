import { describe, expect, it } from 'vitest';
import { humanizeToolActivity } from '../humanizeToolActivity';

describe('humanizeToolActivity', () => {
  describe('file read tools', () => {
    it('returns "Reading <filename>" for Read with path detail', () => {
      const detail = JSON.stringify({ file_path: '/home/user/docs/meeting-notes.md' });
      expect(humanizeToolActivity('Read', detail)).toBe('Reading meeting-notes.md');
    });

    it('returns "Reading <filename>" for read_file', () => {
      const detail = JSON.stringify({ path: '/tmp/data.json' });
      expect(humanizeToolActivity('read_file', detail)).toBe('Reading data.json');
    });

    it('returns "Reading a file" when no path in detail', () => {
      expect(humanizeToolActivity('Read', '{}')).toBe('Reading a file');
    });

    it('returns "Reading a file" when no detail at all', () => {
      expect(humanizeToolActivity('Read')).toBe('Reading a file');
    });
  });

  describe('file write/edit tools', () => {
    it('returns "Editing <filename>" for Edit with path', () => {
      const detail = JSON.stringify({ file_path: '/src/app.ts' });
      expect(humanizeToolActivity('Edit', detail)).toBe('Editing app.ts');
    });

    it('returns "Editing <filename>" for write_file', () => {
      const detail = JSON.stringify({ filepath: '/docs/readme.md' });
      expect(humanizeToolActivity('write_file', detail)).toBe('Editing readme.md');
    });

    it('returns "Editing <filename>" for str_replace_editor', () => {
      const detail = JSON.stringify({ path: '/src/index.ts' });
      expect(humanizeToolActivity('str_replace_editor', detail)).toBe('Editing index.ts');
    });

    it('returns "Editing <filename>" for create_file', () => {
      const detail = JSON.stringify({ file_path: '/new-file.tsx' });
      expect(humanizeToolActivity('create_file', detail)).toBe('Editing new-file.tsx');
    });

    it('returns "Editing a file" when no path', () => {
      expect(humanizeToolActivity('Edit')).toBe('Editing a file');
    });
  });

  describe('shell tools', () => {
    it('returns "Running a command" for Bash', () => {
      expect(humanizeToolActivity('Bash', '{"command": "npm test"}')).toBe('Running a command');
    });

    it('returns "Running a command" for shell', () => {
      expect(humanizeToolActivity('shell')).toBe('Running a command');
    });

    it('returns "Running a command" for execute', () => {
      expect(humanizeToolActivity('execute')).toBe('Running a command');
    });
  });

  describe('search tools', () => {
    it('returns "Searching" for Grep', () => {
      expect(humanizeToolActivity('Grep')).toBe('Searching');
    });

    it('returns "Searching" for search', () => {
      expect(humanizeToolActivity('search')).toBe('Searching');
    });

    it('returns "Finding files" for Glob', () => {
      expect(humanizeToolActivity('Glob')).toBe('Finding files');
    });

    it('returns "Listing directory" for LS', () => {
      expect(humanizeToolActivity('LS')).toBe('Listing directory');
    });

    it('returns "Listing directory" for ls', () => {
      expect(humanizeToolActivity('ls')).toBe('Listing directory');
    });
  });

  describe('web search tools', () => {
    it('returns "Searching the web" for WebSearch', () => {
      expect(humanizeToolActivity('WebSearch')).toBe('Searching the web');
    });

    it('returns "Searching the web" for web_search', () => {
      expect(humanizeToolActivity('web_search')).toBe('Searching the web');
    });

    it('returns "Searching the web" for search_web', () => {
      expect(humanizeToolActivity('search_web')).toBe('Searching the web');
    });
  });

  describe('delegation tools', () => {
    it('returns "Delegating to <name>" for Agent with agent detail', () => {
      const detail = JSON.stringify({ agent: 'code_reviewer' });
      expect(humanizeToolActivity('Agent', detail)).toBe('Delegating to code reviewer');
    });

    it('returns "Delegating to <name>" for Task with subagent_type', () => {
      const detail = JSON.stringify({ subagent_type: 'research_assistant' });
      expect(humanizeToolActivity('Task', detail)).toBe('Delegating to research assistant');
    });

    it('returns "Delegating to a sub-agent" when no name in detail', () => {
      expect(humanizeToolActivity('Agent', '{}')).toBe('Delegating to a sub-agent');
    });
  });

  describe('planning tools', () => {
    it('returns "Updating the plan" for TodoWrite', () => {
      expect(humanizeToolActivity('TodoWrite')).toBe('Updating the plan');
    });

    it('returns "Updating tasks" for TaskCreate', () => {
      expect(humanizeToolActivity('TaskCreate')).toBe('Updating tasks');
    });

    it('returns "Updating tasks" for TaskUpdate', () => {
      expect(humanizeToolActivity('TaskUpdate')).toBe('Updating tasks');
    });
  });

  describe('MCP tools', () => {
    it('parses slash-delimited MCP tool names', () => {
      expect(humanizeToolActivity('google_calendar/list_events')).toBe('Using Google Calendar');
    });

    it('parses double-underscore MCP tool names', () => {
      expect(humanizeToolActivity('mcp__slack__send_message')).toBe('Using Slack');
    });

    it('handles single-segment MCP tool with slash', () => {
      expect(humanizeToolActivity('toolbox/')).toBe('Using Toolbox');
    });
  });

  describe('fetch tools', () => {
    it('returns "Fetching a page" for FetchUrl', () => {
      expect(humanizeToolActivity('FetchUrl')).toBe('Fetching a page');
    });

    it('returns "Fetching a page" for fetch_url', () => {
      expect(humanizeToolActivity('fetch_url')).toBe('Fetching a page');
    });

    it('returns "Fetching a page" for WebFetch', () => {
      expect(humanizeToolActivity('WebFetch')).toBe('Fetching a page');
    });

    it('returns "Fetching a page" for web_fetch', () => {
      expect(humanizeToolActivity('web_fetch')).toBe('Fetching a page');
    });
  });

  describe('search files tools', () => {
    it('returns "Searching files" for SearchFiles', () => {
      expect(humanizeToolActivity('SearchFiles')).toBe('Searching files');
    });

    it('returns "Searching files" for search_files', () => {
      expect(humanizeToolActivity('search_files')).toBe('Searching files');
    });
  });

  describe('screenshot tools', () => {
    it('returns "Taking a screenshot" for screenshot', () => {
      expect(humanizeToolActivity('screenshot')).toBe('Taking a screenshot');
    });

    it('returns "Taking a screenshot" for take_screenshot', () => {
      expect(humanizeToolActivity('take_screenshot')).toBe('Taking a screenshot');
    });
  });

  describe('mission/task tools', () => {
    it('returns "Setting the mission" for MissionSet', () => {
      expect(humanizeToolActivity('MissionSet')).toBe('Setting the mission');
    });

    it('returns "Reviewing tasks" for TaskList', () => {
      expect(humanizeToolActivity('TaskList')).toBe('Reviewing tasks');
    });
  });

  describe('view/cat tools', () => {
    it('returns "Reading <filename>" for view with path detail', () => {
      const detail = JSON.stringify({ file_path: '/home/user/docs/notes.md' });
      expect(humanizeToolActivity('view', detail)).toBe('Reading notes.md');
    });

    it('returns "Reading a file" for view without detail', () => {
      expect(humanizeToolActivity('view')).toBe('Reading a file');
    });

    it('returns "Reading <filename>" for cat with path detail', () => {
      const detail = JSON.stringify({ path: '/tmp/output.log' });
      expect(humanizeToolActivity('cat', detail)).toBe('Reading output.log');
    });

    it('returns "Reading a file" for cat without detail', () => {
      expect(humanizeToolActivity('cat')).toBe('Reading a file');
    });
  });

  describe('smart fallback', () => {
    it('returns "Using Gmail" for unknown tool "gmail"', () => {
      expect(humanizeToolActivity('gmail')).toBe('Using Gmail');
    });

    it('returns "Using Custom Tool" for camelCase unknown tool "CustomTool"', () => {
      expect(humanizeToolActivity('CustomTool')).toBe('Using Custom Tool');
    });

    it('returns "Using Some Widget" for snake_case unknown tool "some_widget"', () => {
      expect(humanizeToolActivity('some_widget')).toBe('Using Some Widget');
    });

    it('returns "Working…" for empty tool name', () => {
      expect(humanizeToolActivity('')).toBe('Working…');
    });

    it('returns "Working…" for whitespace-only tool name', () => {
      expect(humanizeToolActivity('   ')).toBe('Working…');
    });
  });

  describe('basename extraction', () => {
    it('extracts basename from Windows-style paths', () => {
      const detail = JSON.stringify({ path: 'C:\\Users\\dev\\project\\file.ts' });
      expect(humanizeToolActivity('Read', detail)).toBe('Reading file.ts');
    });

    it('handles path with no directory component', () => {
      const detail = JSON.stringify({ path: 'file.ts' });
      expect(humanizeToolActivity('Read', detail)).toBe('Reading file.ts');
    });

    it('handles invalid JSON detail gracefully', () => {
      expect(humanizeToolActivity('Read', 'not json')).toBe('Reading a file');
    });

    it('handles empty string path gracefully', () => {
      const detail = JSON.stringify({ path: '' });
      expect(humanizeToolActivity('Read', detail)).toBe('Reading a file');
    });
  });
});
