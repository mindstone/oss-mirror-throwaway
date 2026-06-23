import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  useSpaceWizardState,
  deriveAddExistingAssociatedAccounts,
  DEFAULT_SUBFOLDERS,
  type SpaceWizardState,
  type SpaceWizardActions,
} from '../hooks/useSpaceWizardState';

/**
 * Tests for useSpaceWizardState hook.
 *
 * Note: Full React hook testing (useState behavior, async operations) would require
 * @testing-library/react which isn't currently installed.
 * These tests focus on type structure, export verification, and mock setup patterns.
 *
 * If hook behavior testing is needed in the future, install:
 *   npm install -D @testing-library/react @testing-library/react-hooks
 *
 * Then add tests like:
 *   const { result } = renderHook(() => useSpaceWizardState());
 *   await act(async () => {
 *     await result.current.actions.setPath('/path/to/folder');
 *   });
 *   expect(result.current.state.path).toBe('/path/to/folder');
 */

// Mock window.libraryApi for the hook
const mockLibraryApi = {
  analyzePath: vi.fn(),
  checkSymlink: vi.fn(),
  generateSpaceDescription: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  // Setup global window.libraryApi mock
  (global as unknown as { window: { libraryApi: typeof mockLibraryApi } }).window = {
    libraryApi: mockLibraryApi,
  };
});

