import { describe, it, expect } from 'vitest';
import { extractBashWriteContent, extractBashCopySource } from '../bashContentExtractor';

describe('extractBashWriteContent', () => {
  describe('positive cases', () => {
    it('extracts content from echo with double quotes (includes trailing newline)', () => {
      expect(extractBashWriteContent('echo "hello" > file.md')).toBe('hello\n');
    });

    it('extracts content from echo with single quotes (includes trailing newline)', () => {
      expect(extractBashWriteContent("echo 'hello world' > file.md")).toBe('hello world\n');
    });

    it('extracts and unescapes printf newline content', () => {
      expect(extractBashWriteContent('printf "hello\\nworld" > file.md')).toBe('hello\nworld');
    });

    it('extracts and unescapes printf tab content', () => {
      expect(extractBashWriteContent("printf 'hello\\tworld' > file.md")).toBe('hello\tworld');
    });

    it('extracts literal echo content with escaped newline sequence (includes trailing newline)', () => {
      expect(extractBashWriteContent('echo "multi\\nline" > /path/to/file')).toBe('multi\\nline\n');
    });

    it('extracts empty echo content (just trailing newline)', () => {
      expect(extractBashWriteContent('echo "" > file')).toBe('\n');
    });
  });

  describe('negative cases', () => {
    it('rejects append writes', () => {
      expect(extractBashWriteContent('echo "x" >> file')).toBeNull();
    });

    it('rejects variable expansion', () => {
      expect(extractBashWriteContent('echo $VAR > file')).toBeNull();
    });

    it('rejects subshell execution', () => {
      expect(extractBashWriteContent('echo $(cmd) > file')).toBeNull();
    });

    it('rejects backtick execution', () => {
      expect(extractBashWriteContent('echo `cmd` > file')).toBeNull();
    });

    it('rejects ANSI-C quoted echo content', () => {
      expect(extractBashWriteContent("echo $'hello' > file")).toBeNull();
    });

    it('rejects compound commands with &&', () => {
      expect(extractBashWriteContent('echo "x" > file && echo "y"')).toBeNull();
    });

    it('rejects compound commands with semicolon', () => {
      expect(extractBashWriteContent('echo "x" > file; rm something')).toBeNull();
    });

    it('rejects compound commands with ||', () => {
      expect(extractBashWriteContent('echo "x" > file || echo "fallback"')).toBeNull();
    });

    it('rejects tee usage', () => {
      expect(extractBashWriteContent('echo "x" | tee file')).toBeNull();
    });

    it('rejects echo -e', () => {
      expect(extractBashWriteContent('echo -e "x\\n" > file')).toBeNull();
    });

    it('rejects echo -n', () => {
      expect(extractBashWriteContent('echo -n "x" > file')).toBeNull();
    });

    it('rejects printf %b format usage', () => {
      expect(extractBashWriteContent("printf '%b' \"x\" > file")).toBeNull();
    });

    it('rejects printf %s format usage', () => {
      expect(extractBashWriteContent("printf '%s' \"x\" > file")).toBeNull();
    });

    it('rejects multi-arg printf commands', () => {
      expect(extractBashWriteContent("printf '%s\\n' \"a\" \"b\" > file")).toBeNull();
    });

    it('rejects multi-target commands', () => {
      expect(extractBashWriteContent('echo "x" > file1 > file2')).toBeNull();
    });

    it('rejects commands without redirect', () => {
      expect(extractBashWriteContent('echo "hello"')).toBeNull();
    });

    it('rejects null byte content', () => {
      expect(extractBashWriteContent('printf "\\0" > file')).toBeNull();
    });

    it('rejects commands over max length', () => {
      const longCommand = `echo "${'a'.repeat(10_001)}" > file`;
      expect(extractBashWriteContent(longCommand)).toBeNull();
    });

    it('rejects empty commands', () => {
      expect(extractBashWriteContent('')).toBeNull();
    });

    it('rejects null commands', () => {
      expect(extractBashWriteContent((null as unknown) as string)).toBeNull();
    });
  });
});

