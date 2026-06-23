export const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'xml', 'csv', 'log',
]);

export const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp',
]);

export const VIDEO_EXTENSIONS = new Set([
  'mp4', 'webm', 'mov', 'm4v',
]);

export const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac',
]);

export const HTML_EXTENSIONS = new Set(['html', 'htm']);

export const PDF_EXTENSIONS = new Set(['pdf']);

export const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);

export const TUTORIAL_EXTENSIONS = new Set(HTML_EXTENSIONS);

/**
 * Broader text-friendly extensions. Includes markup-like files (html, svg)
 * that can technically be shown as text. Kept for legacy consumers that rely
 * on this wider allowlist. Consider MOBILE_TEXT_VIEWABLE_EXTENSIONS for mobile.
 */
export const DEFAULT_TEXT_VIEWABLE_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  'html',
  'htm',
  'toml',
  'ini',
  'ts',
  'js',
  'jsx',
  'tsx',
  'py',
  'sh',
  'css',
  'scss',
  'less',
  'svg',
  'env',
  'gitignore',
  'cfg',
  'conf',
  'properties',
]);

/**
 * Strict text-only extensions for surfaces without HTML/image/video/pdf
 * viewers (currently mobile). Excludes html, htm, svg so those trigger
 * category-aware "not previewable on mobile" errors instead of dumping
 * raw markup into a text modal.
 */
export const MOBILE_TEXT_VIEWABLE_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  'toml',
  'ini',
  'ts',
  'js',
  'jsx',
  'tsx',
  'py',
  'sh',
  'css',
  'scss',
  'less',
  'env',
  'gitignore',
  'cfg',
  'conf',
  'properties',
]);

export type FilePreviewCategory =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'html'
  | 'pdf'
  | 'tutorial'
  | 'unsupported';

export const getFileExtension = (filePath: string): string => {
  return filePath.split('.').pop()?.toLowerCase() ?? '';
};

export const isImagePath = (filePath: string): boolean => {
  return IMAGE_EXTENSIONS.has(getFileExtension(filePath));
};

export const isTextPath = (filePath: string): boolean => {
  return TEXT_EXTENSIONS.has(getFileExtension(filePath));
};

export const isVideoPath = (filePath: string): boolean => {
  return VIDEO_EXTENSIONS.has(getFileExtension(filePath));
};

export const isAudioPath = (filePath: string): boolean => {
  return AUDIO_EXTENSIONS.has(getFileExtension(filePath));
};

export const isHtmlPath = (filePath: string): boolean => {
  return HTML_EXTENSIONS.has(getFileExtension(filePath));
};

export const isPdfPath = (filePath: string): boolean => {
  return PDF_EXTENSIONS.has(getFileExtension(filePath));
};

export const isMarkdownPath = (filePath: string): boolean => {
  return MARKDOWN_EXTENSIONS.has(getFileExtension(filePath));
};

export const isTutorialPath = (filePath: string): boolean => {
  const normalized = filePath.replace(/\\/g, '/');
  return (
    normalized.startsWith('rebel-system/help-for-humans/tutorials/') &&
    TUTORIAL_EXTENSIONS.has(getFileExtension(filePath))
  );
};

export const getFilePreviewCategory = (filePath: string): FilePreviewCategory => {
  if (isTutorialPath(filePath)) return 'tutorial';

  const ext = getFileExtension(filePath);
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (HTML_EXTENSIONS.has(ext)) return 'html';
  if (PDF_EXTENSIONS.has(ext)) return 'pdf';

  return 'unsupported';
};

export const getImageMimeType = (filePath: string): string => {
  const ext = getFileExtension(filePath);
  const mimeTypes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
  };
  return mimeTypes[ext] ?? 'image/png';
};

export type FilePrivacy = 'private' | 'shared' | 'unknown';

export const getFilePrivacy = (filePath: string): FilePrivacy => {
  // Normalise separators, then strip leading wrappers so absolute paths
  // (e.g. `/work/foo.md`, `C:/work/foo.md`, `./work/foo.md`) match the same
  // prefix rules as relative paths (inherited-gap fix).
  let normalized = filePath.replace(/\\/g, '/');

  // Strip drive-letter prefix (Windows): `C:/work/...` → `work/...`
  normalized = normalized.replace(/^[A-Za-z]:\/+/, '');
  // Strip leading `./` or `../` sequences: `./work/...` → `work/...`
  normalized = normalized.replace(/^(?:\.\.?\/)+/, '');
  // Strip leading slashes: `/work/...` → `work/...`
  normalized = normalized.replace(/^\/+/, '');

  const lower = normalized.toLowerCase();

  if (lower.startsWith('chief-of-staff/')) {
    return 'private';
  }

  if (lower.startsWith('work/')) {
    return 'shared';
  }

  if (lower.startsWith('rebel-system/')) {
    return 'private';
  }

  return 'unknown';
};

export const isPreviewablePath = (filePath: string): boolean => {
  const ext = getFileExtension(filePath);
  return (
    TEXT_EXTENSIONS.has(ext) ||
    IMAGE_EXTENSIONS.has(ext) ||
    VIDEO_EXTENSIONS.has(ext) ||
    AUDIO_EXTENSIONS.has(ext) ||
    HTML_EXTENSIONS.has(ext) ||
    PDF_EXTENSIONS.has(ext)
  );
};
