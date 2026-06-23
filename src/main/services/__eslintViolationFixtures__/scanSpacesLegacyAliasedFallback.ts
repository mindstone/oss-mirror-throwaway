import { scanSpaces as scanAnySpaces } from '../spaceService';

export async function runLegacyAliasedScanFallback(workspacePath: string) {
  return scanAnySpaces(workspacePath);
}
