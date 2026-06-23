import type { ReactNode } from 'react';
import {
  FileText,
  FileJson,
  FileCode,
  FileType,
  Image,
  File,
  FileVideo,
  FileAudio,
  FileArchive,
  FileSpreadsheet,
  Presentation,
} from 'lucide-react';

type FileIconProps = {
  size?: number;
  strokeWidth?: number;
  className?: string;
};

const DEFAULT_PROPS: FileIconProps = {
  size: 14,
  strokeWidth: 1.5,
};

type IconComponent = (props: FileIconProps) => ReactNode;

const extensionToIcon: Record<string, IconComponent> = {
  // Markdown
  md: (props) => <FileText {...DEFAULT_PROPS} {...props} />,
  mdx: (props) => <FileText {...DEFAULT_PROPS} {...props} />,
  markdown: (props) => <FileText {...DEFAULT_PROPS} {...props} />,

  // JSON/Config
  json: (props) => <FileJson {...DEFAULT_PROPS} {...props} />,
  jsonc: (props) => <FileJson {...DEFAULT_PROPS} {...props} />,

  // YAML
  yaml: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  yml: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,

  // Code
  ts: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  tsx: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  js: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  jsx: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  py: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  rb: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  go: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  rs: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  java: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  c: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  cpp: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  h: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  hpp: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  cs: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  swift: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  kt: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  sh: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  bash: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  zsh: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,

  // Web
  html: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  htm: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  css: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  scss: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  less: (props) => <FileCode {...DEFAULT_PROPS} {...props} />,
  svg: (props) => <Image {...DEFAULT_PROPS} {...props} />,

  // Plain text
  txt: (props) => <FileType {...DEFAULT_PROPS} {...props} />,
  log: (props) => <FileType {...DEFAULT_PROPS} {...props} />,

  // Images
  png: (props) => <Image {...DEFAULT_PROPS} {...props} />,
  jpg: (props) => <Image {...DEFAULT_PROPS} {...props} />,
  jpeg: (props) => <Image {...DEFAULT_PROPS} {...props} />,
  gif: (props) => <Image {...DEFAULT_PROPS} {...props} />,
  webp: (props) => <Image {...DEFAULT_PROPS} {...props} />,
  ico: (props) => <Image {...DEFAULT_PROPS} {...props} />,
  bmp: (props) => <Image {...DEFAULT_PROPS} {...props} />,

  // Video
  mp4: (props) => <FileVideo {...DEFAULT_PROPS} {...props} />,
  mov: (props) => <FileVideo {...DEFAULT_PROPS} {...props} />,
  avi: (props) => <FileVideo {...DEFAULT_PROPS} {...props} />,
  mkv: (props) => <FileVideo {...DEFAULT_PROPS} {...props} />,
  webm: (props) => <FileVideo {...DEFAULT_PROPS} {...props} />,

  // Audio
  mp3: (props) => <FileAudio {...DEFAULT_PROPS} {...props} />,
  wav: (props) => <FileAudio {...DEFAULT_PROPS} {...props} />,
  ogg: (props) => <FileAudio {...DEFAULT_PROPS} {...props} />,
  flac: (props) => <FileAudio {...DEFAULT_PROPS} {...props} />,
  m4a: (props) => <FileAudio {...DEFAULT_PROPS} {...props} />,

  // Archives
  zip: (props) => <FileArchive {...DEFAULT_PROPS} {...props} />,
  tar: (props) => <FileArchive {...DEFAULT_PROPS} {...props} />,
  gz: (props) => <FileArchive {...DEFAULT_PROPS} {...props} />,
  rar: (props) => <FileArchive {...DEFAULT_PROPS} {...props} />,
  '7z': (props) => <FileArchive {...DEFAULT_PROPS} {...props} />,

  // Documents
  pdf: (props) => <FileText {...DEFAULT_PROPS} {...props} />,
  doc: (props) => <FileText {...DEFAULT_PROPS} {...props} />,
  docx: (props) => <FileText {...DEFAULT_PROPS} {...props} />,
  
  // Spreadsheets
  csv: (props) => <FileSpreadsheet {...DEFAULT_PROPS} {...props} />,
  xls: (props) => <FileSpreadsheet {...DEFAULT_PROPS} {...props} />,
  xlsx: (props) => <FileSpreadsheet {...DEFAULT_PROPS} {...props} />,

  // Presentations
  ppt: (props) => <Presentation {...DEFAULT_PROPS} {...props} />,
  pptx: (props) => <Presentation {...DEFAULT_PROPS} {...props} />,
};

export function getFileIcon(fileName: string, props?: FileIconProps): ReactNode {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const iconFn = extensionToIcon[ext];
  
  if (iconFn) {
    return iconFn(props ?? {});
  }
  
  return <File {...DEFAULT_PROPS} {...props} />;
}

export function getFileExtension(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? '';
}
