// Module augmentation for @ronradtke/react-native-markdown-display.
//
// The library's runtime explicitly checks `defaultImageHandler === null` to
// disable the URL prefix fallback (renderRules.js line 272), but its TypeScript
// declaration types the prop as `string`. This augmentation widens the type to
// match the documented runtime contract so consumers can pass `null` to disable
// image handling without an unsafe cast at every call site.
import '@ronradtke/react-native-markdown-display';

declare module '@ronradtke/react-native-markdown-display' {
  interface MarkdownProps {
    defaultImageHandler?: string | null;
  }
}
