export type MentionedFileCandidate = {
  key: string;
  absolutePath: string;
  relativePath: string;
  name: string;
  kind: 'file' | 'directory';
};
