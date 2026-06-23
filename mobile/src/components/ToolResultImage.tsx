import { Feather } from '@expo/vector-icons';
import {
  CloudClientError,
  isConfigured as isCloudClientConfigured,
  mapImageRef,
  type ImageContentBlock,
  type ImageRef,
} from '@rebel/cloud-client';
import { memo, useCallback, useMemo, useState } from 'react';
import {
  Image,
  type ImageLoadEventData,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors, type ColorTokens } from '../theme/colors';
import { createTypography } from '../theme/typography';

const typography = createTypography(true);

const THUMBNAIL_MAX_WIDTH = 200;
const THUMBNAIL_MIN_WIDTH = 120;
const THUMBNAIL_HORIZONTAL_PADDING = 48;
const FALLBACK_ASPECT_RATIO = 1;

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    thumbnailButton: {
      borderRadius: 12,
      overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surfaceHover,
    },
    thumbnailImage: {
      width: '100%',
    },
    fallback: {
      minHeight: 120,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 16,
    },
    fallbackText: {
      ...typography.caption,
      color: colors.textSecondary,
      textAlign: 'center',
    },
    modalBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.9)',
    },
    modalContent: {
      flex: 1,
      width: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 16,
    },
    expandedImage: {
      flex: 1,
      width: '100%',
    },
    closeButton: {
      position: 'absolute',
      right: 16,
      width: 36,
      height: 36,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      zIndex: 1,
    },
    imagesWrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'flex-start',
      gap: 8,
    },
  });
}

export interface ToolResultImageProps {
  image?: ImageContentBlock;
  imageRef?: ImageRef | null;
  owningSessionId?: string;
}

type ResolvedImageSource =
  | { kind: 'data'; uri: string }
  | { kind: 'remote'; uri: string; thumbUri: string; headers?: Record<string, string> }
  | null;

function resolveImageSource(
  image: ImageContentBlock | undefined,
  imageRef: ImageRef | null | undefined,
  owningSessionId: string | undefined,
): ResolvedImageSource {
  if (imageRef && owningSessionId && isCloudClientConfigured()) {
    try {
      const full = mapImageRef(imageRef, owningSessionId);
      const thumb = mapImageRef(imageRef, owningSessionId, { thumb: true });
      return {
        kind: 'remote',
        uri: full.url,
        thumbUri: thumb.url,
        headers: full.rnSource.headers,
      };
    } catch (err) {
      if (!(err instanceof CloudClientError) || err.code !== 'cloud-client-not-configured') {
        throw err;
      }
      // fall through to imageContent
    }
  }

  if (image) {
    return {
      kind: 'data',
      uri: `data:${image.mimeType};base64,${image.data}`,
    };
  }

  return null;
}

