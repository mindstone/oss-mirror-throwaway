import { describe, expect, it } from 'vitest';
import {
  extractSourceMetadata,
  extractSourceMetadataFromFileName,
} from '../extractSourceMetadata';

describe('extractSourceMetadataFromFileName', () => {
  it('parses a meeting source-capture filename', () => {
    expect(extractSourceMetadataFromFileName('260418_1430_meeting_q3-review.md')).toEqual({
      description: 'Q3 Review',
      sourceType: 'meeting',
      occurredAt: '2026-04-18',
    });
  });

  it('parses an email source-capture filename', () => {
    expect(
      extractSourceMetadataFromFileName('260418_0900_email_client-proposal-discussion.md'),
    ).toEqual({
      description: 'Client Proposal Discussion',
      sourceType: 'email',
      occurredAt: '2026-04-18',
    });
  });

  it('parses a thread source-capture filename', () => {
    expect(
      extractSourceMetadataFromFileName('260418_1000_thread_architecture-discussion.md'),
    ).toEqual({
      description: 'Architecture Discussion',
      sourceType: 'thread',
      occurredAt: '2026-04-18',
    });
  });

  it('parses a filename with 0000 time (unknown time)', () => {
    expect(extractSourceMetadataFromFileName('260420_0000_pdf_annual-report.md')).toEqual({
      description: 'Annual Report',
      sourceType: 'pdf',
      occurredAt: '2026-04-20',
    });
  });

  it('returns empty object for a non-source-capture filename', () => {
    expect(extractSourceMetadataFromFileName('Three-Year-Future-Scenarios.md')).toEqual({});
  });

  it('returns empty object for a plain note filename', () => {
    expect(extractSourceMetadataFromFileName('notes.md')).toEqual({});
  });

  it('returns empty object when the time segment is missing', () => {
    expect(extractSourceMetadataFromFileName('260418_meeting_q3-review.md')).toEqual({});
  });

  it('keeps description/sourceType but drops occurredAt when the date is invalid', () => {
    // The filename still matches the source-capture pattern structurally; only
    // the date portion is unparseable. Humanisation stays useful via description +
    // sourceType, just without a date-based context line.
    expect(extractSourceMetadataFromFileName('261318_1430_meeting_q3-review.md')).toEqual({
      description: 'Q3 Review',
      sourceType: 'meeting',
      occurredAt: undefined,
    });
  });

  it('returns empty object for an empty filename', () => {
    expect(extractSourceMetadataFromFileName('')).toEqual({});
  });
});

describe('extractSourceMetadata', () => {
  it('parses a full source-capture frontmatter block', () => {
    const content = `---
description: "Q3 quarterly review with leadership"
source_type: meeting
source_system: fireflies
source_account: [external-email]
source_uid: abc123xyz
participants: [Jane Smith, Bob Chen, Carol Davis]
duration_minutes: 45
stored_at: 2026-04-18
occurred_at: 2026-04-18
---

# Q3 Quarterly Review
`;
    expect(extractSourceMetadata(content)).toEqual({
      description: 'Q3 quarterly review with leadership',
      sourceType: 'meeting',
      participants: ['Jane Smith', 'Bob Chen', 'Carol Davis'],
      occurredAt: '2026-04-18',
    });
  });

  it('parses a frontmatter block using block-form participants', () => {
    const content = `---
description: Engineering sync
source_type: meeting
participants:
  - Jane Smith
  - Bob Chen
occurred_at: 2026-04-18
---

body
`;
    expect(extractSourceMetadata(content)).toEqual({
      description: 'Engineering sync',
      sourceType: 'meeting',
      participants: ['Jane Smith', 'Bob Chen'],
      occurredAt: '2026-04-18',
    });
  });

  it('returns empty object for content without frontmatter', () => {
    const content = '# Just a heading\n\nSome prose.';
    expect(extractSourceMetadata(content)).toEqual({});
  });

  it('returns empty object for empty content', () => {
    expect(extractSourceMetadata('')).toEqual({});
  });

  it('omits missing fields rather than setting them to empty strings', () => {
    const content = `---
description: Partial metadata
---

body
`;
    const result = extractSourceMetadata(content);
    expect(result.description).toBe('Partial metadata');
    expect(result.sourceType).toBeUndefined();
    expect(result.participants).toBeUndefined();
    expect(result.occurredAt).toBeUndefined();
  });
});
