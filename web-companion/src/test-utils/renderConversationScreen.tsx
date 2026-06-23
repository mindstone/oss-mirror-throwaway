import { type ReactNode } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from 'react-router-dom';

import { ConversationScreen } from '../screens/ConversationScreen';
import { fireAndForget } from '../utils/fireAndForget';

/**
 * Test helper for mounting `ConversationScreen` inside a MemoryRouter with a
 * configurable initial route. Exposes both a location probe (for asserting
 * the current URL after programmatic anchor-click routing) and a captured
 * `navigate` function (so tests can drive same-router navigation without
 * having to rerender with a fresh `<MemoryRouter>` — which would unmount the
 * screen and therefore miss the route-sync effect re-run we're trying to
 * assert on).
 *
 * Keep this thin. Every new screen test should either use this helper
 * unchanged or copy it and tweak rather than generalise upstream — premature
 * abstraction here costs more than it saves.
 */

export interface RenderConversationScreenResult extends RenderResult {
  /** Latest pathname observed after any programmatic navigation. */
  getCurrentPath: () => string;
  /** Latest search string observed (includes leading '?'). */
  getCurrentSearch: () => string;
  /** Navigate within the same MemoryRouter (preserves the screen mount). */
  navigateTo: (to: string) => void;
}

export function renderConversationScreen(initialEntry: string): RenderConversationScreenResult {
  let currentPath = initialEntry;
  let currentSearch = '';
  let navigateRef: NavigateFunction | null = null;

  function LocationProbe(): ReactNode {
    const location = useLocation();
    const navigate = useNavigate();
    navigateRef = navigate;
    currentPath = location.pathname;
    currentSearch = location.search;
    return null;
  }

  const result = render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <Routes>
        <Route path="/conversations/:id" element={<ConversationScreen />} />
        <Route path="*" element={<div data-testid="route-elsewhere" />} />
      </Routes>
    </MemoryRouter>,
  );

  return {
    ...result,
    getCurrentPath: () => currentPath,
    getCurrentSearch: () => currentSearch,
    navigateTo: (to: string) => {
      if (!navigateRef) {
        throw new Error('navigateTo called before LocationProbe captured useNavigate');
      }
      fireAndForget(navigateRef(to), 'test-utils:renderConversationScreen:navigate');
    },
  };
}
