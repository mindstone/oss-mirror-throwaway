/**
 * Spaces Feature
 *
 * Components and hooks for managing workspace spaces (memory, skills, projects).
 * This feature provides:
 * - AddSpaceWizard: A 2-step wizard dialog for adding new spaces
 * - useSpaceWizardState: State management hook for the wizard
 *
 * @example
 * import { AddSpaceWizard, useSpaceWizardState } from '@renderer/features/spaces';
 *
 * // Use the wizard
 * <AddSpaceWizard
 *   open={isOpen}
 *   onOpenChange={setIsOpen}
 *   onComplete={handleComplete}
 *   onCancel={handleCancel}
 * />
 */

// Components
export { AddSpaceWizard, type AddSpaceWizardProps } from './components/AddSpaceWizard';
export { AboutStep, type AboutStepProps } from './components/AboutStep';
export { LocationStep, type LocationStepProps } from './components/LocationStep';

// Hooks
export {
  useSpaceWizardState,
  DEFAULT_SUBFOLDERS,
  type SpaceWizardState,
  type SpaceWizardActions,
  type WizardStep,
  type WizardMode,
  type UseSpaceWizardStateOptions,
  type ExistingFrontmatter,
} from './hooks/useSpaceWizardState';
