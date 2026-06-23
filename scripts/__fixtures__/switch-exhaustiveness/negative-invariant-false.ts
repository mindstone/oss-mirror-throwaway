import { invariant } from '../../../src/shared/utils/invariant';

type Example = 'handled' | 'unexpected';

export function classify(value: Example): string {
  switch (value) {
    case 'handled':
      return 'handled';
    default: {
      invariant(false, 'switch-exhaustiveness fixture');
    }
  }

  return value;
}
