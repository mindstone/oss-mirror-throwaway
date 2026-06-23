type Example = 'handled' | 'unexpected';

export function classify(value: Example): string | undefined {
  switch (value) {
    case 'handled':
      return 'handled';
    default:
      return undefined;
  }
}
