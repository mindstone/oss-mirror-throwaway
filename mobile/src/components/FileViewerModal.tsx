import { Feather } from '@expo/vector-icons';
import Markdown, { MarkdownIt } from '@ronradtke/react-native-markdown-display';
import { isMarkdownPath } from '@rebel/shared';
import { memo, useMemo } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors, type ColorTokens } from '../theme/colors';
import { createMarkdownStyles } from '../theme/markdownStyles';
import { createTypography } from '../theme/typography';

const typography = createTypography(true);

// Widened markdown-it instance used for nested links inside a viewed markdown file.
// Matches the instance used in conversation/[id].tsx so non-http(s) schemes (library://,
// rebel://, file://) reach our link dispatcher instead of being filtered out by
// markdown-it's default scheme allowlist. Image parsing is neutralised via
// `defaultImageHandler={null}` on the <Markdown> component below.
const fileViewerMarkdownIt = MarkdownIt({ typographer: true });
fileViewerMarkdownIt.validateLink = () => true;

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    filename: {
      ...typography.bodySmall,
      fontWeight: '600',
      color: colors.textPrimary,
      flex: 1,
      marginRight: 12,
    },
    closeButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceHover,
    },
    scrollContent: {
      padding: 16,
      paddingBottom: 40,
    },
    centered: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 24,
    },
    errorIcon: {
      marginBottom: 12,
    },
    errorText: {
      ...typography.body,
      color: colors.error,
      textAlign: 'center',
    },
    monoText: {
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      fontSize: 13,
      lineHeight: 20,
      color: colors.textPrimary,
    },
    truncationNote: {
      ...typography.caption,
      color: colors.textTertiary,
      textAlign: 'center',
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the filename from a file path (last segment). */
function extractFilename(filePath: string): string {
  const segments = filePath.replace(/\\/g, '/').split('/');
  return segments[segments.length - 1] || filePath;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface FileViewerModalProps {
  visible: boolean;
  filePath: string | null;
  content: string | null;
  onClose: () => void;
  isLoading: boolean;
  error: string | null;
  truncated?: boolean;
  /**
   * Handler for links tapped inside a viewed markdown file. Same contract as
   * `@ronradtke/react-native-markdown-display`'s `onLinkPress`: return `true`
   * to let the component open the URL externally, `false` to suppress default
   * handling (we intercepted it). Callers should wire this to the same
   * `createMarkdownLinkHandler` dispatcher they use elsewhere. When omitted
   * nested links render as plain text (legacy behaviour).
   */
  onLinkPress?: (url: string) => boolean;
}

export const FileViewerModal = memo(function FileViewerModal({
  visible,
  filePath,
  content,
  onClose,
  isLoading,
  error,
  truncated,
  onLinkPress,
}: FileViewerModalProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const mdStyles = useMemo(() => createMarkdownStyles(colors), [colors]);
  const insets = useSafeAreaInsets();

  const filename = filePath ? extractFilename(filePath) : '';
  const isMarkdown = filePath ? isMarkdownPath(filePath) : false;

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
    >
      <View
        style={[s.backdrop, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
        accessibilityViewIsModal
        accessibilityLabel="File viewer"
      >
        {/* Header */}
        <View style={s.header}>
          <Text style={s.filename} numberOfLines={1} testID="file-viewer-filename">
            {filename}
          </Text>
          <TouchableOpacity
            testID="file-viewer-close"
            style={s.closeButton}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close file viewer"
          >
            <Feather name="x" size={18} color={colors.textPrimary} />
          </TouchableOpacity>
        </View>

        {/* Body */}
        {isLoading ? (
          <View style={s.centered} testID="file-viewer-loading">
            <ActivityIndicator size="large" color={colors.accent} />
          </View>
        ) : error ? (
          <View style={s.centered} testID="file-viewer-error">
            <Feather
              name="alert-circle"
              size={32}
              color={colors.error}
              style={s.errorIcon}
            />
            <Text style={s.errorText}>{error}</Text>
          </View>
        ) : content != null ? (
          <>
            <ScrollView
              testID="file-viewer-content"
              contentContainerStyle={s.scrollContent}
              keyboardDismissMode="interactive"
            >
              {isMarkdown ? (
                <Markdown
                  style={mdStyles}
                  markdownit={fileViewerMarkdownIt}
                  onLinkPress={onLinkPress}
                  defaultImageHandler={null}
                >{content}</Markdown>
              ) : (
                <Text style={s.monoText} testID="file-viewer-plain-text" selectable>
                  {content}
                </Text>
              )}
            </ScrollView>
            {truncated && (
              <Text style={s.truncationNote} testID="file-viewer-truncation-note">
                Showing first 100KB of file
              </Text>
            )}
          </>
        ) : null}
      </View>
    </Modal>
  );
});

FileViewerModal.displayName = 'FileViewerModal';
