/**
 * Shared test helper that configures the prompt file service
 * for tests that call functions depending on externalized prompts.
 *
 * Usage in test files:
 *   import { setupPromptService, teardownPromptService } from './helpers/promptTestSetup';
 *   beforeEach(() => setupPromptService());
 *   afterEach(() => teardownPromptService());
 */
import path from 'node:path';
import {
  configurePromptFileService,
  _resetForTesting,
} from '@core/services/promptFileService';

/**
 * Configure the prompt file service with the real rebel-system/prompts/ directory.
 * Works from the repo root where tests are run.
 */
export function setupPromptService(): void {
  _resetForTesting();
  // __dirname is src/core/services/__tests__/helpers/ — go up 5 levels to repo root
  const promptsDir = path.resolve(__dirname, '../../../../..', 'rebel-system', 'prompts');
  configurePromptFileService(promptsDir);
}

/**
 * Reset the prompt file service state between tests.
 */
export function teardownPromptService(): void {
  _resetForTesting();
}
