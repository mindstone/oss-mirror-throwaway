/**
 * Tests for extractBashWriteTargets
 * 
 * This function detects file write operations in Bash commands to enable
 * Memory Safety checks even when Bash is trusted for read-only operations.
 * 
 * See: docs/plans/finished/260117_subagent_memory_safety_bypass_investigation.md
 */

import { describe, it, expect } from 'vitest';
import { extractBashWriteTargets } from '../safety/memoryWriteHook';

describe('extractBashWriteTargets', () => {
  // ==========================================================================
  // Redirection operators
  // ==========================================================================
  describe('redirection operators', () => {
    it('extracts > redirection target', () => {
      expect(extractBashWriteTargets('cat > file.md')).toEqual(['file.md']);
      expect(extractBashWriteTargets('echo "test" > output.txt')).toEqual(['output.txt']);
    });

    it('extracts >> append redirection target', () => {
      expect(extractBashWriteTargets('echo test >> log.txt')).toEqual(['log.txt']);
      expect(extractBashWriteTargets('cat data >> existing.md')).toEqual(['existing.md']);
    });

    it('extracts >| noclobber override target', () => {
      expect(extractBashWriteTargets('cmd >| force.txt')).toEqual(['force.txt']);
    });

    it('handles redirection with paths containing directories', () => {
      expect(extractBashWriteTargets('cat > /path/to/file.md')).toEqual(['/path/to/file.md']);
      expect(extractBashWriteTargets('echo test > work/space/note.txt')).toEqual(['work/space/note.txt']);
    });

    it('handles multiple redirections in one command', () => {
      const result = extractBashWriteTargets('cmd > file1.txt; other > file2.txt');
      expect(result).toContain('file1.txt');
      expect(result).toContain('file2.txt');
    });

    it('extracts &> combined stdout+stderr redirection', () => {
      expect(extractBashWriteTargets('cmd &> output.log')).toEqual(['output.log']);
      expect(extractBashWriteTargets('make &> build.log')).toEqual(['build.log']);
    });

    it('extracts &>> append stdout+stderr redirection', () => {
      expect(extractBashWriteTargets('cmd &>> output.log')).toEqual(['output.log']);
    });

    it('extracts 2> stderr redirection', () => {
      expect(extractBashWriteTargets('cmd 2> errors.log')).toEqual(['errors.log']);
    });

    it('extracts 2>> append stderr redirection', () => {
      expect(extractBashWriteTargets('cmd 2>> errors.log')).toEqual(['errors.log']);
    });

    it('extracts multiple redirect types in one command', () => {
      const result = extractBashWriteTargets('cmd > stdout.log 2> stderr.log');
      expect(result).toContain('stdout.log');
      expect(result).toContain('stderr.log');
    });
  });

  // ==========================================================================
  // Quoted paths
  // ==========================================================================
  describe('quoted paths', () => {
    it('handles double-quoted paths with spaces', () => {
      expect(extractBashWriteTargets('cat > "path with spaces.md"')).toEqual(['path with spaces.md']);
      expect(extractBashWriteTargets('echo test > "my file.txt"')).toEqual(['my file.txt']);
    });

    it('handles single-quoted paths', () => {
      expect(extractBashWriteTargets("cat > 'quoted.md'")).toEqual(['quoted.md']);
      expect(extractBashWriteTargets("echo test > 'file name.txt'")).toEqual(['file name.txt']);
    });

    it('handles quoted paths with special characters', () => {
      expect(extractBashWriteTargets('cat > "file (copy).md"')).toEqual(['file (copy).md']);
    });
  });

  // ==========================================================================
  // tee command
  // ==========================================================================
  describe('tee command', () => {
    it('extracts single tee target', () => {
      expect(extractBashWriteTargets('echo test | tee file.txt')).toEqual(['file.txt']);
      expect(extractBashWriteTargets('cat input | tee output.md')).toEqual(['output.md']);
    });

    it('extracts tee with -a append flag', () => {
      expect(extractBashWriteTargets('cmd | tee -a log.txt')).toEqual(['log.txt']);
    });

    it('extracts multiple tee targets', () => {
      const result = extractBashWriteTargets('cmd | tee file1.txt file2.txt');
      expect(result).toContain('file1.txt');
      expect(result).toContain('file2.txt');
    });

    it('extracts tee with quoted paths', () => {
      expect(extractBashWriteTargets('cmd | tee "path with space.txt"')).toEqual(['path with space.txt']);
    });
  });

  // ==========================================================================
  // cp and mv commands
  // ==========================================================================
  describe('cp and mv commands', () => {
    it('extracts cp destination (last non-option argument)', () => {
      expect(extractBashWriteTargets('cp source.txt dest.txt')).toEqual(['dest.txt']);
      expect(extractBashWriteTargets('cp file.md backup.md')).toEqual(['backup.md']);
    });

    it('extracts cp with -r flag', () => {
      expect(extractBashWriteTargets('cp -r src/ dest/')).toEqual(['dest/']);
    });

    it('extracts cp with multiple sources', () => {
      // cp file1 file2 file3 destdir/ → destdir/
      expect(extractBashWriteTargets('cp file1 file2 destdir/')).toEqual(['destdir/']);
    });

    it('extracts mv destination', () => {
      expect(extractBashWriteTargets('mv old.txt new.txt')).toEqual(['new.txt']);
      expect(extractBashWriteTargets('mv -f source dest')).toEqual(['dest']);
    });

    it('handles cp/mv with quoted paths', () => {
      expect(extractBashWriteTargets('cp source "dest with space.txt"')).toEqual(['dest with space.txt']);
      expect(extractBashWriteTargets("mv old 'new name.txt'")).toEqual(['new name.txt']);
    });
  });

  // ==========================================================================
  // install command
  // ==========================================================================
  describe('install command', () => {
    it('extracts install destination', () => {
      expect(extractBashWriteTargets('install src dest')).toEqual(['dest']);
    });

    it('extracts install with mode flag', () => {
      expect(extractBashWriteTargets('install -m 755 script.sh /usr/local/bin/script')).toEqual(['/usr/local/bin/script']);
    });

    it('extracts install with multiple flags', () => {
      expect(extractBashWriteTargets('install -D -m 644 config.ini /etc/app/config.ini')).toEqual(['/etc/app/config.ini']);
    });
  });

  // ==========================================================================
  // rsync command
  // ==========================================================================
  describe('rsync command', () => {
    it('extracts rsync destination', () => {
      expect(extractBashWriteTargets('rsync src/ dest/')).toEqual(['dest/']);
    });

    it('extracts rsync with flags', () => {
      expect(extractBashWriteTargets('rsync -av /source/ /backup/')).toEqual(['/backup/']);
    });

    it('extracts rsync with multiple sources', () => {
      expect(extractBashWriteTargets('rsync -r file1 file2 destdir/')).toEqual(['destdir/']);
    });
  });

  // ==========================================================================
  // dd command
  // ==========================================================================
  describe('dd command', () => {
    it('extracts dd of= destination', () => {
      expect(extractBashWriteTargets('dd if=/dev/zero of=output.bin bs=1M count=10')).toEqual(['output.bin']);
    });

    it('extracts dd with of= at different positions', () => {
      expect(extractBashWriteTargets('dd bs=1M of=file.img if=/dev/sda')).toEqual(['file.img']);
    });

    it('handles dd with quoted of= path', () => {
      expect(extractBashWriteTargets('dd if=/dev/zero of="file with space.bin"')).toEqual(['file with space.bin']);
    });

    it('handles dd with absolute path', () => {
      expect(extractBashWriteTargets('dd if=/dev/zero of=/tmp/output.bin')).toEqual(['/tmp/output.bin']);
    });
  });

  // ==========================================================================
  // cd prefix handling
  // ==========================================================================
  describe('cd prefix handling', () => {
    it('prepends cd path to relative targets with &&', () => {
      expect(extractBashWriteTargets('cd /some/path && cat > file.md')).toEqual(['/some/path/file.md']);
    });

    it('prepends cd path to relative targets with ;', () => {
      expect(extractBashWriteTargets('cd /work/dir; echo test > note.txt')).toEqual(['/work/dir/note.txt']);
    });

    it('handles relative cd paths', () => {
      expect(extractBashWriteTargets('cd work/space && echo test > note.txt')).toEqual(['work/space/note.txt']);
    });

    it('does not modify absolute targets even with cd prefix', () => {
      expect(extractBashWriteTargets('cd /some/path && cat > /absolute/file.md')).toEqual(['/absolute/file.md']);
    });

    it('handles cd with quoted path', () => {
      expect(extractBashWriteTargets('cd "/path with spaces" && cat > file.md')).toEqual(['/path with spaces/file.md']);
    });
  });

  // ==========================================================================
  // Read-only commands (no write targets)
  // ==========================================================================
  describe('read-only commands (returns null)', () => {
    it('returns null for ls commands', () => {
      expect(extractBashWriteTargets('ls -la')).toBeNull();
      expect(extractBashWriteTargets('ls /tmp')).toBeNull();
    });

    it('returns null for cat without redirection', () => {
      expect(extractBashWriteTargets('cat file.txt')).toBeNull();
      expect(extractBashWriteTargets('cat /etc/passwd')).toBeNull();
    });

    it('returns null for grep commands', () => {
      expect(extractBashWriteTargets('grep pattern file')).toBeNull();
      expect(extractBashWriteTargets('grep -r "search" .')).toBeNull();
    });

    it('returns null for find commands without -exec write', () => {
      expect(extractBashWriteTargets('find . -name "*.md"')).toBeNull();
    });

    it('returns null for echo without redirection', () => {
      expect(extractBashWriteTargets('echo "hello world"')).toBeNull();
    });

    it('returns null for pwd, whoami, date', () => {
      expect(extractBashWriteTargets('pwd')).toBeNull();
      expect(extractBashWriteTargets('whoami')).toBeNull();
      expect(extractBashWriteTargets('date')).toBeNull();
    });

    it('returns null for empty command', () => {
      expect(extractBashWriteTargets('')).toBeNull();
    });
  });

  // ==========================================================================
  // Complex commands with multiple operations
  // ==========================================================================
  describe('complex commands', () => {
    it('extracts all targets from chained commands with ;', () => {
      const result = extractBashWriteTargets('cat a > b; cp c d');
      expect(result).toContain('b');
      expect(result).toContain('d');
    });

    it('extracts all targets from chained commands with &&', () => {
      const result = extractBashWriteTargets('echo test > file1.txt && cp file1.txt file2.txt');
      expect(result).toContain('file1.txt');
      expect(result).toContain('file2.txt');
    });

    it('extracts targets from piped commands ending in tee', () => {
      expect(extractBashWriteTargets('cat file | grep pattern | tee output.txt')).toEqual(['output.txt']);
    });
  });

  // ==========================================================================
  // Real-world examples from the privacy breach incident
  // ==========================================================================
  describe('real-world examples', () => {
    it('detects cat heredoc style write (simplified)', () => {
      // The actual incident used: cat > file.md << 'EOF' ... EOF
      // We detect the redirection part
      expect(extractBashWriteTargets('cat > Executive-Offsite-Part-1.md')).toEqual(['Executive-Offsite-Part-1.md']);
    });

    it('detects write to memory space path', () => {
      const cmd = 'cd /Users/you/workspace && cat > work/Company_REBEL/memory/sources/2026/01-Jan/13/notes.md';
      const result = extractBashWriteTargets(cmd);
      expect(result).toEqual(['/Users/you/workspace/work/Company_REBEL/memory/sources/2026/01-Jan/13/notes.md']);
    });

    it('detects BigQuery result export (read-only, no write)', () => {
      // BigQuery queries via bq command are read-only
      expect(extractBashWriteTargets('bq query --use_legacy_sql=false "SELECT * FROM table"')).toBeNull();
    });
  });
});
