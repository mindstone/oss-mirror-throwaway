import { scanSpacesWithSideEffects as scanWritableSpaces } from '../spaceService';

export async function runWritableAliasedScanForFixture(workspacePath: string) {
  return scanWritableSpaces(workspacePath);
}
