export const BOOT_TOKEN_FILENAME = 'rebel-boot-token.json' as const;
export const BOOT_TOKEN_SCHEMA_VERSION = 1 as const;
export const BOOT_TOKEN_FILE_MODE = 0o600;

export interface BootTokenFile {
  schemaVersion: 1;
  routerToken: string;
  bridgeOrigin: string;
  port: number;
  startedAt: string;
  installSessionId: string;
}

export type BootTokenShape = BootTokenFile;

interface BootTokenWriteFs {
  writeFile: (
    path: string,
    data: string,
    options?: { encoding?: BufferEncoding; mode?: number },
  ) => Promise<void>;
  chmod?: (path: string, mode: number) => Promise<void>;
}

export function isValidBootTokenShape(value: unknown): value is BootTokenShape {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<Record<keyof BootTokenShape, unknown>>;
  return (
    candidate.schemaVersion === BOOT_TOKEN_SCHEMA_VERSION &&
    typeof candidate.routerToken === 'string' &&
    candidate.routerToken.length > 0 &&
    typeof candidate.bridgeOrigin === 'string' &&
    candidate.bridgeOrigin.length > 0 &&
    typeof candidate.port === 'number' &&
    Number.isFinite(candidate.port) &&
    candidate.port > 0 &&
    typeof candidate.startedAt === 'string' &&
    candidate.startedAt.length > 0 &&
    typeof candidate.installSessionId === 'string' &&
    candidate.installSessionId.length > 0
  );
}

export function parseBootTokenFile(raw: string): BootTokenFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid Rebel boot token JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isValidBootTokenShape(parsed)) {
    throw new Error('Invalid Rebel boot token shape.');
  }

  return parsed;
}

export async function readBootTokenFile(
  readFile: (path: string, encoding: BufferEncoding) => Promise<string>,
  filePath: string,
): Promise<BootTokenFile> {
  return parseBootTokenFile(await readFile(filePath, 'utf8'));
}

export async function writeBootTokenFile(
  fs: BootTokenWriteFs,
  filePath: string,
  bootToken: BootTokenShape,
): Promise<void> {
  if (!isValidBootTokenShape(bootToken)) {
    throw new Error('Cannot write invalid Rebel boot token shape.');
  }

  await fs.writeFile(filePath, `${JSON.stringify(bootToken, null, 2)}\n`, {
    encoding: 'utf8',
    mode: BOOT_TOKEN_FILE_MODE,
  });
  await fs.chmod?.(filePath, BOOT_TOKEN_FILE_MODE);
}
