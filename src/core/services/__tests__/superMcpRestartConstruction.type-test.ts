import { superMcpHttpManager } from '../superMcpHttpManager';

declare const configPath: string;

// Detached form is the default for config-mutation callers: void by
// construction, so a caller cannot await the deferred restart.
superMcpHttpManager.requestRestartForConfigChangeDetached({
  configPath,
  context: 'type-test',
});

void superMcpHttpManager.requestRestartForConfigChangeDetached({
  configPath,
  context: 'type-test',
})
  // @ts-expect-error the detached form returns void — its result cannot be consumed as a promise.
  .then(() => undefined);

// Execution-awaiting form is an explicit opt-in by name.
void superMcpHttpManager.requestRestartForConfigChangeAndAwaitExecution({
  configPath,
  context: 'type-test',
});

void superMcpHttpManager.requestImmediateConfigReloadForChatMaterialization({
  configPath,
  context: 'type-test-chat-materialization',
  reason: 'chat-package-materialization',
});

// @ts-expect-error config-change callers cannot mint the immediate lifecycle token.
void superMcpHttpManager.reconfigure(configPath);

// @ts-expect-error shutdown wrappers are the only valid immediate-stop callers.
void superMcpHttpManager.stop();

// @ts-expect-error the lifecycle token brand is module-private and unforgeable.
void superMcpHttpManager.stop({ reason: 'app-shutdown' });

// @ts-expect-error shutdown wrappers are the only valid immediate-restart callers.
void superMcpHttpManager.restart();
