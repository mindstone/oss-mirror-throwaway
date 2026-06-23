import { describe, it, expect } from 'vitest';
import { extractBashHeredocContent } from '../safety/memoryWriteHook';

describe('extractBashHeredocContent', () => {
  it('returns null for empty/undefined input', () => {
    expect(extractBashHeredocContent('')).toBeNull();
    expect(extractBashHeredocContent(null as unknown as string)).toBeNull();
  });

  it('returns null for non-heredoc commands', () => {
    expect(extractBashHeredocContent('echo "hello" > file.md')).toBeNull();
    expect(extractBashHeredocContent('cat > file.md')).toBeNull();
    expect(extractBashHeredocContent('cp src.md dst.md')).toBeNull();
  });

  it('extracts content from single-quoted heredoc', () => {
    const cmd = "cat > /path/to/file.md << 'ENDOFFILE'\n# Title\nSome content here\nENDOFFILE";
    expect(extractBashHeredocContent(cmd)).toBe('# Title\nSome content here');
  });

  it('extracts content from double-quoted heredoc', () => {
    const cmd = 'cat > /path/to/file.md << "EOF"\nline 1\nline 2\nEOF';
    expect(extractBashHeredocContent(cmd)).toBe('line 1\nline 2');
  });

  it('extracts content from unquoted heredoc', () => {
    const cmd = 'cat > /path/to/file.md << EOF\ncontent\nEOF';
    expect(extractBashHeredocContent(cmd)).toBe('content');
  });

  it('returns null for <<- (strip-leading-tabs) -- cannot faithfully reproduce', () => {
    const cmd = "cat > file.md <<- 'MARKER'\n\tcontent with tabs\nMARKER";
    expect(extractBashHeredocContent(cmd)).toBeNull();
  });

  it('returns null for append redirections (>>)', () => {
    const cmd = "cat >> /path/to/file.md << 'EOF'\nappended content\nEOF";
    expect(extractBashHeredocContent(cmd)).toBeNull();
  });

  it('returns null for tee -a (append mode)', () => {
    const cmd = "tee -a /path/to/file.md << 'EOF'\nappended content\nEOF";
    expect(extractBashHeredocContent(cmd)).toBeNull();
  });

  it('handles multi-line content with markdown', () => {
    const content = [
      '---',
      'title: Test Document',
      '---',
      '',
      '# Heading',
      '',
      'Paragraph with **bold** text.',
      '',
      '- Item 1',
      '- Item 2',
    ].join('\n');
    const cmd = `cat > /workspace/doc.md << 'ENDOFFILE'\n${content}\nENDOFFILE`;
    expect(extractBashHeredocContent(cmd)).toBe(content);
  });

  it('handles tee with heredoc', () => {
    const cmd = "tee /path/to/file.md << 'EOF'\nsome content\nEOF";
    expect(extractBashHeredocContent(cmd)).toBe('some content');
  });

  it('returns null when closing marker is missing', () => {
    const cmd = "cat > file.md << 'EOF'\ncontent without closing marker";
    expect(extractBashHeredocContent(cmd)).toBeNull();
  });

  it('returns null when closing marker has extra text', () => {
    const cmd = "cat > file.md << 'EOF'\ncontent\nEOF extra text on same line";
    // 'EOF extra text on same line'.trim() !== 'EOF', so this should not match
    expect(extractBashHeredocContent(cmd)).toBeNull();
  });

  it('handles empty heredoc content', () => {
    const cmd = "cat > file.md << 'EOF'\nEOF";
    expect(extractBashHeredocContent(cmd)).toBe('');
  });

  it('handles ENDOFFILE marker (common in agent output)', () => {
    const cmd = "cat > /Users/you/Documents/file.md << 'ENDOFFILE'\n---\ndescription: \"Test\"\n---\n\n# Proposal\n\nContent here.\nENDOFFILE";
    const result = extractBashHeredocContent(cmd);
    expect(result).toContain('# Proposal');
    expect(result).toContain('description: "Test"');
  });
});
