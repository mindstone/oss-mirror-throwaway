import * as spaceService from '../spaceService';

export async function runLegacyNamespaceScanFallback(workspacePath: string) {
  return spaceService.scanSpaces(workspacePath);
}
