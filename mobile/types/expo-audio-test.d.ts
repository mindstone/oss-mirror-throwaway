// Test-only ambient augmentation for the manual expo-audio jest mock.
//
// `mobile/__mocks__/expo-audio.js` exposes two test-only helpers that the real
// `expo-audio` package does not declare. They let tests inspect/reset the last
// audio mode passed to setAudioModeAsync. This augmentation makes those exports
// visible to the test typecheck (mobile/tsconfig.test.json) WITHOUT shadowing the
// real module's types. It is kept out of the production typecheck because
// `mobile/tsconfig.json` excludes `types/**`, and it is pulled into the test
// typecheck explicitly via `mobile/tsconfig.test.json`'s `files`.
//
// The top-level `import` makes this file a module, so `declare module 'expo-audio'`
// MERGES with the real package's declaration (augmentation) rather than replacing
// it. Without the import, TS treats it as an ambient module declaration that
// shadows the real exports.
import 'expo-audio';

declare module 'expo-audio' {
  /** Returns the last params passed to setAudioModeAsync, or null if none/reset. */
  export const __getLastAudioMode: () => Record<string, unknown> | null;
  /** Clears the recorded last audio mode. */
  export const __resetLastAudioMode: () => void;
}
