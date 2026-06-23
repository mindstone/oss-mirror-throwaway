import { describe, expect, it } from 'vitest';
import { buildStagedFileActionText, buildMemoryApprovalActionText } from '../DrawerApprovalCard';

describe('approval messaging helpers', () => {
  it('builds staged-file action text for new files', () => {
    expect(
      buildStagedFileActionText({
        baseHash: 'new-file',
        fileName: 'Three-Year-Future-Scenarios.md',
        spaceName: 'Mindstone Strategy Q1 2026',
      }),
    ).toBe(
      'Rebel wants to create Three Year Future Scenarios in Mindstone Strategy Q1 2026',
    );
  });

  it('builds staged-file action text for modified files', () => {
    expect(
      buildStagedFileActionText({
        baseHash: 'abc123',
        fileName: 'Three-Year-Future-Scenarios.md',
        spaceName: 'Mindstone Strategy Q1 2026',
      }),
    ).toBe(
      'Rebel wants to update Three Year Future Scenarios in Mindstone Strategy Q1 2026',
    );
  });

  it('handles missing spaceName in staged-file action text', () => {
    expect(
      buildStagedFileActionText({
        baseHash: 'abc123',
        fileName: 'notes.md',
        spaceName: '',
      }),
    ).toBe('Rebel wants to update Notes');
  });

  it('handles missing fileName in staged-file action text', () => {
    expect(
      buildStagedFileActionText({
        baseHash: 'new-file',
        fileName: '',
        spaceName: 'My Space',
      }),
    ).toBe('Rebel wants to create a file in My Space');
  });

  it('builds drawer memory approval action text with file and space', () => {
    expect(
      buildMemoryApprovalActionText({
        filePath: '/workspace/space/Three-Year-Future-Scenarios.md',
        spaceName: 'Mindstone Strategy Q1 2026',
      }),
    ).toBe(
      'Rebel wants to save Three Year Future Scenarios to Mindstone Strategy Q1 2026',
    );
  });

  it('builds drawer memory approval action text without file path', () => {
    expect(
      buildMemoryApprovalActionText({
        filePath: '',
        spaceName: 'My Space',
      }),
    ).toBe('Rebel wants to save to My Space');
  });

  it('builds drawer memory approval action text with missing spaceName', () => {
    expect(
      buildMemoryApprovalActionText({
        filePath: '/path/notes.md',
        spaceName: '',
      }),
    ).toBe('Rebel wants to save Notes to a space');
  });

  it('keeps outside-workspace action text focused on the action', () => {
    expect(
      buildMemoryApprovalActionText({
        filePath: '/Users/you/Documents/ACME Corp/README.md',
        spaceName: 'Outside workspace',
      }),
    ).toBe(
      'Rebel wants to save README to Outside workspace',
    );
  });

  it('keeps outside-workspace action text focused on the action for Windows paths', () => {
    expect(
      buildMemoryApprovalActionText({
        filePath: 'C:\\Users\\liam\\Desktop\\report.md',
        spaceName: 'Outside workspace',
      }),
    ).toBe(
      'Rebel wants to save Report to Outside workspace',
    );
  });

  it('keeps plain "Outside workspace" when filePath has no parent folder', () => {
    expect(
      buildMemoryApprovalActionText({
        filePath: '/README.md',
        spaceName: 'Outside workspace',
      }),
    ).toBe('Rebel wants to save README to Outside workspace');
  });

  it('keeps plain "Outside workspace" when filePath is missing', () => {
    expect(
      buildMemoryApprovalActionText({
        filePath: '',
        spaceName: 'Outside workspace',
      }),
    ).toBe('Rebel wants to save to Outside workspace');
  });

  // Source-capture humanisation: when the filename follows the
  // yyMMdd_HHmm_source-type_description.md convention, replace the raw filename
  // with natural-language copy.
  it('humanises staged-file action text for a meeting source capture', () => {
    expect(
      buildStagedFileActionText({
        baseHash: 'new-file',
        fileName: '260418_1430_meeting_q3-review.md',
        spaceName: 'Mindstone General',
      }),
    ).toBe('Share Q3 Review meeting notes with your Mindstone General space?');
  });

  it('humanises staged-file action text for an email source capture', () => {
    expect(
      buildStagedFileActionText({
        baseHash: 'new-file',
        fileName: '260418_0900_email_client-proposal-discussion.md',
        spaceName: 'Sales',
      }),
    ).toBe('Share Client Proposal Discussion email thread with your Sales space?');
  });

  it('humanises staged-file action text for a thread source capture', () => {
    expect(
      buildStagedFileActionText({
        baseHash: 'new-file',
        fileName: '260418_1000_thread_architecture-discussion.md',
        spaceName: 'Engineering',
      }),
    ).toBe('Share Architecture Discussion thread with your Engineering space?');
  });

  it('humanises staged-file action text for a PDF / doc source capture', () => {
    expect(
      buildStagedFileActionText({
        baseHash: 'new-file',
        fileName: '260418_0000_pdf_annual-report.md',
        spaceName: 'Mindstone General',
      }),
    ).toBe('Share Annual Report with your Mindstone General space?');
  });

  it('humanises non-source-capture staged files (strips .md extension)', () => {
    expect(
      buildStagedFileActionText({
        baseHash: 'new-file',
        fileName: 'Three-Year-Future-Scenarios.md',
        spaceName: 'Mindstone Strategy Q1 2026',
      }),
    ).toBe(
      'Rebel wants to create Three Year Future Scenarios in Mindstone Strategy Q1 2026',
    );
  });

  it('humanises date-prefixed non-source-capture filenames', () => {
    expect(
      buildStagedFileActionText({
        baseHash: 'new-file',
        fileName: '260418_meeting_q3-review.md',
        spaceName: 'Mindstone General',
      }),
    ).toBe('Rebel wants to create Meeting Q3 Review in Mindstone General');
  });

  it('humanises unrecognised source-type filenames', () => {
    expect(
      buildStagedFileActionText({
        baseHash: 'new-file',
        fileName: '260418_1200_widget_something.md',
        spaceName: 'Mindstone General',
      }),
    ).toBe('Rebel wants to create Widget Something in Mindstone General');
  });

  it('humanises memory approval action text for a meeting source capture', () => {
    expect(
      buildMemoryApprovalActionText({
        filePath: '/workspace/Chief-of-Staff/memory/sources/2026/04-Apr/18/260418_1430_meeting_q3-review.md',
        spaceName: 'Chief-of-Staff',
      }),
    ).toBe('Share Q3 Review meeting notes with your Chief-of-Staff space?');
  });

  it('humanises memory approval filename when not a source capture', () => {
    expect(
      buildMemoryApprovalActionText({
        filePath: '/workspace/space/notes.md',
        spaceName: 'My Space',
      }),
    ).toBe('Rebel wants to save Notes to My Space');
  });
});

