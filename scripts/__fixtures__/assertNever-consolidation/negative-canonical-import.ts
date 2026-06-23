import { assertNever } from '@shared/utils/assertNever';

type Example = 'handled';

export function classify(value: Example): string {
  switch (value) {
    case 'handled':
      return 'handled';
    default:
      return assertNever(value);
  }
}
