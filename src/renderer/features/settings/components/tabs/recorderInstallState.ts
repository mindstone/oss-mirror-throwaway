export interface RecorderInstallationStatus {
  installed: boolean;
}

export function shouldShowRecorderInstallAffordance(
  status: RecorderInstallationStatus | null,
): boolean {
  return status?.installed === false;
}
