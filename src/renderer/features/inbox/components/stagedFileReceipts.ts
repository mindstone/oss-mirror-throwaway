export type StagedFileSaveReceiptOptions = {
  remembered?: boolean;
};

export function buildStagedFileSaveReceipt(
  file: Pick<{ fileName: string; spaceName: string }, 'fileName' | 'spaceName'>,
  options: StagedFileSaveReceiptOptions = {},
): string {
  return options.remembered
    ? `Approved and remembered. Rebel saved ${file.fileName} to ${file.spaceName}.`
    : `Approved. Rebel saved ${file.fileName} to ${file.spaceName}.`;
}

export function buildStagedFilesBatchSaveReceipt(
  files: Array<Pick<{ spaceName: string }, 'spaceName'>>,
): string {
  const uniqueSpaces = Array.from(
    new Set(files.map((file) => file.spaceName).filter(Boolean)),
  );
  const destination = uniqueSpaces.length === 1 ? ` to ${uniqueSpaces[0]}` : '';
  return `Approved. Rebel saved ${files.length} files${destination}.`;
}
