/**
 * useSpaceWizardState - State management hook for AddSpaceWizard
 *
 * Manages wizard step state, form data, async operations (path analysis, description generation),
 * and provides actions for step navigation and field updates.
 */

import { useCallback, useState, useMemo } from 'react';
import { suggestOrganisationFromPath } from '@core/services/spaceOrganisationHeuristics';
import { fetchSpaces, getSpacesSnapshotFor } from '@renderer/hooks/useSpacesData';
import type {
  SpaceStorageProvider,
  SpaceSharingLevel,
  InferredCategory,
  DescriptionSource,
  PathValidationIssue,
  ExistingFrontmatter,
} from '@shared/ipc/schemas/library';
import type { SpaceInfo } from '@shared/ipc/schemas/library';

// Re-export ExistingFrontmatter for external use
export type { ExistingFrontmatter };

// Default subfolders to create when adding a space
export const DEFAULT_SUBFOLDERS = ['memory', 'skills', 'scripts'];

export type WizardStep = 'location' | 'about';

const normalizePathForComparison = (value: string): string =>
  value.replace(/\\/g, '/').replace(/\/+$/, '');

const getParentPath = (value: string | null | undefined): string | undefined => {
  if (!value) return undefined;
  const normalized = normalizePathForComparison(value);
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return undefined;
  return normalized.slice(0, lastSlash);
};

const findSiblingOrganisation = (
  spaces: SpaceInfo[],
  selectedParentPath: string | undefined
): string | undefined => {
  if (!selectedParentPath) return undefined;
  const normalizedSelectedParent = normalizePathForComparison(selectedParentPath);

  for (const space of spaces) {
    const organisationName = space.organisationName?.trim();
    if (!organisationName) continue;

    const candidateParents = [
      getParentPath(space.path),
      getParentPath(space.absolutePath),
      getParentPath(space.sourcePath),
    ];
    if (candidateParents.some(parent => parent && normalizePathForComparison(parent) === normalizedSelectedParent)) {
      return organisationName;
    }
  }

  return undefined;
};

const getCoreDirectoryForWizard = async (): Promise<string | null> => {
  try {
    const settings = await window.settingsApi?.get?.();
    return settings?.coreDirectory?.trim() || null;
  } catch {
    return null;
  }
};

const getSpacesForWizard = async (): Promise<SpaceInfo[]> => {
  const coreDirectory = await getCoreDirectoryForWizard();
  if (!coreDirectory) return [];

  await fetchSpaces(coreDirectory, { force: true });
  const snapshot = getSpacesSnapshotFor(coreDirectory);
  return snapshot.ready && !snapshot.error ? snapshot.spaces : [];
};

/**
 * Reverse-map a SpaceType to InferredCategory for edit mode.
 * Note: This is lossy - team/project become 'work', and on save will become 'company'.
 * This aligns with Phase 2 type simplification plans.
 */
const typeToCategory = (type: string): InferredCategory => {
  if (type === 'personal') return 'personal';
  if (['company', 'team', 'project'].includes(type)) return 'work';
  return 'unknown';
};

const normalizeDefaultUserEmail = (email: string | null | undefined): string | undefined => {
  const trimmed = email?.trim();
  return trimmed ? trimmed : undefined;
};

export const deriveAddExistingAssociatedAccounts = (
  defaultUserEmail: string | null | undefined
): string[] => {
  const normalized = normalizeDefaultUserEmail(defaultUserEmail);
  return normalized ? [normalized] : [];
};

/**
 * Detect storage provider from a path string (client-side).
 * Mirrors the logic in workspaceHandlers.ts detectStorageProvider().
 */
const detectStorageProviderFromPath = (pathStr: string): SpaceStorageProvider => {
  const normalized = pathStr.replace(/\\/g, '/');

  // Google Drive patterns
  // macOS: /Library/CloudStorage/GoogleDrive-*/ or /Google Drive/
  // Windows: /Google Drive/ or \Google Drive\
  if (
    /\/Library\/CloudStorage\/GoogleDrive-[^/]+(\/|$)/.test(normalized) ||
    /\/Google Drive(\/|$)/i.test(normalized)
  ) {
    return 'google_drive';
  }

  // iCloud patterns
  // macOS: /Library/Mobile Documents/com~apple~CloudDocs/
  // Windows: /iCloudDrive/ or \iCloudDrive\
  if (
    /\/Library\/Mobile Documents\/com~apple~CloudDocs(\/|$)/.test(normalized) ||
    /\/iCloud Drive(\/|$)/i.test(normalized) ||
    /\/iCloudDrive(\/|$)/i.test(normalized)
  ) {
    return 'icloud';
  }

  // OneDrive patterns
  if (/\/OneDrive[^/]*(\/|$)/i.test(normalized)) {
    return 'onedrive';
  }

  // Dropbox patterns
  if (/\/Dropbox(\/|$)/i.test(normalized)) {
    return 'dropbox';
  }

  // Box patterns (includes "Box Sync" variant)
  if (/\/Box( Sync)?(\/|$)/i.test(normalized)) {
    return 'box';
  }

  return 'local';
};

