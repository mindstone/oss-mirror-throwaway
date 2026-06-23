import { describe, expect, it, vi } from 'vitest';
import type { FlatLibraryEntry } from '../types';
import { useFlatLibraryIndex } from '../useFlatLibraryIndex';

const makeEntry = (name: string): FlatLibraryEntry => ({
  node: {
    kind: 'file',
    name,
    path: `/workspace/${name}`,
  },
  fullPath: name,
});

describe('useFlatLibraryIndex', () => {
  it('preserves the original filesRef object reference (including null current values)', () => {
    const filesRef: React.RefObject<FlatLibraryEntry[] | null> = { current: null };

    const result = useFlatLibraryIndex({
      files: null,
      filesRef,
      loading: true,
      error: null,
      hasLoaded: false,
      refresh: vi.fn(async () => {}),
    });

    expect(result.filesRef).toBe(filesRef);
    expect(result.filesRef.current).toBeNull();
    expect(result.files).toEqual([]);
  });

  it('passes through non-null files and filesRef values without casting', () => {
    const files = [makeEntry('chatgpt.png')];
    const filesRef: React.RefObject<FlatLibraryEntry[] | null> = { current: files };

    const result = useFlatLibraryIndex({
      files,
      filesRef,
      loading: false,
      error: null,
      hasLoaded: true,
      refresh: vi.fn(async () => {}),
    });

    expect(result.files).toBe(files);
    expect(result.filesRef).toBe(filesRef);
    expect(result.filesRef.current).toBe(files);
  });
});
