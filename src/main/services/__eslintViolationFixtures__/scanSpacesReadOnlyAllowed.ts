import { scanSpaces } from '../spaceService';

export async function runReadOnlyScanForFixture(workspacePath: string) {
  return scanSpaces(workspacePath, { skipAutoFix: true });
}
