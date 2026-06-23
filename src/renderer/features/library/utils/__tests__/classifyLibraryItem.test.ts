import { describe, expect, it } from 'vitest';
import { classifyLibraryItem } from '../classifyLibraryItem';

describe('classifyLibraryItem', () => {
  it('returns skill for workspace-root skills', () => {
    expect(classifyLibraryItem({ relativePath: 'skills/write-email/SKILL.md' })).toBe('skill');
  });

  it('returns skill for platform skills', () => {
    expect(classifyLibraryItem({ relativePath: 'rebel-system/skills/system/foo/SKILL.md' })).toBe('skill');
  });

  it('prioritizes skill classification for memory-named skill folders', () => {
    expect(
      classifyLibraryItem({
        relativePath: 'rebel-system/skills/memory/memory-update/SKILL.md',
      }),
    ).toBe('skill');
  });

  it('returns skill for space skills', () => {
    expect(classifyLibraryItem({ relativePath: 'Personal/skills/draft-note/SKILL.md' })).toBe('skill');
    expect(classifyLibraryItem({ relativePath: 'Chief-of-Staff/skills/triage/SKILL.md' })).toBe('skill');
    expect(classifyLibraryItem({ relativePath: 'work/Acme/Engineering/skills/research/SKILL.md' })).toBe(
      'skill',
    );
  });

  it('honors skillMeta even when path does not match canonical patterns', () => {
    expect(
      classifyLibraryItem({ relativePath: 'docs/notes/oddball.md', skillMeta: { id: 'x' } }),
    ).toBe('skill');
  });

  it('does NOT misclassify ordinary docs/skills folder as a skill', () => {
    expect(classifyLibraryItem({ relativePath: 'docs/skills/file.md' })).toBe('plain');
  });

  it('returns memory for memory paths in any space (case-insensitive)', () => {
    expect(classifyLibraryItem({ relativePath: 'work/Acme/memory/notes.md' })).toBe('memory');
    expect(classifyLibraryItem({ relativePath: 'Personal/Memory/note.md' })).toBe('memory');
    expect(classifyLibraryItem({ relativePath: 'memory/root.md' })).toBe('memory');
  });

  it('returns plain for non-skill and non-memory paths', () => {
    expect(classifyLibraryItem({ relativePath: 'docs/readme.md' })).toBe('plain');
    expect(classifyLibraryItem({ relativePath: 'Personal/journal/entry.md' })).toBe('plain');
  });

  it('returns plain for nullish or empty items', () => {
    expect(classifyLibraryItem(undefined)).toBe('plain');
    expect(classifyLibraryItem(null)).toBe('plain');
    expect(classifyLibraryItem({ relativePath: '' })).toBe('plain');
    expect(classifyLibraryItem({})).toBe('plain');
  });

  it('falls back through relativePath, fullPath, path in order', () => {
    expect(
      classifyLibraryItem({
        relativePath: 'memory/wins.md',
        fullPath: '/workspace/skills/should-not-win/SKILL.md',
        path: '/workspace/skills/also-no/SKILL.md',
      }),
    ).toBe('memory');
    expect(
      classifyLibraryItem({
        fullPath: 'rebel-system/skills/foo/SKILL.md',
        path: 'docs/note.md',
      }),
    ).toBe('skill');
  });
});
