type Example = 'handled' | 'unexpected';

export function classify(value: Example): string {
  switch (value) {
    case 'handled':
      return 'handled';
    default:
  }

  return 'fallback';
}
