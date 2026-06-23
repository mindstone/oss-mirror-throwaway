/**
 * Generates connector-specific setup prompts for the "Set up with Rebel" flow.
 * 
 * Strategy:
 * - For bundled connectors with setupToolName: directive prompts that tell Claude
 *   exactly which tool to call (faster setup)
 * - For other connectors: context-rich prompts with catalog metadata + semantic tool
 *   search results to help Claude find relevant tools without exploration
 */

import type { ConnectorCatalogEntry } from '@shared/types';
import { isBundledLikeProvider } from '@shared/types';
import type { SetupWithRebelParams } from '../components/tabs/types';

// Re-export from types.ts for convenience
export type { SetupWithRebelParams } from '../components/tabs/types';

// Tool search result type (mirrors IPC response)
interface ToolSearchResult {
  toolId: string;
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  summary: string;
  inputSchema: unknown;
  score: number;
}

/**
 * Build context section from catalog entry for non-directive prompts.
 * Includes description, setup instructions, required fields, URLs, and provider hints.
 */
function buildCatalogContext(catalogEntry: ConnectorCatalogEntry): string {
  const sections: string[] = [];

  if (catalogEntry.description) {
    sections.push(`**About this connector:**\n${catalogEntry.description}`);
  }

  if (catalogEntry.setupInstructions) {
    sections.push(`**Setup steps:**\n${catalogEntry.setupInstructions}`);
  }

  // Required fields with placeholders for more context
  if (catalogEntry.setupFields?.length) {
    const fields = catalogEntry.setupFields.map(f => {
      let fieldDesc = `- ${f.label}`;
      if (f.required === false) fieldDesc += ' (optional)';
      if (f.placeholder) fieldDesc += ` - e.g., ${f.placeholder}`;
      return fieldDesc;
    }).join('\n');
    sections.push(`**Required credentials:**\n${fields}`);
  }

  if (catalogEntry.setupUrl) {
    sections.push(`**Get credentials here:** ${catalogEntry.setupUrl}`);
  }

  // Provider context for AI guidance
  const providerGuidance: Record<string, string> = {
    bundled: 'This is a built-in connector with dedicated setup tools.',
    direct: 'This is an official vendor connector that uses OAuth authentication.',
    community: 'This is a community connector that may require manual configuration.',
  };
  if (catalogEntry.provider && providerGuidance[catalogEntry.provider]) {
    sections.push(providerGuidance[catalogEntry.provider]);
  }

  if (catalogEntry.runtime === 'python') {
    sections.push('Note: This connector requires Python (uvx) to be installed.');
  }

  return sections.join('\n\n');
}

/**
 * Format tool search results as a concise suggested tools section.
 * Only includes tool names and brief descriptions to avoid prompt bloat.
 */
function formatSuggestedTools(tools: ToolSearchResult[]): string {
  if (tools.length === 0) return '';

  const toolLines = tools.map(t => {
    const desc = t.summary || t.description || '';
    const shortDesc = desc.length > 100 ? desc.slice(0, 97) + '...' : desc;
    return `- \`${t.toolId}\` (${t.serverName}) - ${shortDesc}`;
  });

  return `**Setup tools that may help:**
${toolLines.join('\n')}`;
}

/**
 * Search for relevant setup tools for a specific server.
 * Searches for setup-related terms and filters to only include tools from the target server.
 * Returns empty array if search fails or no high-confidence matches found.
 */
async function searchServerSetupTools(serverId: string): Promise<ToolSearchResult[]> {
  try {
    // Search for setup-specific tool functionality
    const query = 'setup configure api key credentials initialize connect';

    const results = await window.searchApi.tools({
      query,
      limit: 10, // Get more results since we'll filter by server
      threshold: 0.8,
      maxPerPackage: 5,
    });

    // Filter to only include tools from the target server
    return results.filter(t => t.serverId === serverId);
  } catch (error) {
    console.warn('Tool search failed:', error);
    return [];
  }
}


const REBEL_BROWSER_SETUP_PROMPT = `Help me install Rebel Browser.

ACTION: Call \`rebel_bridge_prepare_install\` now. If it returns \`setupStatus: "needs_browser_choice"\`, ask me which browser to use and then call \`rebel_bridge_prepare_install\` again with \`browser_id\`.

When it returns \`setupStatus: "awaiting_user_handoff"\` or \`"degraded"\`, use the returned \`nextStep\` and \`steps\` to guide me through the browser handoff.

AFTER HANDOFF: When I say the extension is loaded, done, installed, or the Rebel icon appears, call \`rebel_browser_status({})\` exactly once. Do not call \`rebel_bridge_prepare_install\` again for that message.

SUCCESS: If \`rebel_browser_status\` reports connected, say Rebel Browser is connected and give one concrete example of what I can do next.

GUARDRAILS: The old code-based pairing flow is obsolete. Do not generate a security code, wait for pair events, ask for approval queues, or use older notes that describe that flow. Never expose internal install identifiers.`;

