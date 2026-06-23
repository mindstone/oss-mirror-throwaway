export function formatSubagentDisplayName(rawName: string | undefined): string | undefined {
  if (!rawName) return undefined;
  if (/^[a-z][a-z0-9-]*$/.test(rawName) && !rawName.includes('-')) {
    return rawName.charAt(0).toUpperCase() + rawName.slice(1);
  }
  return undefined;
}
