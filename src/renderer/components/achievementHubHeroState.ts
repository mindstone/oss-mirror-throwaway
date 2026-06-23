/**
 * Pure selector for the Achievement Hub Overview hero "Time saved" state.
 *
 * Extracted as a standalone module so the four-state logic is unit-testable
 * without pulling in AchievementHub.tsx's full renderer surface (CSS imports,
 * Lucide icons, Dialog component, etc.). The hub renders one of four heros
 * based on the trust-sensitive distinctions called out in
 * docs-private/investigations/260520_time_saved_zero_or_missing.md:
 *
 *   - `weekly`: this week > 0 — normal "TIME SAVED THIS WEEK" hero.
 *   - `allTime`: this week is zero but all-time > 0 — show cumulative figure
 *     under "TIME SAVED SO FAR". Avoids the "0 min this week" reading as data
 *     loss for users with many prior tracked hours when current-week
 *     estimation has silently failed for every recent turn.
 *   - `empty`: no entries ever — first-run state. Never claim zero is a result.
 *   - `error`: aggregate fetch itself failed. Never render numeric zero on
 *     fetch error; the copy must communicate transient unavailability.
 *
 * Fetch failure always wins over numeric values to prevent showing
 * "Couldn't load right now" alongside a stale numeric.
 */

export type TimeSavedHeroState =
  | { kind: 'weekly'; minutes: number }
  | { kind: 'allTime'; minutes: number }
  | { kind: 'empty' }
  | { kind: 'error' };

export const selectTimeSavedHeroState = (
  weekMinutes: number,
  allTimeMinutes: number,
  fetchError: boolean,
): TimeSavedHeroState => {
  if (fetchError) return { kind: 'error' };
  if (weekMinutes > 0) return { kind: 'weekly', minutes: weekMinutes };
  if (allTimeMinutes > 0) return { kind: 'allTime', minutes: allTimeMinutes };
  return { kind: 'empty' };
};
