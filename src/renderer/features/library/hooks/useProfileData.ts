import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  parseProfileSections,
  serialiseProfileSections,
  type ParsedProfile,
  type ProfileSection,
} from '../utils/profileSections';
import { writeFileOrFail } from '@renderer/utils/libraryWrites';
import { calculateProfileCompletionFromSections } from '../utils/profileCompletion';

const AUTO_SAVE_DELAY = 500;

export interface UseProfileDataReturn {
  profile: ParsedProfile | null;
  isLoading: boolean;
  /** Update a section by its array index (unambiguous even with duplicates). */
  updateSectionAt: (index: number, body: string) => void;
  /** Add a new section at the end. */
  addSection: (id: string, heading: string, body: string) => void;
  /** Get body content for the first section matching a known ID. */
  getSectionBody: (sectionId: string) => string;
  completionPercent: number;
  isDirty: boolean;
  save: () => Promise<void>;
}

/**
 * Hook that wraps the full read → parse → edit → serialise → write cycle
 * for the Chief-of-Staff profile README.md.
 *
 * Key invariant: never writes to disk on initial load (dirty flag).
 */
export function useProfileData(filePath: string | null): UseProfileDataReturn {
  const [profile, setProfile] = useState<ParsedProfile | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;

  const profileRef = useRef(profile);
  profileRef.current = profile;

  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -------------------------------------------------------------------------
  // Load
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!filePath) {
      setProfile(null);
      setIsLoading(false);
      setIsDirty(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setIsDirty(false);

    window.libraryApi
      .readFile(filePath)
      .then((result) => {
        if (cancelled) return;
        setProfile(parseProfileSections(result.content));
        setIsLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setProfile(null);
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // -------------------------------------------------------------------------
  // Persist helper (serialise current profile → writeFile)
  // -------------------------------------------------------------------------
  const persist = useCallback(async () => {
    const path = filePathRef.current;
    const current = profileRef.current;
    if (!path || !current) return;

    try {
      const content = serialiseProfileSections(current);
      const result = await writeFileOrFail({ path, content });
      if (result.result === 'conflict') {
        throw new Error('Save failed: file changed externally.');
      }
      setIsDirty(false);
    } catch (err) {
      console.warn('[ProfileData] Auto-save failed:', err);
    }
  }, []);

  // -------------------------------------------------------------------------
  // Auto-save: debounced write after edits
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!isDirty) return;

    saveTimerRef.current = setTimeout(() => {
      void persist();
    }, AUTO_SAVE_DELAY);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [isDirty, profile, persist]);

  // Flush on unmount if dirty
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (isDirtyRef.current && filePathRef.current && profileRef.current) {
        const content = serialiseProfileSections(profileRef.current);
        void writeFileOrFail({ path: filePathRef.current, content })
          .then((result) => {
            if (result.result === 'conflict') {
              throw new Error('Save failed: file changed externally.');
            }
          })
          // Unmount flush is best-effort: the component is gone, so there is
          // no safe UI surface to update. Keep the explicit catch so write
          // failures are intentionally detached rather than accidental.
          .catch(() => {});
      }
    };
  }, []);

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------
  const updateSectionAt = useCallback((index: number, body: string) => {
    setProfile((prev) => {
      if (!prev || index < 0 || index >= prev.sections.length) return prev;

      const updated: ProfileSection = { ...prev.sections[index], body };
      const sections = [...prev.sections];
      sections[index] = updated;
      return { ...prev, sections };
    });
    setIsDirty(true);
  }, []);

  const addSection = useCallback((id: string, heading: string, body: string) => {
    setProfile((prev) => {
      if (!prev) {
        return {
          frontmatter: '',
          preamble: '',
          sections: [{ id, heading, body, isKnown: true }],
          hasStructuredSections: true,
        };
      }
      const sections: ProfileSection[] = [
        ...prev.sections,
        { id, heading, body, isKnown: true },
      ];
      return { ...prev, sections, hasStructuredSections: true };
    });
    setIsDirty(true);
  }, []);

  // -------------------------------------------------------------------------
  // Readers
  // -------------------------------------------------------------------------
  const getSectionBody = useCallback(
    (sectionId: string): string => {
      if (!profile) return '';
      const section = profile.sections.find((s) => s.id === sectionId);
      return section?.body ?? '';
    },
    [profile],
  );

  const completionPercent = useMemo(() => {
    if (!profile && !isLoading && filePath) return 0;
    if (!profile) return 0;
    return calculateProfileCompletionFromSections(profile);
  }, [profile, isLoading, filePath]);

  // -------------------------------------------------------------------------
  // Manual save
  // -------------------------------------------------------------------------
  const save = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await persist();
  }, [persist]);

  return {
    profile,
    isLoading,
    updateSectionAt,
    addSection,
    getSectionBody,
    completionPercent,
    isDirty,
    save,
  };
}