/** @deprecated Memory trust level for spaces - no longer used in wizard. */
export type SpaceMemoryTrust = 'always_ask' | 'balanced' | 'always_write' | undefined;

export interface SpaceWizardState {
  // Step state
  step: WizardStep;

  // Location step data
  path: string | null;
  pathError: string | null;
  isAnalyzing: boolean;
  /** Structured validation issues from path analysis */
  validationIssues: PathValidationIssue[];
  /** True if any error-severity validation issues exist */
  hasBlockingErrors: boolean;
  
  // Frontmatter detection (for add-existing mode)
  /** True if the path has README.md with rebel_space_description frontmatter */
  hasExistingFrontmatter: boolean;
  /** Frontmatter extracted from existing README.md, if detected */
  detectedFrontmatter: ExistingFrontmatter | null;

  // About step data (populated after path analysis)
  name: string;
  description: string;
  descriptionSource: DescriptionSource | 'user';
  descriptionLoading: boolean;
  storageProvider: SpaceStorageProvider;
  sharing: SpaceSharingLevel;
  category: InferredCategory;
  companyName: string;
  /** Human-owned organisation grouping label for this Space */
  organisation: string;
  /** Associated email accounts for this Space */
  emails: string[];
  /** Whether the emails field has validation errors */
  hasEmailErrors: boolean;

  // UI state
  isSymlink: boolean;
  symlinkTarget: string | null;
  createSubfolders: boolean;
  selectedSubfolders: string[];

  // Path location state (determines if symlink is needed)
  isInsideWorkspace: boolean;
  /** For internal paths, the relative path from coreDirectory */
  workspaceRelativePath: string | null;

  // Auto-generation control (prevents re-generation when user clears field)
  hasTriedAutoDescription: boolean;
}

export interface SpaceWizardActions {
  /** Set the selected path and trigger path analysis */
  setPath: (path: string) => Promise<void>;
  /** Generate AI-powered description for the selected path */
  generateDescription: () => Promise<void>;
  /** Navigate to a specific step */
  setStep: (step: WizardStep) => void;
  /** Update a single field */
  updateField: <K extends keyof SpaceWizardState>(field: K, value: SpaceWizardState[K]) => void;
  /** Reset state to initial values */
  reset: () => void;
}

const initialState: SpaceWizardState = {
  step: 'location',
  path: null,
  pathError: null,
  isAnalyzing: false,
  validationIssues: [],
  hasBlockingErrors: false,
  hasExistingFrontmatter: false,
  detectedFrontmatter: null,
  name: '',
  description: '',
  descriptionSource: 'fallback',
  descriptionLoading: false,
  storageProvider: 'local',
  sharing: 'private',
  category: 'unknown',
  companyName: '',
  organisation: '',
  emails: [],
  hasEmailErrors: false,
  isSymlink: false,
  symlinkTarget: null,
  createSubfolders: false,
  selectedSubfolders: [...DEFAULT_SUBFOLDERS],
  isInsideWorkspace: false,
  workspaceRelativePath: null,
  hasTriedAutoDescription: false,
};

/** Wizard mode types */
export type WizardMode = 'create' | 'edit' | 'add-existing';

export interface UseSpaceWizardStateOptions {
  /** Existing space for edit mode - if provided, starts at 'about' step */
  existingSpace?: SpaceInfo;
  /** Wizard mode - defaults to 'create' */
  mode?: WizardMode;
  /** Current user's email, used as the local associated-account default for add-existing flows */
  defaultUserEmail?: string | null;
}

/**
 * Hook for managing AddSpaceWizard state and actions.
 *
 * @example
 * const { state, actions } = useSpaceWizardState();
 *
 * // Select a path
 * await actions.setPath('/path/to/folder');
 *
 * // Generate description
 * await actions.generateDescription();
 *
 * // Update a field
 * actions.updateField('name', 'My Space');
 *
 * // Navigate between steps
 * actions.setStep('about');
 */
