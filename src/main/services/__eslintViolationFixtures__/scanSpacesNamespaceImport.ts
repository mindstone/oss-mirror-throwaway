import * as spaceService from '../spaceService';

export async function runWritableNamespaceScanForFixture(workspacePath: string) {
  return spaceService.scanSpacesWithSideEffects(workspacePath);
}
