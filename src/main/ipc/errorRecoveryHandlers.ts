/**
 * Error Recovery Domain IPC Handlers
 *
 * Handles error evaluation and recovery operations.
 */

import type { HandlerInvokeEvent } from '@core/handlerRegistry';
import { getErrorRecoveryService } from '../services/errorRecoveryService';
import { registerHandler } from './utils/registerHandler';
import { createScopedLogger } from '@core/logger';
import type { SafeModeErrorCategory } from '@shared/types';

const log = createScopedLogger({ service: 'errorRecoveryHandlers' });

export interface ErrorRecoveryHandlerDeps {
  // Dependencies are injected into the service at initialization
}

export function registerErrorRecoveryHandlers(_deps: ErrorRecoveryHandlerDeps = {}): void {
  log.info('Registering error recovery handlers');

  registerHandler(
    'error-recovery:evaluate',
    async (
      _event: HandlerInvokeEvent,
      request: {
        errorCategory: SafeModeErrorCategory;
        errorMessage?: string;
        context?: Record<string, unknown>;
      }
    ) => {
      log.info({ errorCategory: request.errorCategory }, 'error-recovery:evaluate handler called');
      const service = getErrorRecoveryService();
      return service.evaluate(request);
    }
  );

  registerHandler('error-recovery:get-state', (_event: HandlerInvokeEvent) => {
    log.debug('error-recovery:get-state handler called');
    const service = getErrorRecoveryService();
    return service.getState();
  });

  registerHandler('error-recovery:dismiss', (_event: HandlerInvokeEvent) => {
    log.debug('error-recovery:dismiss handler called');
    const service = getErrorRecoveryService();
    service.dismiss();
    return { success: true };
  });

  registerHandler('error-recovery:get-fix-prompt', (_event: HandlerInvokeEvent) => {
    log.debug('error-recovery:get-fix-prompt handler called');
    const service = getErrorRecoveryService();
    const state = service.getState();
    return {
      prompt: service.buildFixConversationPrompt(),
      errorCategory: state.errorCategory,
    };
  });

  log.info('Error recovery handlers registered successfully');
}
