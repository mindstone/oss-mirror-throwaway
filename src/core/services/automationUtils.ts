/**
 * Automation Prompt Utilities (shared)
 *
 * Pure utility functions for building automation prompts. Used by both
 * desktop (automationScheduler.ts) and cloud-service (cloudAutomationPrompt.ts).
 *
 * These functions are platform-agnostic — no filesystem, Electron, or
 * platform-boundary dependencies. File resolution and reading remain in
 * the platform-specific callers.
 */

/**
 * Strip YAML frontmatter (delimited by `---`) from markdown content.
 */
export const stripYamlFrontmatter = (content: string): string => {
  if (!content.startsWith('---')) {
    return content;
  }

  const frontmatterMatch = content.match(/^---\s*\n[\s\S]*?\n---\s*(\n|$)/);
  if (!frontmatterMatch) {
    return content;
  }
  return content.slice(frontmatterMatch[0].length);
};

/**
 * Format a last-success timestamp for prompt variable substitution.
 * Returns "Never" when the timestamp is absent.
 */
export const formatLastSuccessTimestamp = (timestamp: number | null | undefined): string => {
  if (timestamp == null) {
    return 'Never';
  }
  return `${new Date(timestamp).toISOString()} (UTC)`;
};

/**
 * Substitute prompt variables like `[LAST_EXECUTED_SUCCESS]`.
 */
export const substitutePromptVariables = (
  prompt: string,
  automation: { lastSuccessAt?: number | null },
): string => {
  return prompt.replace(
    /\[\s*LAST_EXECUTED_SUCCESS\s*\]/gi,
    formatLastSuccessTimestamp(automation.lastSuccessAt),
  );
};

/**
 * Sanitize a string value to prevent markdown/prompt injection.
 * Escapes characters that could break the context block structure.
 */
export const sanitizeContextValue = (value: unknown): string => {
  const str = String(value);
  // Truncate long values and escape potential markdown/injection patterns
  const truncated = str.length > 500 ? str.slice(0, 500) + '...' : str;
  // Escape newlines to prevent breaking out of the list format
  // Escape backticks to prevent code block injection
  return truncated
    .replace(/\n/g, ' ')
    .replace(/`/g, "'")
    .replace(/^#+\s/gm, ''); // Remove heading markers
};

/**
 * Inject event context into an automation prompt.
 * Appends a structured context block that the agent can reference.
 * Used for event-triggered automations (e.g., transcript-ready).
 *
 * Values are sanitized to prevent markdown/prompt injection from untrusted sources.
 */
export const injectEventContext = (prompt: string, context: Record<string, unknown>): string => {
  const contextLines = Object.entries(context)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        const sanitizedItems = value.map((item) => sanitizeContextValue(item));
        return `- ${key}: ${sanitizedItems.length > 0 ? sanitizedItems.join(', ') : '(none)'}`;
      }
      return `- ${key}: ${sanitizeContextValue(value)}`;
    })
    .join('\n');

  return `${prompt}

## Event Context

This automation was triggered by an event. The following context is available:

${contextLines}
`;
};

/**
 * Build the final automation prompt from raw file content.
 * Strips YAML frontmatter, substitutes variables, and optionally injects event context.
 */
export const buildAutomationPrompt = (
  rawContent: string,
  automation: { lastSuccessAt?: number | null },
  eventContext?: Record<string, unknown>,
): string => {
  const rawPrompt = stripYamlFrontmatter(rawContent).trimStart();
  let prompt = substitutePromptVariables(rawPrompt, automation);

  if (eventContext && Object.keys(eventContext).length > 0) {
    prompt = injectEventContext(prompt, eventContext);
  }

  return prompt;
};

/**
 * Normalize a model override string value.
 * Returns undefined for empty/non-string values.
 */
export const normalizeAutomationModelOverride = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};
