/**
 * Re-export shim — canonical implementation lives in @core/utils/authEnvUtils.
 * Remove once all consumers are migrated.
 */
export {
  getAuthEnvVars,
  hasValidAuth,
  getAuthMethodDescription,
  getApiKeyForDirectUse,
  isUsingOAuth,
  isUsingOpenRouter,
  getApiKeyAuthEnvVars,
  getProviderKeyEnvVars,
} from '@core/utils/authEnvUtils';
