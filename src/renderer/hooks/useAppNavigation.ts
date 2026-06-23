/**
 * useAppNavigation Hook
 *
 * Convenience re-export of the navigation hook for easier imports.
 * Part of the Unified Navigation System (see docs/plans/finished/251219_unified_navigation_system.md).
 *
 * @example
 * import { useAppNavigation } from '@renderer/hooks/useAppNavigation';
 *
 * function MyComponent() {
 *   const { navigate, currentSurface } = useAppNavigation();
 *
 *   // Navigate by target object
 *   navigate({ type: 'settings', tab: 'agents' });
 *
 *   // Navigate by URL string
 *   navigate('rebel://settings/agents#voiceAudio');
 * }
 */

export {
  useNavigation as useAppNavigation,
  useNavigationSafe as useAppNavigationSafe,
  type NavigationContextValue
} from '@renderer/contexts/NavigationContext';
