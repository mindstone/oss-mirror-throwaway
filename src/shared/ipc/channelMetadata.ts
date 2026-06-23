export type ProductionFailurePolicy = 'fail-hard' | 'degrade-channel' | 'sentry-only';

export type ChannelMetadata = {
  requiredAtBoot: boolean;
  lazyRegistered: boolean;
  featureFlag?: string;
  bypass: boolean;
  productionFailurePolicy: ProductionFailurePolicy;
};

export const DEFAULT_CHANNEL_METADATA: ChannelMetadata = {
  requiredAtBoot: true,
  lazyRegistered: false,
  bypass: false,
  productionFailurePolicy: 'sentry-only',
};

const RAW_IPC_BYPASS_CHANNELS = [
  'check-for-updates',
  'discourse:cancel-auth',
  'discourse:start-auth',
  'hubspot:cancel-auth',
  'hubspot:get-accounts',
  'hubspot:remove-account',
  'hubspot:start-auth',
  'local-inference:activate',
  'local-inference:cancel-pull',
  'local-inference:deactivate',
  'local-inference:delete-model',
  'local-inference:get-status',
  'local-inference:pull-model',
  'local-stt:model-cancel-download',
  'local-stt:model-download',
  'local-stt:model-remove',
  'local-stt:model-status',
  'mcp:call-tool',
  'mcp:grant-permission',
  'mcp:invalidate-conversation-nonces',
  'mcp:invalidate-nonce',
  'mcp:issue-nonce',
  'mcp:list-permissions',
  'mcp:open-html-in-browser',
  'mcp:read-resource',
  'mcp:revoke-permission',
  'mcp:send-message',
  'mcp:update-context',
  'microsoft:cancel-auth',
  'microsoft:get-accounts',
  'microsoft:is-connected',
  'microsoft:remove-account',
  'microsoft:start-auth',
  'microsoft:start-auth-sharepoint',
  'physical-recording:connect',
  'physical-recording:disconnect',
  'physical-recording:get-recording-duration',
  'physical-recording:get-state',
  'physical-recording:scan-devices',
  'physical-recording:start-recording',
  'physical-recording:stop-recording',
  'physical-recording:stop-scanning',
  'quick-capture:start',
  'quick-capture:stop',
  'runtime-config:get',
  'sentry:capture-exception',
  'sentry:capture-message',
  'todoist:check-connection',
  'todoist:complete-task',
  'todoist:create-task',
  'todoist:delete-task',
  'todoist:get-tasks',
  'update:acknowledge',
  'update:acknowledge-toast',
  'update:get-pending-downloaded',
  'update:install-now',
  'zendesk:add-api-key-account',
  'zendesk:get-accounts',
  'zendesk:remove-account',
] as const;

const E2E_TEST_ONLY_BYPASS_CHANNELS = [
  'e2e:clear-pending-approvals',
  'e2e:inject-memory-approval',
  'e2e:inject-tool-approval',
  'e2e:seed-coaching',
  'e2e:seed-hero-choice',
] as const;

const bypassOverrides = Object.fromEntries(
  RAW_IPC_BYPASS_CHANNELS.map((channel) => [
    channel,
    {
      ...DEFAULT_CHANNEL_METADATA,
      bypass: true,
    } satisfies ChannelMetadata,
  ]),
) as Partial<Record<string, ChannelMetadata>>;

const e2eBypassOverrides = Object.fromEntries(
  E2E_TEST_ONLY_BYPASS_CHANNELS.map((channel) => [
    channel,
    {
      ...DEFAULT_CHANNEL_METADATA,
      requiredAtBoot: false,
      lazyRegistered: true,
      featureFlag: 'REBEL_E2E_TEST_MODE',
      bypass: true,
    } satisfies ChannelMetadata,
  ]),
) as Partial<Record<string, ChannelMetadata>>;

export const channelMetadataOverrides = {
  ...bypassOverrides,
  ...e2eBypassOverrides,
} satisfies Partial<Record<string, ChannelMetadata>>;

export function getChannelMetadata(channel: string): ChannelMetadata {
  return {
    ...DEFAULT_CHANNEL_METADATA,
    ...(channelMetadataOverrides[channel] ?? {}),
  };
}
