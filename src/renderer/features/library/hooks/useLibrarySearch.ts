import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FlatFileEntry, SearchResult } from '@renderer/utils/librarySearch';
import { searchLibrary, type LibrarySearchOutcome } from '@renderer/features/library/search/engine';
import { useSearchWithNavigation } from '@renderer/hooks/useSearchWithNavigation';
import type { EmitLogFn } from '@renderer/contexts';
import { isHiddenSkillMd, isMemoryPath, isSkillEntry } from '@renderer/utils/skillUtils';

type UseLibrarySearchOptions = {
  files: FlatFileEntry[];
  emitLog: EmitLogFn;
  onSelect: (result: SearchResult) => void;
};

const SHELF_RESULTS_LIMIT = 30;

export type LibrarySearchSections = {
  skills: SearchResult[];
  spaces: SearchResult[];
  files: SearchResult[];
};

type SectionKey = keyof LibrarySearchSections;
type SectionSearchOutcome = {
  results: SearchResult[];
  truncated: boolean;
  failed: boolean;
  outcome: LibrarySearchOutcome | null;
};

const EMPTY_SECTIONS: LibrarySearchSections = {
  skills: [],
  spaces: [],
  files: [],
};

const dedupeByPath = (results: SearchResult[]): SearchResult[] => {
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const result of results) {
    if (seen.has(result.node.path)) {
      continue;
    }
    seen.add(result.node.path);
    deduped.push(result);
  }
  return deduped;
};

/**
 * Fast filename/path search for Library navigation.
 * Uses Fuse over the flattened file tree for in-drawer selection (not content/semantic search).
 */
export const useLibrarySearch = ({ files, emitLog, onSelect }: UseLibrarySearchOptions) => {
  const [sections, setSections] = useState<LibrarySearchSections>(EMPTY_SECTIONS);
  const [truncated, setTruncated] = useState(false);
  const [searchOutcome, setSearchOutcome] = useState<LibrarySearchOutcome | null>(null);

  const skillEntries = useMemo(
    () => files.filter((entry) => !isHiddenSkillMd(entry) && isSkillEntry(entry)),
    [files],
  );
  const spaceEntries = useMemo(
    () => files.filter(
      (entry) => entry.node.kind === 'directory' && !isSkillEntry(entry) && !isMemoryPath(entry.fullPath),
    ),
    [files],
  );
  const fileEntries = useMemo(
    () => files.filter(
      (entry) => entry.node.kind === 'file' && !isHiddenSkillMd(entry) && !isSkillEntry(entry) && !isMemoryPath(entry.fullPath),
    ),
    [files],
  );

  const searchFn = useCallback(
    (query: string): SearchResult[] => {
      if (files.length === 0) {
        setSections(EMPTY_SECTIONS);
        setTruncated(false);
        setSearchOutcome(null);
        return [];
      }

      const runSectionSearch = (
        section: SectionKey,
        entries: FlatFileEntry[],
      ): SectionSearchOutcome => {
        try {
          const outcome = searchLibrary(query, entries, {
            limit: SHELF_RESULTS_LIMIT,
            surface: 'shelf',
          });
          return {
            results: outcome.results,
            truncated: outcome.truncated,
            failed: false,
            outcome,
          };
        } catch (error) {
          emitLog({
            level: 'error',
            message: 'Library search section failed',
            context: {
              section,
              error: error instanceof Error ? error.message : String(error),
            },
            timestamp: Date.now(),
          });
          return {
            results: [],
            truncated: false,
            failed: true,
            outcome: null,
          };
        }
      };

      const skillsOutcome = runSectionSearch('skills', skillEntries);
      const spacesOutcome = runSectionSearch('spaces', spaceEntries);
      const filesOutcome = runSectionSearch('files', fileEntries);

      const nextSections: LibrarySearchSections = {
        skills: skillsOutcome.results,
        spaces: spacesOutcome.results,
        files: filesOutcome.results,
      };
      const searchResults = dedupeByPath([
        ...nextSections.skills,
        ...nextSections.spaces,
        ...nextSections.files,
      ]);
      const wasTruncated = [skillsOutcome, spacesOutcome, filesOutcome]
        .some((outcome) => !outcome.failed && outcome.truncated);
      const truncatedOutcomes = [skillsOutcome, spacesOutcome, filesOutcome]
        .filter((outcome): outcome is SectionSearchOutcome & { outcome: LibrarySearchOutcome } => (
          !outcome.failed && outcome.truncated && outcome.outcome !== null
        ))
        .map((outcome) => outcome.outcome);
      const representativeOutcome = truncatedOutcomes.length > 0
        ? truncatedOutcomes.reduce((current, candidate) => (
          candidate.entriesTotal > current.entriesTotal ? candidate : current
        ))
        : null;
      const failedSections = [
        skillsOutcome.failed ? 'skills' : null,
        spacesOutcome.failed ? 'spaces' : null,
        filesOutcome.failed ? 'files' : null,
      ].filter((section): section is SectionKey => section !== null);
      setSections(nextSections);
      setTruncated(wasTruncated);
      setSearchOutcome(representativeOutcome);

      emitLog({
        level: 'debug',
        message: 'Library search performed',
        context: {
          query,
          resultCount: searchResults.length,
          skillsResultCount: nextSections.skills.length,
          spacesResultCount: nextSections.spaces.length,
          filesResultCount: nextSections.files.length,
          truncated: wasTruncated,
          failedSections,
        },
        timestamp: Date.now()
      });
      return searchResults;
    },
    [emitLog, fileEntries, files.length, skillEntries, spaceEntries]
  );

  const navigation = useSearchWithNavigation<SearchResult>({
    searchFn,
    onSelect,
    debounceMs: 50,
  });

  useEffect(() => {
    if (navigation.query.trim()) {
      return;
    }
    setSections(EMPTY_SECTIONS);
    setTruncated(false);
    setSearchOutcome(null);
  }, [navigation.query]);

  return {
    ...navigation,
    sections,
    truncated,
    searchOutcome,
  };
};
