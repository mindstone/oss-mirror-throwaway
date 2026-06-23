type Example = 'handled';

// rebel-assert-never-allow: fixture keeps a local declaration to verify the documented specialised-variant escape hatch.
function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

export function classify(value: Example): string {
  switch (value) {
    case 'handled':
      return 'handled';
    default:
      return assertNever(value);
  }
}
