import { scanSpacesWithSideEffects } from '../spaceService';

export async function runWritableScanForFixture(workspacePath: string) {
  return scanSpacesWithSideEffects(workspacePath);
}