describe('extractBashCopySource', () => {
  describe('cp patterns', () => {
    it('extracts source from simple cp', () => {
      expect(extractBashCopySource('cp source.md dest.md')).toBe('source.md');
    });

    it('extracts source from cp with absolute paths', () => {
      expect(extractBashCopySource('cp /path/to/source.md /path/to/dest.md')).toBe('/path/to/source.md');
    });

    it('extracts source from cp with quoted paths', () => {
      expect(extractBashCopySource('cp "path with spaces/source.md" dest.md')).toBe('path with spaces/source.md');
    });

    it('extracts source from cp with single-quoted paths', () => {
      expect(extractBashCopySource("cp 'source file.md' dest.md")).toBe('source file.md');
    });

    it('extracts source from cp with -f flag', () => {
      expect(extractBashCopySource('cp -f source.md dest.md')).toBe('source.md');
    });

    it('extracts source from cp with -p flag', () => {
      expect(extractBashCopySource('cp -p source.md dest.md')).toBe('source.md');
    });

    it('handles leading whitespace', () => {
      expect(extractBashCopySource('  cp source.md dest.md')).toBe('source.md');
    });
  });

  describe('cat redirect patterns', () => {
    it('extracts source from cat file > dest', () => {
      expect(extractBashCopySource('cat source.md > dest.md')).toBe('source.md');
    });

    it('extracts source from cat with absolute paths', () => {
      expect(extractBashCopySource('cat /workspace/proposal.md > /workspace/temp/copy.md')).toBe('/workspace/proposal.md');
    });

    it('extracts source from cat with quoted source', () => {
      expect(extractBashCopySource('cat "path with spaces/file.md" > dest.md')).toBe('path with spaces/file.md');
    });

    it('extracts source from cat with single-quoted source', () => {
      expect(extractBashCopySource("cat 'source file.md' > dest.md")).toBe('source file.md');
    });

    it('extracts source from cat with quoted dest', () => {
      expect(extractBashCopySource('cat source.md > "dest with spaces.md"')).toBe('source.md');
    });
  });

  describe('negative cases', () => {
    it('rejects cp -r (recursive)', () => {
      expect(extractBashCopySource('cp -r src/ dest/')).toBeNull();
    });

    it('rejects cp -R (recursive)', () => {
      expect(extractBashCopySource('cp -R src/ dest/')).toBeNull();
    });

    it('rejects cp -a (archive/recursive)', () => {
      expect(extractBashCopySource('cp -a src/ dest/')).toBeNull();
    });

    it('rejects compound commands with &&', () => {
      expect(extractBashCopySource('cp src dest && echo done')).toBeNull();
    });

    it('rejects compound commands with ;', () => {
      expect(extractBashCopySource('cp src dest; echo done')).toBeNull();
    });

    it('rejects mv (destroys source)', () => {
      expect(extractBashCopySource('mv src dest')).toBeNull();
    });

    it('rejects variable expansion', () => {
      expect(extractBashCopySource('cp $SRC dest')).toBeNull();
    });

    it('rejects backtick expansion', () => {
      expect(extractBashCopySource('cp `echo src` dest')).toBeNull();
    });

    it('rejects cp with more than 2 non-option args', () => {
      expect(extractBashCopySource('cp src1 src2 dest/')).toBeNull();
    });

    it('rejects cp with only 1 arg', () => {
      expect(extractBashCopySource('cp source.md')).toBeNull();
    });

    it('rejects cat with stdin (no file arg)', () => {
      expect(extractBashCopySource('cat > dest.md')).toBeNull();
    });

    it('rejects cat with pipe input', () => {
      expect(extractBashCopySource('cat - > dest.md')).toBeNull();
    });

    it('rejects cat append redirect', () => {
      expect(extractBashCopySource('cat source.md >> dest.md')).toBeNull();
    });

    it('rejects non-cp/cat commands', () => {
      expect(extractBashCopySource('rsync src dest')).toBeNull();
    });

    it('rejects empty commands', () => {
      expect(extractBashCopySource('')).toBeNull();
    });

    it('rejects null commands', () => {
      expect(extractBashCopySource((null as unknown) as string)).toBeNull();
    });
  });
});
