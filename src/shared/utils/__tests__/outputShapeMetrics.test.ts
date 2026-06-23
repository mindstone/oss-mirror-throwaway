import { describe, expect, it } from 'vitest';

import { computeOutputShapeMetrics } from '../outputShapeMetrics';

describe('computeOutputShapeMetrics', () => {
  it('classifies empty and short answer text', () => {
    expect(computeOutputShapeMetrics('   ')).toMatchObject({
      wordCount: 0,
      headingCount: 0,
      shapeBucket: 'empty',
    });

    expect(computeOutputShapeMetrics('Done. I found the setting and updated it.')).toMatchObject({
      wordCount: 8,
      headingCount: 0,
      shapeBucket: 'short_answer',
    });
  });

  it('counts markdown structure outside code fences only', () => {
    const metrics = computeOutputShapeMetrics(`## Actual heading

- Actual bullet
1. Actual numbered item

\`\`\`markdown
## Ignored heading
- Ignored bullet
2. Ignored numbered item
\`\`\`
`);

    expect(metrics).toMatchObject({
      headingCount: 1,
      bulletCount: 1,
      numberedListCount: 1,
      codeBlockCount: 1,
    });
  });

  it('detects tables, links, and source sections without keeping content', () => {
    const metrics = computeOutputShapeMetrics(`Here is the summary.

| Name | Value |
| --- | --- |
| A | B |

Sources:
- [Doc](https://example.com/doc)
- https://example.com/raw
`);

    expect(metrics.tableLineCount).toBe(3);
    expect(metrics.linkCount).toBe(2);
    expect(metrics.hasSourceSection).toBe(true);
    expect(metrics.shapeBucket).toBe('structured_response');
  });

  it('detects common source section heading styles', () => {
    expect(computeOutputShapeMetrics('**Sources:**\n- Internal doc').hasSourceSection).toBe(true);
    expect(computeOutputShapeMetrics('### References\n- Internal doc').hasSourceSection).toBe(true);
    expect(computeOutputShapeMetrics('Citations:\n- Internal doc').hasSourceSection).toBe(true);
  });

  it('classifies report-shaped chat bubbles', () => {
    const headings = Array.from({ length: 5 }, (_, index) => `## Section ${index + 1}`).join('\n');
    const bullets = Array.from({ length: 20 }, (_, index) => `- Finding ${index + 1}`).join('\n');
    const metrics = computeOutputShapeMetrics(`${headings}\n\n${bullets}`);

    expect(metrics.headingCount).toBe(5);
    expect(metrics.bulletCount).toBe(20);
    expect(metrics.shapeBucket).toBe('report_in_chat');
  });

  it('uses word-count tail threshold for long prose reports', () => {
    const longText = Array.from({ length: 1_000 }, () => 'word').join(' ');

    expect(computeOutputShapeMetrics(longText)).toMatchObject({
      wordCount: 1_000,
      shapeBucket: 'report_in_chat',
    });
  });
});
