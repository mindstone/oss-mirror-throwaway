export interface OAuthToolResolution {
  provider: 'google' | 'slack' | 'hubspot' | 'microsoft';
  accountKey: string;
}

export interface OAuthToolResolver {
  resolve(toolName: string): OAuthToolResolution | null;
}

export const NULL_OAUTH_TOOL_RESOLVER: OAuthToolResolver = {
  resolve: () => null,
};

let _oauthToolResolver: OAuthToolResolver = NULL_OAUTH_TOOL_RESOLVER;

export function setOAuthToolResolver(resolver: OAuthToolResolver): void {
  _oauthToolResolver = resolver;
}

export function getOAuthToolResolver(): OAuthToolResolver {
  return _oauthToolResolver;
}
