import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OfficeContextChip } from '../OfficeContextChip';

describe('OfficeContextChip', () => {
  it('renders a surface-aware Office chip without exposing document URLs', () => {
    const markup = renderToStaticMarkup(
      <OfficeContextChip host="word" title="Quarterly Plan.docx" />,
    );

    expect(markup).toContain('data-testid="office-context-chip"');
    expect(markup).toContain('From Word');
    expect(markup).toContain('Quarterly Plan.docx');
    expect(markup).not.toContain('file://');
  });
});