describe('approval message clarity — humanised filenames', () => {
  it('humanises slug-only filenames (was BASELINE: F1/F2)', () => {
    const result = buildStagedFileActionText({
      baseHash: 'new-file',
      fileName: 'Team Member-Team Member.md',
      spaceName: 'General',
    });
    expect(result).toBe('Rebel wants to create Team Member in General');
  });

  it('humanises date-prefixed non-source files (was BASELINE: F1/F2)', () => {
    const result = buildStagedFileActionText({
      baseHash: 'new-file',
      fileName: '260409_Q2-OKRs-2026.md',
      spaceName: 'Exec',
    });
    expect(result).toBe('Rebel wants to create Q2 OKRs 2026 in Exec');
  });

  it('produces near-identical text across multiple files differing only by filename (BASELINE: F2)', () => {
    // BASELINE: F2 — in a 37-card queue, the only differentiator is the raw filename.
    // After fix, should produce more varied, descriptive action text.
    const files = ['MCP-Open-Source-Launch-Brief.md', 'Three-Year-Future-Scenarios.md', 'Product-Roadmap-H2.md'];
    const results = files.map(fileName =>
      buildStagedFileActionText({ baseHash: 'new-file', fileName, spaceName: 'General' })
    );
    // All share the same template, differing only by filename
    expect(results.every(r => r.startsWith('Rebel wants to create'))).toBe(true);
  });
});