export const useSpaceWizardState = (
  options?: UseSpaceWizardStateOptions
): { state: SpaceWizardState; actions: SpaceWizardActions; effectiveMode: WizardMode } => {
  // Extract mode from options, defaulting to 'create'
  const mode: WizardMode = options?.mode ?? 'create';

  // Initialize state - for edit mode, pre-populate from existing space
  const [state, setState] = useState<SpaceWizardState>(() => {
    if (options?.existingSpace) {
      const space = options.existingSpace;
      const associatedAccounts = mode === 'add-existing'
        ? deriveAddExistingAssociatedAccounts(options.defaultUserEmail)
        : space.associatedAccounts ?? space.emails ?? [];
      // For symlinks, derive storageProvider from sourcePath (the actual location)
      // For non-symlinks, derive from absolutePath
      const pathForStorageDetection = space.isSymlink && space.sourcePath
        ? space.sourcePath
        : space.absolutePath;
      return {
        ...initialState,
        step: 'about', // Edit mode starts at about step
        path: space.absolutePath,
        name: space.name,
        description: space.description ?? '',
        descriptionSource: 'user', // Existing description is user-owned
        sharing: (space.sharing as SpaceSharingLevel) ?? 'private',
        isSymlink: space.isSymlink,
        symlinkTarget: space.sourcePath ?? null,
        // Reverse-map type to category for wizard display
        category: typeToCategory(space.type),
        organisation: space.organisationName ?? '',
        // Derive storageProvider from the appropriate path
        storageProvider: detectStorageProviderFromPath(pathForStorageDetection),
        // Edit mode doesn't offer subfolder creation
        createSubfolders: false,
        // Skip auto-description in edit mode
        hasTriedAutoDescription: true,
        emails: associatedAccounts,
      };
    }
    return initialState;
  });

  /**
   * Set the selected path and trigger path analysis.
   * This calls workspace:analyze-path and workspace:check-symlink IPC channels.
   */
  const setPath = useCallback(async (path: string) => {
    const startTime = import.meta.env.DEV ? performance.now() : 0;
    if (import.meta.env.DEV) {
      console.warn('[SpaceWizard] Starting path analysis for:', path);
    }
    
    setState((prev) => ({
      ...prev,
      path,
      pathError: null,
      isAnalyzing: true,
      validationIssues: [],
      hasBlockingErrors: false,
      hasExistingFrontmatter: false,
      detectedFrontmatter: null,
    }));

    try {
      // Check if path is a symlink
      const symlinkStart = import.meta.env.DEV ? performance.now() : 0;
      const symlinkResult = await window.libraryApi.checkSymlink({ path });
      if (import.meta.env.DEV) {
        console.warn('[SpaceWizard] checkSymlink took:', (performance.now() - symlinkStart).toFixed(0), 'ms');
      }

      // Analyze path for storage provider, sharing, and category
      const analyzeStart = import.meta.env.DEV ? performance.now() : 0;
      const analysisResult = await window.libraryApi.analyzePath({ path });
      if (import.meta.env.DEV) {
        console.warn('[SpaceWizard] analyzePath took:', (performance.now() - analyzeStart).toFixed(0), 'ms');
      }

      // Extract folder name for default space name (handle Windows backslashes)
      const normalizedPath = path.replace(/\\/g, '/');
      const folderName = normalizedPath.split('/').filter(Boolean).pop() ?? 'Untitled';

      // Check for blocking errors in validation issues
      // When frontmatter is detected, filter out 'is_existing_space' from blocking errors
      // since add-existing mode is allowed for these folders
      const issues = analysisResult.validationIssues ?? [];
      const hasDetectedFrontmatter = analysisResult.hasExistingFrontmatter ?? false;
      const hasBlockingErrors = issues.some(
        (issue) =>
          issue.severity === 'error' &&
          // Don't treat 'is_existing_space' as blocking when frontmatter was detected
          !(hasDetectedFrontmatter && issue.type === 'is_existing_space')
      );

      // External folders (outside workspace) need to be symlinked
      const isInsideWorkspace = analysisResult.isInsideWorkspace ?? false;
      const workspaceRelativePath = analysisResult.workspaceRelativePath ?? null;

      // Extract frontmatter data if detected
      const detectedFrontmatter = analysisResult.existingFrontmatter ?? null;

      // Determine form values - use detected frontmatter or inferred values
      const sharing = detectedFrontmatter?.sharing ?? analysisResult.inferredSharing;
      const category: InferredCategory = detectedFrontmatter?.space_type
        ? typeToCategory(detectedFrontmatter.space_type)
        : analysisResult.inferredCategory;
      const description = detectedFrontmatter?.description ?? '';
      const emails = hasDetectedFrontmatter
        ? deriveAddExistingAssociatedAccounts(options?.defaultUserEmail)
        : [];
      const selectedParentPath = getParentPath(workspaceRelativePath) ?? getParentPath(path);
      const existingSpaces = await getSpacesForWizard();
      const siblingOrganisation = findSiblingOrganisation(existingSpaces, selectedParentPath);
      const pathSuggestion = selectedParentPath ? suggestOrganisationFromPath(selectedParentPath) : undefined;
      const organisation = detectedFrontmatter?.organisation_name ?? siblingOrganisation ?? pathSuggestion ?? '';

      setState((prev) => ({
        ...prev,
        isAnalyzing: false,
        name: folderName,
        storageProvider: analysisResult.storageProvider,
        sharing,
        category,
        description,
        emails,
        organisation,
        // For detected frontmatter, description source is 'readme' (shared team data)
        descriptionSource: hasDetectedFrontmatter ? 'readme' : prev.descriptionSource,
        isSymlink: symlinkResult.isSymlink,
        symlinkTarget: symlinkResult.target ?? null,
        isInsideWorkspace,
        workspaceRelativePath,
        // Default: create subfolders for spaces (memory, skills, scripts are needed for spaces to work)
        // Only skip if folder already has frontmatter (add-existing mode - folder is already configured)
        createSubfolders: !hasDetectedFrontmatter,
        validationIssues: issues,
        hasBlockingErrors,
        hasExistingFrontmatter: hasDetectedFrontmatter,
        detectedFrontmatter,
        pathError: analysisResult.error
          ? analysisResult.error === 'permission_denied'
            ? 'Permission denied - cannot access this folder'
            : analysisResult.error === 'not_found'
              ? 'Folder not found'
              : 'Error analyzing folder'
          : null,
      }));
      if (import.meta.env.DEV) {
        console.warn('[SpaceWizard] Total path analysis took:', (performance.now() - startTime).toFixed(0), 'ms');
      }
    } catch (error) {
      setState((prev) => ({
        ...prev,
        isAnalyzing: false,
        pathError: error instanceof Error ? error.message : 'Failed to analyze path',
        validationIssues: [],
        hasBlockingErrors: false,
        hasExistingFrontmatter: false,
        detectedFrontmatter: null,
      }));
    }
  }, [options?.defaultUserEmail]);

  /**
   * Generate AI-powered description for the selected path.
   * Calls workspace:generate-space-description IPC channel.
   */
  const generateDescription = useCallback(async () => {
    if (!state.path) return;

    const startTime = import.meta.env.DEV ? performance.now() : 0;
    if (import.meta.env.DEV) {
      console.warn('[SpaceWizard] Starting description generation for:', state.path);
    }
    
    setState((prev) => ({
      ...prev,
      descriptionLoading: true,
      hasTriedAutoDescription: true, // Prevent auto re-generation
    }));

    try {
      const result = await window.libraryApi.generateSpaceDescription({ path: state.path });
      if (import.meta.env.DEV) {
        console.warn('[SpaceWizard] Description generation took:', (performance.now() - startTime).toFixed(0), 'ms');
      }

      setState((prev) => ({
        ...prev,
        descriptionLoading: false,
        description: result.description,
        descriptionSource: result.source,
      }));
    } catch {
      // On error, use folder name as fallback
      setState((prev) => ({
        ...prev,
        descriptionLoading: false,
        description: prev.name || 'Space',
        descriptionSource: 'fallback',
      }));
    }
  }, [state.path]);

  /**
   * Navigate to a specific step.
   */
  const setStep = useCallback((step: WizardStep) => {
    setState((prev) => ({
      ...prev,
      step,
    }));
  }, []);

  /**
   * Update a single field.
   * When description is manually edited, sets descriptionSource to 'user'.
   */
  const updateField = useCallback(
    <K extends keyof SpaceWizardState>(field: K, value: SpaceWizardState[K]) => {
      setState((prev) => ({
        ...prev,
        [field]: value,
        // Mark description as user-edited when manually changed
        ...(field === 'description' ? { descriptionSource: 'user' as const } : {}),
      }));
    },
    []
  );

  /**
   * Reset state to initial values.
   */
  const reset = useCallback(() => {
    setState(initialState);
  }, []);

  /**
   * Derive effective mode based on frontmatter detection.
   * When frontmatter is detected in 'create' mode, switch to 'add-existing' mode.
   * This centralizes the mode switching logic for external callers.
   */
  const effectiveMode: WizardMode = useMemo(() => {
    // If frontmatter is detected, always use 'add-existing' mode
    // (unless already in 'edit' mode, which takes precedence)
    if (mode === 'edit') return 'edit';
    if (state.hasExistingFrontmatter) return 'add-existing';
    return mode;
  }, [mode, state.hasExistingFrontmatter]);

  return {
    state,
    actions: {
      setPath,
      generateDescription,
      setStep,
      updateField,
      reset,
    },
    effectiveMode,
  };
};
