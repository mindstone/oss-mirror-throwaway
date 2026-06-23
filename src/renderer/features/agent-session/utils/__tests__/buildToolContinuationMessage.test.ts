import { describe, expect, it, vi } from 'vitest';
import { summarizeToolForApproval } from '../toolChips';

// Mock the toolChips module so we don't need the full dependency tree
vi.mock('../toolChips', () => ({
  summarizeToolForApproval: vi.fn(),
}));

const mockSummarize = vi.mocked(summarizeToolForApproval);

import { buildToolContinuationMessage } from '../buildToolContinuationMessage';

describe('buildToolContinuationMessage', () => {
  it('includes label and detail when detail is present', () => {
    mockSummarize.mockReturnValueOnce({
      label: 'Read file',
      detail: '/tmp/test.txt',
      icon: '📄',
      tone: 'files',
    });
    const result = buildToolContinuationMessage('read_file', { path: '/tmp/test.txt' });
    expect(result).toBe('Approved. Please retry: Read file (/tmp/test.txt)');
  });

  it('includes only label when detail is undefined', () => {
    mockSummarize.mockReturnValueOnce({
      label: 'Use unknown_tool',
      detail: undefined,
      icon: '⚙️',
      tone: 'default',
    });
    const result = buildToolContinuationMessage('unknown_tool', {});
    expect(result).toBe('Approved. Please retry: Use unknown_tool');
  });

  it('omits detail parenthetical when detail is empty string', () => {
    mockSummarize.mockReturnValueOnce({
      label: 'Do something',
      detail: '',
      icon: '⚙️',
      tone: 'default',
    });
    const result = buildToolContinuationMessage('some_tool', {});
    expect(result).toBe('Approved. Please retry: Do something');
  });

  it('passes toolName and input to summarizeToolForApproval', () => {
    mockSummarize.mockReturnValueOnce({
      label: 'Run command',
      detail: 'ls -la',
      icon: '⌨️',
      tone: 'shell',
    });
    buildToolContinuationMessage('bash', { command: 'ls -la' });
    expect(mockSummarize).toHaveBeenCalledWith('bash', { command: 'ls -la' });
  });

  it('handles input with nested objects', () => {
    mockSummarize.mockReturnValueOnce({
      label: 'Write file',
      detail: '/src/index.ts',
      icon: '📄',
      tone: 'files',
    });
    const result = buildToolContinuationMessage('write_file', {
      path: '/src/index.ts',
      content: 'export default {}',
    });
    expect(result).toBe('Approved. Please retry: Write file (/src/index.ts)');
  });
});