export const ToolResultImage = memo(function ToolResultImage({ image, imageRef, owningSessionId }: ToolResultImageProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const [isExpanded, setIsExpanded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [aspectRatio, setAspectRatio] = useState(FALLBACK_ASPECT_RATIO);

  const resolved = useMemo(
    () => resolveImageSource(image, imageRef, owningSessionId),
    [image, imageRef, owningSessionId],
  );
  const thumbnailSource = useMemo(() => {
    if (!resolved) return null;
    if (resolved.kind === 'data') return { uri: resolved.uri };
    return resolved.headers ? { uri: resolved.thumbUri, headers: resolved.headers } : { uri: resolved.thumbUri };
  }, [resolved]);
  const fullSource = useMemo(() => {
    if (!resolved) return null;
    if (resolved.kind === 'data') return { uri: resolved.uri };
    return resolved.headers ? { uri: resolved.uri, headers: resolved.headers } : { uri: resolved.uri };
  }, [resolved]);
  const thumbnailWidth = useMemo(
    () => Math.max(THUMBNAIL_MIN_WIDTH, Math.min(THUMBNAIL_MAX_WIDTH, windowWidth - THUMBNAIL_HORIZONTAL_PADDING)),
    [windowWidth],
  );

  const handleOpen = useCallback(() => {
    if (!hasError) {
      setIsExpanded(true);
    }
  }, [hasError]);

  const handleClose = useCallback(() => {
    setIsExpanded(false);
  }, []);

  const handleError = useCallback(() => {
    setHasError(true);
  }, []);

  const handleLoad = useCallback((event: NativeSyntheticEvent<ImageLoadEventData>) => {
    const loadedWidth = event.nativeEvent?.source?.width;
    const loadedHeight = event.nativeEvent?.source?.height;

    if (
      typeof loadedWidth === 'number' &&
      typeof loadedHeight === 'number' &&
      loadedWidth > 0 &&
      loadedHeight > 0
    ) {
      setAspectRatio(loadedWidth / loadedHeight);
    }
  }, []);

  if (hasError || !resolved || !thumbnailSource || !fullSource) {
    return (
      <View style={[s.fallback, { width: thumbnailWidth }]} testID="tool-result-image-fallback">
        <Feather name="image" size={20} color={colors.textTertiary} />
        <Text style={s.fallbackText}>Image unavailable</Text>
      </View>
    );
  }

  return (
    <>
      <TouchableOpacity
        testID="tool-result-image-thumbnail"
        style={[s.thumbnailButton, { width: thumbnailWidth }]}
        activeOpacity={0.85}
        onPress={handleOpen}
        accessibilityRole="button"
        accessibilityLabel="Tool result image, tap to expand"
      >
        <Image
          testID="tool-result-image"
          source={thumbnailSource}
          style={[s.thumbnailImage, { aspectRatio }]}
          resizeMode="contain"
          onLoad={handleLoad}
          onError={handleError}
        />
      </TouchableOpacity>

      <Modal
        transparent
        animationType="fade"
        visible={isExpanded}
        onRequestClose={handleClose}
      >
        <TouchableOpacity
          style={s.modalBackdrop}
          activeOpacity={1}
          onPress={handleClose}
          accessibilityRole="none"
        >
          <View
            style={[
              s.modalContent,
              {
                paddingTop: insets.top + 16,
                paddingBottom: insets.bottom + 16,
              },
            ]}
            accessibilityViewIsModal
            accessibilityLabel="Expanded image view"
          >
            <TouchableOpacity
              testID="tool-result-image-close"
              style={[s.closeButton, { top: insets.top + 16 }]}
              onPress={handleClose}
              accessibilityRole="button"
              accessibilityLabel="Close expanded image"
            >
              <Feather name="x" size={18} color={colors.textPrimary} />
            </TouchableOpacity>

            <Image
              source={fullSource}
              style={s.expandedImage}
              resizeMode="contain"
              onError={handleError}
            />
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
});

ToolResultImage.displayName = 'ToolResultImage';

export interface ToolResultImagesProps {
  images?: ImageContentBlock[];
  imageRefs?: (ImageRef | null)[];
  owningSessionId?: string;
}

export const ToolResultImages = memo(function ToolResultImages({ images, imageRefs, owningSessionId }: ToolResultImagesProps) {
  const colors = useColors();
  const s = useMemo(() => createStyles(colors), [colors]);

  const entries = useMemo(() => {
    const count = Math.max(images?.length ?? 0, imageRefs?.length ?? 0);
    const pairs: Array<{ image?: ImageContentBlock; imageRef?: ImageRef | null }> = [];
    for (let i = 0; i < count; i++) {
      const ref = imageRefs?.[i] ?? null;
      const content = images?.[i];
      if (!ref && !content) continue;
      pairs.push({ image: content, imageRef: ref });
    }
    return pairs;
  }, [images, imageRefs]);

  if (entries.length === 0) {
    return null;
  }

  if (entries.length === 1) {
    const entry = entries[0];
    return (
      <ToolResultImage
        image={entry.image}
        imageRef={entry.imageRef}
        owningSessionId={owningSessionId}
      />
    );
  }

  return (
    <View style={s.imagesWrap}>
      {entries.map((entry, index) => (
        <ToolResultImage
          key={index}
          image={entry.image}
          imageRef={entry.imageRef}
          owningSessionId={owningSessionId}
        />
      ))}
    </View>
  );
});

ToolResultImages.displayName = 'ToolResultImages';