/**
 * Generate a setup prompt based on the connector's catalog entry and setup result.
 *
 * Priority order for determining prompt:
 * 1. Rebel Browser special case
 * 2. oauthResult - Fresh OAuth result (for direct OAuth connectors)
 * 3. setupResult - Result from setup action (API key save, bundled add)
 * 4. isNewConnection + connector type - Infer expected next action
 * 5. Fallback - Context-rich prompt with tool search
 */
export async function generateSetupPrompt(params: SetupWithRebelParams): Promise<string> {
  const { serverName, catalogEntry, oauthResult, setupResult, isNewConnection } = params;

  if (catalogEntry?.id === 'bundled-app-bridge') {
    return REBEL_BROWSER_SETUP_PROMPT;
  }

  // Fallback to generic prompt if no catalog entry
  if (!catalogEntry) {
    return `Help me set up ${serverName}. Guide me through the setup process.`;
  }

  const { provider, bundledConfig, description, setupUrl, setupFields } = catalogEntry;

  // Bundled connectors with known setup tools - use directive prompts
  if (isBundledLikeProvider(provider) && bundledConfig) {
    const { authType, setupToolName } = bundledConfig;
    const descriptionText = description || 'this connector';

    // No setup needed - either built-in tools (RebelInbox) or no-auth connectors (BrowserAutomation)
    if (authType === 'none') {
      // If this was triggered as a new connection, verify it works and show capabilities
      if (isNewConnection || setupResult?.success) {
        // Some no-auth connectors have a setup tool that should be called on first enable
        // (e.g., RebelOffice needs rebel_office_setup to install the add-in into Office)
        if (setupToolName) {
          return `I just connected ${serverName}.

ACTION: Call \`${setupToolName}\` now to complete the installation. This only needs to happen once.

After setup completes, tell me what I can do with ${descriptionText} and what the next steps are.`;
        }
        return `I just connected ${serverName}.

ACTION: Call \`list_tools(package_id: "${serverName}")\` to verify the connection works and show me what I can do with ${descriptionText}.`;
      }
      // Fallback for internal/always-available tools
      return `${serverName} is a built-in tool that's always available. ${description || ''}`;
    }

    // If OAuth succeeded for bundled OAuth connectors, skip the authenticate tool
    // and just verify/show capabilities
    if (oauthResult?.success && authType === 'oauth' && isNewConnection) {
      // Include account/workspace identity in the message if available
      const identityInfo = oauthResult.accountIdentity 
        ? ` (${oauthResult.accountIdentity})` 
        : '';
      return `I just connected ${serverName}${identityInfo} via OAuth.

ACTION: Call \`list_tools(package_id: "${serverName}")\` to verify the connection works and show me what I can do with ${descriptionText}.`;
    }

    // If we have setupResult, use it to determine prompt
    if (setupResult && isNewConnection) {
      if (setupResult.success) {
        // Setup succeeded (API key saved or OAuth completed) - verify with list_tools
        return `I just added ${serverName}.

ACTION: Call \`list_tools(package_id: "${serverName}")\` to verify the connection works and show me what I can do with ${descriptionText}.

If the tools aren't found yet, wait a moment and retry.`;
      } else {
        // Setup failed - help troubleshoot
        const errorInfo = setupResult.error ? ` Error: ${setupResult.error}` : '';
        return `I tried to add ${serverName} but it failed.${errorInfo}

Help me troubleshoot this issue. Check if:
1. The server configuration is correct
2. Any required credentials are valid
3. The server is reachable

${setupUrl ? `I may need to get credentials from: ${setupUrl}` : ''}`;
      }
    }

    // Directive prompts require setupToolName (for cases without setupResult)
    if (setupToolName) {
      // OAuth connectors
      if (authType === 'oauth') {
        return `Set up ${serverName} for me.

ACTION: Call \`${setupToolName}\` now. It will return an OAuth URL for me to click and authorize access.

After setup succeeds, briefly tell me what I can do with ${descriptionText}.`;
      }

      // OAuth with user-provided credentials (Salesforce)
      if (authType === 'oauth-user-provided') {
        return `Set up ${serverName} for me.

This connector requires me to provide my own OAuth app credentials first. ${setupUrl ? `I can create them at: ${setupUrl}` : ''}

Once I provide the Client ID and Client Secret, call \`${setupToolName}\` to start the OAuth flow.

After setup succeeds, briefly tell me what I can do with ${descriptionText}.`;
      }

      // API-key connectors
      if (authType === 'api-key') {
        const hasMultipleFields = setupFields && setupFields.length > 1;
        const fieldNames = setupFields?.map(f => f.label).join(' and ') || 'API key';
        
        if (hasMultipleFields) {
          return `Set up ${serverName} for me.

ACTION: Ask me for my ${fieldNames} using \`AskUserQuestion\`.
Use option cards with inline input, not just prose.
${setupUrl ? `For each credential the question asks for, set the option \`url\` to ${setupUrl} so clicking it opens the page where I can get it.` : ''}

Once I give you the credentials, call \`${setupToolName}\` with them.

After setup succeeds, briefly tell me what I can do with ${descriptionText}.`;
        }

        return `Set up ${serverName} for me.

ACTION: Ask me for my API key using \`AskUserQuestion\`.
Use an option with \`requiresInput: true\` and an \`inputPlaceholder\` that tells me to paste the key.
${setupUrl ? `Set that option's \`url\` to ${setupUrl} so clicking it opens the page where I can get the key.` : ''}

Once I give you the key, call \`${setupToolName}\` with it.

After setup succeeds, briefly tell me what I can do with ${descriptionText}.`;
      }
    }
    // Fall through to context-rich prompt if no setupToolName
  }

  // Direct OAuth connectors (Notion, Linear, etc.) - use directive prompts based on oauth result
  if (provider === 'direct' && catalogEntry.mcpConfig?.oauth && oauthResult) {
    const descriptionText = description || 'this connector';
    
    if (oauthResult.success) {
      // OAuth succeeded - verify and show capabilities
      // Include account/workspace identity in the message if available
      const identityInfo = oauthResult.accountIdentity 
        ? ` (${oauthResult.accountIdentity})` 
        : '';
      return `I just connected ${serverName}${identityInfo} via OAuth.

ACTION: Call \`list_tools(package_id: "${serverName}")\` to verify the connection works and show me what I can do with ${descriptionText}.`;
    } else {
      // OAuth failed - help troubleshoot
      const errorInfo = oauthResult.error ? ` Error: ${oauthResult.error}` : '';
      return `I tried to connect ${serverName} via OAuth but it failed.${errorInfo}

Help me troubleshoot:
1. Call \`health_check_all()\` to see the current status
2. If needed, call \`rebel_mcp_authenticate(serverId: "${serverName}")\` to retry the OAuth flow

Once connected, show me what I can do with ${descriptionText}.`;
    }
  }

  // Reconfigure existing connection (isNewConnection === false)
  if (isNewConnection === false) {
    const descriptionText = description || 'this connector';
    return `Help me with ${serverName}.

This connector is already configured. What would you like help with?

- Check connection status: \`health_check(package_id: "${serverName}")\`
- See available tools: \`list_tools(package_id: "${serverName}")\`
- Re-authenticate (if needed): \`rebel_mcp_authenticate(serverId: "${serverName}")\`

${descriptionText}`;
  }

  // Direct OAuth connectors without oauthResult (fallback - shouldn't normally happen)
  // For OAuth, hardcode the Super-MCP router tools - no semantic search needed
  if (provider === 'direct' && catalogEntry.mcpConfig?.oauth) {
    const context = buildCatalogContext(catalogEntry);
    return `**Setup tool:**
- \`rebel_mcp_authenticate(serverId: "${serverName}")\` - Start OAuth flow

Help me set up ${serverName}.

${context}

This is a vendor-hosted connector that uses OAuth. Guide me through connecting my account.

Check whether it's already configured. If it is, ask if I want to add another account (if supported) or modify the existing setup. If it's new, guide me through initial setup.`.trim();
  }

  // For non-OAuth connectors, search for server-specific setup tools
  const suggestedTools = await searchServerSetupTools(serverName);
  const toolsSection = formatSuggestedTools(suggestedTools);

  // Context-rich fallback for bundled without setupToolName, community, etc.
  const context = buildCatalogContext(catalogEntry);
  if (context) {
    const toolsPreamble = toolsSection ? `${toolsSection}\n\n` : '';
    return `${toolsPreamble}Help me set up or configure ${serverName}.

${context}

Check whether it's already configured. If it is, ask if I want to add another account (if supported) or modify the existing setup. If it's new, guide me through initial setup. Finally, give me a quick overview of what it can do.`.trim();
  }

  // Bare fallback (still include tools if found)
  if (toolsSection) {
    return `${toolsSection}

Help me set up ${serverName}. ${description || 'Guide me through the setup process.'}`.trim();
  }

  return `Help me set up ${serverName}. ${description || 'Guide me through the setup process.'}`;
}
