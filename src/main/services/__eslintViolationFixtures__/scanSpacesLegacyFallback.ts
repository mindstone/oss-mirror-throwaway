import { scanSpaces } from '../spaceService';

export async function runLegacyScanFallback(workspacePath: string) {
  return scanSpaces(workspacePath);
}
