const BUILD_CUSTOM_MCP_SKILL_PATH = 'rebel-system/skills/coding/build-custom-mcp-server/SKILL.md';
const EXTEND_MCP_SKILL_PATH = 'rebel-system/skills/coding/extend-mcp-server/SKILL.md';

const BUILD_CUSTOM_MCP_SKILL_SEED = `@\`${BUILD_CUSTOM_MCP_SKILL_PATH}\``;
const EXTEND_MCP_SKILL_SEED = `@\`${EXTEND_MCP_SKILL_PATH}\``;

// Seed text for the CTA-driven entry points into the OSS MCP build/extend flows.
// The skill mention is paired with an explicit "Follow ... to understand the
// requirements and guide me through setup" instruction so Rebel treats the
// referenced SKILL.md as the procedure to follow, not just a file to discuss.
// Previously the prompts relied on the bare `@SKILL.md` mention implying
// execution, which some models interpreted as "discuss this artifact first"
// and skipped the Phase 0 build-vs-buy flow. See FOX-3172.

export function buildOssMcpEntryPointBuildPrompt(searchQuery?: string): string {
  const trimmedQuery = searchQuery?.trim();
  const intent = trimmedQuery
    ? `I want to build a new connector for "${trimmedQuery}".`
    : `I want to build a new connector.`;
  // FOX-3172: intent first, imperative second. Do NOT collapse back to the bare
  // `${SEED} <intent>` shape — bare mentions are read as reference, not directive.
  return `${intent} Follow ${BUILD_CUSTOM_MCP_SKILL_SEED} to understand the requirements and guide me through setup.`;
}

export function buildOssMcpEntryPointExtendPrompt(connectorName: string, connectorId?: string): string {
  const trimmedConnectorId = connectorId?.trim();
  const connectorReference = trimmedConnectorId
    ? `"${connectorName}" connector (ID: ${trimmedConnectorId})`
    : `"${connectorName}" connector`;

  // FOX-3172: intent first, imperative second. Do NOT collapse back to the bare
  // `${SEED} <intent>` shape — bare mentions are read as reference, not directive.
  return `I want to add more tools to the ${connectorReference}. Follow ${EXTEND_MCP_SKILL_SEED} to understand the requirements and guide me through it.`;
}

// Seed text for the "share with community" CTA on the Settings connector card.
// Kept in this module (not inline in App.tsx) so all OSS-MCP seed copy has a
// single source of truth.
export function buildOssMcpEntryPointSharePrompt(connectorName: string): string {
  // FOX-3172: intent first, imperative second. Do NOT collapse back to the bare
  // `${SEED} <intent>` shape — bare mentions are read as reference, not directive.
  return `I have an existing connector called "${connectorName}" that I'd like to share with the community. Follow ${BUILD_CUSTOM_MCP_SKILL_SEED} to understand the requirements and guide me through it.`;
}