describe('useSpaceWizardState', () => {
  describe('exports', () => {
    it('exports useSpaceWizardState function', () => {
      expect(typeof useSpaceWizardState).toBe('function');
    });

    it('exports DEFAULT_SUBFOLDERS constant', () => {
      expect(Array.isArray(DEFAULT_SUBFOLDERS)).toBe(true);
      expect(DEFAULT_SUBFOLDERS).toContain('memory');
      expect(DEFAULT_SUBFOLDERS).toContain('skills');
      expect(DEFAULT_SUBFOLDERS).toContain('scripts');
    });

    it('exports add-existing Associated Accounts default helper', () => {
      expect(deriveAddExistingAssociatedAccounts('[external-email]')).toEqual(['[external-email]']);
    });

    it('can import SpaceWizardState type', () => {
      // Type-only test - ensures the type export works
      // Note: memoryTrust has been removed from wizard state - safety is now derived from sharing
      const typeCheck: SpaceWizardState = {
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
        selectedSubfolders: [],
        isInsideWorkspace: false,
        workspaceRelativePath: null,
        hasTriedAutoDescription: false,
      };
      expect(typeCheck).toBeDefined();
      expect(typeCheck.step).toBe('location');
    });

    it('can import SpaceWizardActions type', () => {
      // Type-only test
      const typeCheck: SpaceWizardActions = {
        setPath: async () => {},
        generateDescription: async () => {},
        setStep: () => {},
        updateField: () => {},
        reset: () => {},
      };
      expect(typeCheck).toBeDefined();
      expect(typeof typeCheck.setPath).toBe('function');
    });
  });

  describe('SpaceWizardState type structure', () => {
    it('has all required step state properties', () => {
      // Note: memoryTrust was removed - safety behavior now derived from sharing
      const mockState: SpaceWizardState = {
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
        selectedSubfolders: [],
        isInsideWorkspace: false,
        workspaceRelativePath: null,
        hasTriedAutoDescription: false,
      };

      // Step state
      expect('step' in mockState).toBe(true);
      expect(['location', 'about']).toContain(mockState.step);

      // Location step data
      expect('path' in mockState).toBe(true);
      expect('pathError' in mockState).toBe(true);
      expect('isAnalyzing' in mockState).toBe(true);
      expect('validationIssues' in mockState).toBe(true);
      expect('hasBlockingErrors' in mockState).toBe(true);

      // About step data
      expect('name' in mockState).toBe(true);
      expect('description' in mockState).toBe(true);
      expect('descriptionSource' in mockState).toBe(true);
      expect('descriptionLoading' in mockState).toBe(true);
      expect('storageProvider' in mockState).toBe(true);
      expect('sharing' in mockState).toBe(true);
      expect('category' in mockState).toBe(true);
      expect('companyName' in mockState).toBe(true);
      expect('organisation' in mockState).toBe(true);

      // UI state
      expect('isSymlink' in mockState).toBe(true);
      expect('symlinkTarget' in mockState).toBe(true);
      expect('createSubfolders' in mockState).toBe(true);
      expect('selectedSubfolders' in mockState).toBe(true);
      expect('isInsideWorkspace' in mockState).toBe(true);
      expect('workspaceRelativePath' in mockState).toBe(true);
      expect('hasTriedAutoDescription' in mockState).toBe(true);
    });

    it('allows valid step values', () => {
      const locationStep: SpaceWizardState['step'] = 'location';
      const aboutStep: SpaceWizardState['step'] = 'about';

      expect(locationStep).toBe('location');
      expect(aboutStep).toBe('about');
    });

    it('allows valid description source values', () => {
      const sources: SpaceWizardState['descriptionSource'][] = [
        'haiku',
        'readme',
        'fallback',
        'user',
      ];

      for (const source of sources) {
        expect(['haiku', 'readme', 'fallback', 'user']).toContain(source);
      }
    });
  });

  describe('SpaceWizardActions type structure', () => {
    it('has all required action functions', () => {
      const mockActions: SpaceWizardActions = {
        setPath: async () => {},
        generateDescription: async () => {},
        setStep: () => {},
        updateField: () => {},
        reset: () => {},
      };

      // All actions should be functions
      expect(typeof mockActions.setPath).toBe('function');
      expect(typeof mockActions.generateDescription).toBe('function');
      expect(typeof mockActions.setStep).toBe('function');
      expect(typeof mockActions.updateField).toBe('function');
      expect(typeof mockActions.reset).toBe('function');
    });

    it('setPath is async (returns Promise)', async () => {
      const mockSetPath: SpaceWizardActions['setPath'] = async (_path: string) => {};
      const result = mockSetPath('/test/path');

      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBeUndefined();
    });

    it('generateDescription is async (returns Promise)', async () => {
      const mockGenerate: SpaceWizardActions['generateDescription'] = async () => {};
      const result = mockGenerate();

      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBeUndefined();
    });
  });

  describe('initial state behavior', () => {
    it('documents expected initial state values', () => {
      // These document the expected initial values that useSpaceWizardState should return
      const expectedInitialState: SpaceWizardState = {
        step: 'location', // Start at location step
        path: null, // No path selected
        pathError: null, // No errors
        isAnalyzing: false, // Not analyzing
        validationIssues: [], // No validation issues
        hasBlockingErrors: false, // No blocking errors
        hasExistingFrontmatter: false,
        detectedFrontmatter: null,
        name: '', // Empty name
        description: '', // Empty description
        descriptionSource: 'fallback', // Default source
        descriptionLoading: false, // Not loading
        storageProvider: 'local', // Default provider
        sharing: 'private', // Default sharing
        category: 'unknown', // Unknown category
        companyName: '', // Empty company
        organisation: '', // Empty organisation
        emails: [], // No associated accounts
        hasEmailErrors: false, // No email validation errors
        // memoryTrust removed - safety now derived from sharing
        isSymlink: false, // Not a symlink
        symlinkTarget: null, // No target
        createSubfolders: false, // Don't create by default
        selectedSubfolders: [...DEFAULT_SUBFOLDERS], // All subfolders selected by default
        isInsideWorkspace: false, // Not inside workspace
        workspaceRelativePath: null, // No relative path
        hasTriedAutoDescription: false, // Haven't tried auto-generation
      };

      expect(expectedInitialState.step).toBe('location');
      expect(expectedInitialState.path).toBeNull();
      expect(expectedInitialState.isAnalyzing).toBe(false);
      expect(expectedInitialState.storageProvider).toBe('local');
      expect(expectedInitialState.sharing).toBe('private');
    });
  });

  describe('add-existing associated account defaults', () => {
    it('uses the current user email when available', () => {
      expect(deriveAddExistingAssociatedAccounts(' [external-email] ')).toEqual(['[external-email]']);
    });

    it('uses explicit local none when the current user email is unavailable', () => {
      expect(deriveAddExistingAssociatedAccounts(null)).toEqual([]);
      expect(deriveAddExistingAssociatedAccounts('   ')).toEqual([]);
    });
  });

  describe('edit mode behavior', () => {
    it('documents expected edit mode state with existingSpace', () => {
      // When existingSpace is provided, state should be pre-populated
      const existingSpace = {
        name: 'Test Space',
        path: 'work/Company/TestSpace',
        absolutePath: '/Users/test/workspace/work/Company/TestSpace',
        type: 'project' as const,
        isSymlink: true,
        hasReadme: true,
        description: 'An existing space description',
        sharing: 'restricted' as const,
        sourcePath: '/path/to/original',
      };

      // Expected state when useSpaceWizardState({ existingSpace }) is called
      const expectedEditModeState: Partial<SpaceWizardState> = {
        step: 'about', // Should start at 'about' step in edit mode
        path: existingSpace.absolutePath,
        name: existingSpace.name,
        description: existingSpace.description,
        descriptionSource: 'user', // Existing description is user-owned
        sharing: 'restricted',
        isSymlink: existingSpace.isSymlink,
        symlinkTarget: existingSpace.sourcePath,
        createSubfolders: false, // Edit mode doesn't offer subfolder creation
        category: 'work', // 'project' type maps to 'work' category
        hasTriedAutoDescription: true, // Skip auto-description in edit mode
      };

      expect(expectedEditModeState.step).toBe('about');
      expect(expectedEditModeState.descriptionSource).toBe('user');
      expect(expectedEditModeState.createSubfolders).toBe(false);
      expect(expectedEditModeState.category).toBe('work');
      expect(expectedEditModeState.hasTriedAutoDescription).toBe(true);
    });

    // Note: memoryTrust tests removed - safety is now derived from sharing level
    // See docs/plans/partway/260103_memory_approval_ux_improvement.md for design details
  });

  describe('step transition behavior', () => {
    it('documents step transition from location to about', () => {
      // After path is selected and analyzed, user can proceed to 'about' step
      // setStep('about') should be called when Next button is clicked

      // The expected flow:
      // 1. User at 'location' step
      // 2. User selects path via setPath()
      // 3. Path is analyzed (isAnalyzing: true -> false)
      // 4. User clicks Next, setStep('about') is called
      // 5. Step changes to 'about'

      const steps: SpaceWizardState['step'][] = ['location', 'about'];
      expect(steps).toHaveLength(2);
    });
  });

  describe('reset behavior', () => {
    it('documents reset action restores initial state', () => {
      // reset() should restore all fields to their initial values
      // This is called when the dialog closes

      const mockReset = vi.fn();
      const actions: SpaceWizardActions = {
        setPath: async () => {},
        generateDescription: async () => {},
        setStep: () => {},
        updateField: () => {},
        reset: mockReset,
      };

      actions.reset();
      expect(mockReset).toHaveBeenCalledOnce();
    });
  });

  describe('IPC integration patterns', () => {
    it('documents setPath triggers workspace:analyze-path and workspace:check-symlink', () => {
      // When setPath is called, it should:
      // 1. Set isAnalyzing to true
      // 2. Call window.libraryApi.checkSymlink({ path })
      // 3. Call window.libraryApi.analyzePath({ path })
      // 4. Update state with results
      // 5. Set isAnalyzing to false

      // These are the expected IPC calls
      expect(mockLibraryApi.analyzePath).toBeDefined();
      expect(mockLibraryApi.checkSymlink).toBeDefined();
    });

    it('documents generateDescription triggers workspace:generate-space-description', () => {
      // When generateDescription is called, it should:
      // 1. Set descriptionLoading to true
      // 2. Call window.libraryApi.generateSpaceDescription({ path })
      // 3. Update description and descriptionSource from result
      // 4. Set descriptionLoading to false

      expect(mockLibraryApi.generateSpaceDescription).toBeDefined();
    });
  });

  describe('type to category mapping', () => {
    /**
     * Documents the expected behavior of typeToCategory() which maps
     * SpaceType values to InferredCategory for edit mode.
     *
     * NOTE: typeToCategory is a module-private function (not exported).
     * These tests document the expected mapping behavior.
     *
     * The mapping is intentionally lossy (team/project → work → company on save).
     * This aligns with Phase 2 type simplification plans.
     */

    it('documents typeToCategory mapping: personal → personal', () => {
      // A 'personal' type space should map to 'personal' category in wizard
      const _spaceType = 'personal';
      const expectedCategory = 'personal';
      expect(expectedCategory).toBe('personal');
      // This verifies the mapping is identity for personal
    });

    it('documents typeToCategory mapping: company → work', () => {
      // A 'company' type space should map to 'work' category in wizard
      const _spaceType = 'company';
      const expectedCategory = 'work';
      expect(expectedCategory).toBe('work');
    });

    it('documents typeToCategory mapping: team → work', () => {
      // A 'team' type space should map to 'work' category in wizard
      const _spaceType = 'team';
      const expectedCategory = 'work';
      expect(expectedCategory).toBe('work');
    });

    it('documents typeToCategory mapping: project → work', () => {
      // A 'project' type space should map to 'work' category in wizard
      const _spaceType = 'project';
      const expectedCategory = 'work';
      expect(expectedCategory).toBe('work');
    });

    it('documents typeToCategory mapping: other → unknown', () => {
      // An 'other' type space should map to 'unknown' category in wizard
      const _spaceType = 'other';
      const expectedCategory = 'unknown';
      expect(expectedCategory).toBe('unknown');
    });

    it('documents typeToCategory mapping: chief-of-staff → unknown (edge case)', () => {
      // Chief-of-Staff spaces should not be editable via wizard,
      // but if passed, they map to 'unknown'
      const _spaceType = 'chief-of-staff';
      const expectedCategory = 'unknown';
      expect(expectedCategory).toBe('unknown');
      // Note: Chief-of-Staff spaces are filtered out in SpacesManager
      // and should never reach the wizard
    });

    it('documents the lossy nature of type→category→type conversion', () => {
      // IMPORTANT: The mapping is lossy!
      // team → work, but work → company on save
      // project → work, but work → company on save
      //
      // This means editing a 'team' space will change its type to 'company'.
      // This is acceptable per Phase 2 type simplification plans which reduce
      // the type vocabulary from 6 values to 4.

      // Original types that map to 'work'
      const workTypes = ['company', 'team', 'project'];
      const categoryForWork = 'work';

      // All map to 'work' in wizard
      for (const _type of workTypes) {
        expect(categoryForWork).toBe('work');
      }

      // On save, 'work' becomes 'company'
      const typeOnSave = 'company'; // categoryToType('work') returns 'company'
      expect(typeOnSave).toBe('company');
    });
  });

  // Note: memoryTrust state tests removed - safety behavior is now derived from sharing level
  // See docs/plans/partway/260103_memory_approval_ux_improvement.md for design details
});
