export interface LibraryDocumentState {
  path: string;
  name: string;
  relativePath: string;
  content: string;
  originalContent: string;
  updatedAt?: number;
  lastSavedAt?: number;
  isDirty: boolean;
  saving: boolean;
  error: string | null;
}
