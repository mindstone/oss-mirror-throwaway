/**
 * OAuth HTML Templates
 *
 * Shared HTML page generators for OAuth callback success/error pages.
 * Used by Google Workspace and HubSpot auth services.
 */

export interface OAuthSuccessConfig {
  providerName: string;
  gradientFrom: string;
  gradientTo: string;
  shadowColor: string;
  icon: string;
  identifier: string;
  subtitle: string;
  hint: string;
  autoCloseMs?: number;
}

function generateOAuthSuccessHtml(config: OAuthSuccessConfig): string {
  const {
    providerName,
    gradientFrom,
    gradientTo,
    shadowColor,
    icon,
    identifier,
    subtitle,
    hint,
    autoCloseMs = 2000,
  } = config;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${providerName} Connected - Rebel</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { 
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%);
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #e0e0e0;
      }
      .container { max-width: 480px; padding: 48px; text-align: center; }
      .rebel-icon {
        width: 80px; height: 80px; margin-bottom: 24px;
        background: linear-gradient(135deg, ${gradientFrom} 0%, ${gradientTo} 100%);
        border-radius: 20px; display: inline-flex;
        align-items: center; justify-content: center;
        font-size: 40px; font-weight: bold; color: white;
        box-shadow: 0 8px 32px ${shadowColor};
      }
      h1 { font-size: 28px; font-weight: 600; margin-bottom: 12px; color: #ffffff; }
      .subtitle { font-size: 16px; color: #a0a0a0; margin-bottom: 24px; line-height: 1.5; }
      .identifier { 
        font-family: 'SF Mono', Monaco, monospace;
        font-size: 14px; color: #22c55e;
        background: rgba(34, 197, 94, 0.1);
        border: 1px solid rgba(34, 197, 94, 0.3);
        border-radius: 8px; padding: 12px 16px;
        margin-bottom: 24px;
      }
      .hint { font-size: 13px; color: #666; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="rebel-icon">${icon}</div>
      <h1>${providerName} Connected</h1>
      <p class="subtitle">${subtitle}</p>
      <div class="identifier">${identifier}</div>
      <p class="hint">${hint}</p>
    </div>
    <script>setTimeout(function() { window.close(); }, ${autoCloseMs});</script>
  </body>
</html>`;
}

function generateOAuthErrorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Connection Failed - Rebel</title>
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { 
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%);
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #e0e0e0;
      }
      .container { max-width: 480px; padding: 48px; text-align: center; }
      .rebel-icon {
        width: 80px; height: 80px; margin-bottom: 24px;
        background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
        border-radius: 20px; display: inline-flex;
        align-items: center; justify-content: center;
        font-size: 40px; font-weight: bold; color: white;
        box-shadow: 0 8px 32px rgba(239, 68, 68, 0.3);
      }
      h1 { font-size: 28px; font-weight: 600; margin-bottom: 12px; color: #ffffff; }
      .subtitle { font-size: 16px; color: #a0a0a0; margin-bottom: 32px; line-height: 1.5; }
      .error-detail {
        background: rgba(239, 68, 68, 0.1);
        border: 1px solid rgba(239, 68, 68, 0.3);
        border-radius: 12px; padding: 16px;
        font-family: 'SF Mono', Monaco, monospace;
        font-size: 13px; color: #f87171;
        margin-bottom: 24px;
      }
      .hint { font-size: 13px; color: #666; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="rebel-icon">!</div>
      <h1>Well, that didn't work</h1>
      <p class="subtitle">Connection declined. Perhaps try again?</p>
      <div class="error-detail">${message}</div>
      <p class="hint">You can close this tab and try again in Rebel.</p>
    </div>
    <script>setTimeout(function() { window.close(); }, 3000);</script>
  </body>
</html>`;
}

// Pre-configured generators for each provider
export const googleOAuthHtml = {
  success: (email: string) =>
    generateOAuthSuccessHtml({
      providerName: 'Google',
      gradientFrom: '#8b5cf6',
      gradientTo: '#6366f1',
      shadowColor: 'rgba(139, 92, 246, 0.3)',
      icon: 'R',
      identifier: email,
      subtitle: 'Your wish is my command. Well, within reason.',
      hint: 'Return to Rebel to see what you can do with Gmail, Calendar, and Drive.',
      autoCloseMs: 2000,
    }),
  error: generateOAuthErrorHtml,
};

export const codexOAuthHtml = {
  success: (email?: string) =>
    generateOAuthSuccessHtml({
      providerName: 'ChatGPT Pro',
      gradientFrom: '#10a37f',
      gradientTo: '#1a7f64',
      shadowColor: 'rgba(16, 163, 127, 0.3)',
      icon: 'R',
      identifier: email ?? 'ChatGPT Pro',
      subtitle: 'Your subscription, my horsepower. Fair trade.',
      hint: 'Return to Rebel — your conversations now run on ChatGPT Pro models.',
      autoCloseMs: 2000,
    }),
  error: generateOAuthErrorHtml,
};

