export type OAuthRedirectConnector =
  | 'slack'
  | 'microsoft'
  | 'salesforce'
  | 'plaud'
  | 'github'
  | 'digitalocean'
  | 'discourse'
  | 'openrouter'
  | 'openrouter-start';

type OAuthRedirectConfig = {
  envKey: string;
  defaultUri: string;
};

const REDIRECT_URI_CONFIG: Record<OAuthRedirectConnector, OAuthRedirectConfig> = {
  slack: {
    envKey: 'SLACK_REDIRECT_URI',
    defaultUri: 'https://rebel-auth.mindstone.com/slack/callback',
  },
  microsoft: {
    envKey: 'MICROSOFT_REDIRECT_URI',
    defaultUri: 'https://rebel-auth.mindstone.com/microsoft/callback',
  },
  salesforce: {
    envKey: 'SALESFORCE_REDIRECT_URI',
    defaultUri: 'https://rebel-auth.mindstone.com/salesforce/callback',
  },
  plaud: {
    envKey: 'PLAUD_REDIRECT_URI',
    defaultUri: 'https://rebel-auth.mindstone.com/plaud/callback',
  },
  github: {
    envKey: 'GITHUB_REDIRECT_URI',
    defaultUri: 'https://rebel-auth.mindstone.com/github/callback',
  },
  digitalocean: {
    envKey: 'DIGITAL_OCEAN_REDIRECT_URI',
    defaultUri: 'https://rebel-auth.mindstone.com/digitalocean/callback',
  },
  discourse: {
    envKey: 'DISCOURSE_REDIRECT_URI',
    defaultUri: 'https://rebel-auth.mindstone.com/discourse/callback',
  },
  openrouter: {
    envKey: 'OPENROUTER_REDIRECT_URI',
    defaultUri: 'https://rebel-auth.mindstone.com/openrouter/callback',
  },
  'openrouter-start': {
    envKey: 'OPENROUTER_AUTH_START_URL',
    defaultUri: 'https://rebel-auth.mindstone.com/openrouter/start',
  },
};

export function getOAuthRedirectUri(connector: OAuthRedirectConnector): string {
  const config = REDIRECT_URI_CONFIG[connector];
  return process.env[config.envKey] || config.defaultUri;
}
