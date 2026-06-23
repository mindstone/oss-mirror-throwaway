export function canonicalizePlan(value: unknown): unknown {
  return canonicalizeValue(value, '$');
}

function canonicalizeValue(value: unknown, path: string): unknown {
  if (value === undefined) {
    throw new Error(`Cannot canonicalize undefined at ${path}`);
  }
  if (typeof value === 'bigint') {
    throw new Error(`Cannot canonicalize BigInt at ${path}`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`Cannot canonicalize non-finite number at ${path}`);
  }
  if (Array.isArray(value)) {
    assertHeaderTupleOrder(value, path);
    return value.map((item, index) => canonicalizeValue(item, `${path}[${index}]`));
  }
  if (isPlainRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right))) {
      result[key] = canonicalizeValue(value[key], `${path}.${key}`);
    }
    return result;
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertHeaderTupleOrder(value: ReadonlyArray<unknown>, path: string): void {
  if (!path.endsWith('.headers')) return;
  const names: string[] = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || typeof item[1] !== 'string') {
      throw new Error(`Header at ${path} must be a [string, string] tuple`);
    }
    names.push(item[0]);
  }
  const sorted = [...names].sort((left, right) => left.localeCompare(right));
  for (let index = 0; index < names.length; index += 1) {
    if (names[index] !== sorted[index]) {
      throw new Error(`Headers at ${path} must be sorted by name`);
    }
  }
}
