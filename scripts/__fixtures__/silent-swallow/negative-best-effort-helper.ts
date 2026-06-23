import { ignoreBestEffortCleanup } from '../../../src/shared/utils/intentionalSwallow';

try {
  doRiskyThing();
} catch (error) {
  ignoreBestEffortCleanup(error, {
    operation: 'fixture cleanup',
    reason: 'fixture cleanup is optional and safe to discard',
  });
}

declare function doRiskyThing(): void;
