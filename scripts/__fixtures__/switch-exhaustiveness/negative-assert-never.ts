import { assertNever } from '../../../src/shared/utils/assertNever';

type Example = 'handled' | 'unexpected';

export function classify(value: Example): string {
  switch (value) {
    case 'handled':
      return 'handled';
    default:
      return assertNever(value as never, 'switch-exhaustiveness fixture');
  }
}
