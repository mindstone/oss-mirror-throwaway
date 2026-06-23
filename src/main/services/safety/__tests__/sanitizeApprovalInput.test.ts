import { describe, it, expect } from 'vitest';
import {
  sanitizeStagedToolCallForApproval,
  sanitizeToolInputForApproval,
} from '../sanitizeApprovalInput';

describe('sanitizeToolInputForApproval', () => {
  it('passes through small string values unchanged', () => {
    const input = { to: 'user@example.com', subject: 'Hello', body: 'Short body' };
    expect(sanitizeToolInputForApproval(input)).toEqual(input);
  });

  it('passes through non-base64 long strings', () => {
    const longText = 'This is a normal text. '.repeat(100);
    const input = { body: longText };
    expect(sanitizeToolInputForApproval(input)).toEqual(input);
  });

  it('strips large base64 strings', () => {
    const base64 = 'A'.repeat(2000) + '==';
    const input = { name: 'file.pdf', content: base64 };
    const result = sanitizeToolInputForApproval(input);
    expect(result.name).toBe('file.pdf');
    expect(result.content).toBe('[base64 content stripped for approval display]');
  });

  it('strips data URI base64', () => {
    const dataUri = 'data:application/pdf;base64,' + 'A'.repeat(2000);
    const input = { attachment: dataUri };
    const result = sanitizeToolInputForApproval(input);
    expect(result.attachment).toBe('[base64 content stripped for approval display]');
  });

  it('handles nested objects', () => {
    const base64 = 'B'.repeat(2000) + '=';
    const input = {
      to: 'user@example.com',
      attachments: [
        { name: 'doc.pdf', data: base64 },
        { name: 'img.png', data: base64 },
      ],
    };
    const result = sanitizeToolInputForApproval(input);
    expect(result.to).toBe('user@example.com');
    const attachments = result.attachments as Array<{ name: string; data: string }>;
    expect(attachments[0].name).toBe('doc.pdf');
    expect(attachments[0].data).toBe('[base64 content stripped for approval display]');
    expect(attachments[1].name).toBe('img.png');
    expect(attachments[1].data).toBe('[base64 content stripped for approval display]');
  });

  it('preserves numbers, booleans, and null', () => {
    const input = { count: 42, active: true, extra: null };
    expect(sanitizeToolInputForApproval(input)).toEqual(input);
  });

  it('preserves short base64-like strings (below threshold)', () => {
    const shortBase64 = 'SGVsbG8gV29ybGQ=';
    const input = { token: shortBase64 };
    expect(sanitizeToolInputForApproval(input)).toEqual(input);
  });

  it('handles empty input', () => {
    expect(sanitizeToolInputForApproval({})).toEqual({});
  });

  it('handles deeply nested base64', () => {
    const base64 = 'C'.repeat(2000);
    const input = {
      outer: {
        middle: {
          inner: { data: base64 },
        },
      },
    };
    const result = sanitizeToolInputForApproval(input);
    const inner = (result.outer as Record<string, unknown>);
    const middle = (inner.middle as Record<string, unknown>);
    const innermost = (middle.inner as Record<string, unknown>);
    expect(innermost.data).toBe('[base64 content stripped for approval display]');
  });

  it('sanitizes staged tool call args without changing other fields', () => {
    const base64 = 'D'.repeat(2000);
    const call = {
      id: 'staged-1',
      displayName: 'Send email',
      mcpPayload: {
        packageId: 'gmail',
        toolId: 'send_email',
        args: {
          to: 'user@example.com',
          attachments: [{ name: 'file.pdf', data: base64 }],
        },
      },
    };

    const result = sanitizeStagedToolCallForApproval(call);

    expect(result.id).toBe(call.id);
    expect(result.displayName).toBe(call.displayName);
    expect(result.mcpPayload.packageId).toBe('gmail');
    expect(result.mcpPayload.toolId).toBe('send_email');
    expect(result.mcpPayload.args.to).toBe('user@example.com');
    const attachments = result.mcpPayload.args.attachments as Array<{ name: string; data: string }>;
    expect(attachments[0].name).toBe('file.pdf');
    expect(attachments[0].data).toBe('[base64 content stripped for approval display]');
    expect(call.mcpPayload.args.attachments).not.toEqual(result.mcpPayload.args.attachments);
  });
});
