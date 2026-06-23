# Tool Display Config Review - Edge Cases & Regressions

**Date**: 2026-02-09  
**Reviewer**: QA/Regression Reviewer  
**Scope**: Tool display configuration changes in approval UI

## Summary

Reviewed changes adding `TOOL_DISPLAY_CONFIG` mapping, `isGenericReason()` detection, and `getToolFallbackSubtitle()` for tool-specific fallbacks. Found **6 edge cases** requiring fixes, with severity ratings below.

---

## Edge Cases Found

### 🔴 CRITICAL: Missing Display Configs for Jargon Tools

**Issue**: Tools in `JARGON_TOOL_NAMES` but missing from `TOOL_DISPLAY_CONFIG` get poor UX:
- Header: Falls through to "Action needs your OK" (acceptable fallback)
- Subtitle: `getToolFallbackSubtitle()` returns `null` → **no subtitle shown** (empty description)

**Affected tools**: `shell`, `cmd`, `powershell`, `terminal`, `subprocess`, `exec`, `run`, `spawn`

**Location**: `src/renderer/components/approval/utils.ts:79-83`

**Impact**: Users see approval cards with no description/subtitle, making it unclear what the tool does.

**Fix**: Add display configs for missing jargon tools:

```typescript
const TOOL_DISPLAY_CONFIG: Record<string, ToolDisplayConfig> = {
  // ... existing entries ...
  'shell': {
    header: 'Rebel wants to work on your computer',
    subtitle: 'Part of completing what you asked — runs on your device',
    friendlyName: 'Local task',
  },
  'cmd': {
    header: 'Rebel wants to work on your computer',
    subtitle: 'Part of completing what you asked — runs on your device',
    friendlyName: 'Local task',
  },
  'powershell': {
    header: 'Rebel wants to work on your computer',
    subtitle: 'Part of completing what you asked — runs on your device',
    friendlyName: 'Local task',
  },
  'terminal': {
    header: 'Rebel wants to work on your computer',
    subtitle: 'Part of completing what you asked — runs on your device',
    friendlyName: 'Local task',
  },
  'subprocess': {
    header: 'Rebel wants to work on your computer',
    subtitle: 'Part of completing what you asked — runs on your device',
    friendlyName: 'Local task',
  },
  'exec': {
    header: 'Rebel wants to work on your computer',
    subtitle: 'Part of completing what you asked — runs on your device',
    friendlyName: 'Local task',
  },
  'run': {
    header: 'Rebel wants to work on your computer',
    subtitle: 'Part of completing what you asked — runs on your device',
    friendlyName: 'Local task',
  },
  'spawn': {
    header: 'Rebel wants to work on your computer',
    subtitle: 'Part of completing what you asked — runs on your device',
    friendlyName: 'Local task',
  },
};
```

**Severity**: 🔴 **CRITICAL** - Empty subtitles degrade UX significantly

---

### 🟡 MODERATE: `isGenericReason()` False Positives

**Issue**: `isGenericReason()` uses `startsWith()` checks that could match legitimate LLM-generated reasons:

```typescript
lower.startsWith('rebel couldn\'t verify') ||
lower.startsWith('rebel wants to use a tool')
```

**Potential false positives**:
- "Rebel couldn't verify the safety of this operation, but here's why it's needed: ..."
- "Rebel wants to use a tool to help you with this task: ..."

**Location**: `src/renderer/components/approval/utils.ts:128-140`

**Impact**: Legitimate descriptive reasons get replaced with generic fallback subtitles, losing context.

**Fix**: Use exact string matching or more specific patterns:

```typescript
export function isGenericReason(reason: string | undefined): boolean {
  if (!reason) return true;
  const lower = reason.toLowerCase().trim();
  
  // Exact matches for backend-generated generic reasons
  const exactMatches = [
    'requires your approval to continue',
    'needs your ok to continue',
    'action needs your ok',
    'risk assessment complete',
  ];
  if (exactMatches.includes(lower)) return true;
  
  // More specific patterns - only match if reason is SHORT (likely generic)
  // Generic reasons are typically < 50 chars, legitimate ones are longer
  if (reason.length < 50) {
    if (lower.startsWith('unable to verify safety')) return true;
    if (lower.startsWith('rebel couldn\'t verify') && reason.length < 80) return true;
    if (lower.startsWith('rebel wants to use a tool') && reason.length < 60) return true;
  }
  
  return false;
}
```

**Severity**: 🟡 **MODERATE** - Could hide useful context, but fallback exists

---

### 🟡 MODERATE: `extractServiceFromReason()` False Positives

**Issue**: Service extraction now runs for ALL tools (not just "Task"), causing false matches:
- "linear regression" → matches "Linear" (project management tool)
- "github actions" → matches "GitHub" (correct, but could be ambiguous)
- "slack off" → matches "Slack" (messaging tool)

**Location**: 
- `src/renderer/components/approval/utils.ts:186-196` (extractServiceFromReason)
- `src/renderer/features/agent-session/components/PendingReviewBar.tsx:472` (getSourceLabel)
- `src/renderer/features/agent-session/components/PendingReviewBar.tsx:1173` (getHeaderLabel)

**Impact**: Incorrect service labels in approval headers (e.g., "Allow Linear?" for a data analysis tool).

**Fix**: Add word boundary checks and context awareness:

```typescript
export function extractServiceFromReason(reason: string | undefined): string | null {
  if (!reason) return null;

  // Use word boundaries to avoid false matches
  // Match "Linear" but not "linear regression" or "non-linear"
  for (const { pattern, name } of SERVICE_PATTERNS) {
    // Check if pattern matches with word boundaries
    const wordBoundaryPattern = new RegExp(
      `\\b${pattern.source.replace(/^\/|\/i?$/g, '')}\\b`,
      pattern.flags.includes('i') ? 'i' : ''
    );
    if (wordBoundaryPattern.test(reason)) {
      return name;
    }
  }

  return null;
}
```

**Note**: The regex patterns already use `\b` word boundaries, but some patterns like `/\blinear\b/i` will still match "linear regression". Consider:
1. Making patterns more specific (e.g., `/\blinear\s+(?:api|app|tool|service)\b/i`)
2. Adding negative lookahead for common false-positive contexts
3. Only running extraction for "Task" tool (revert to original behavior)

**Severity**: 🟡 **MODERATE** - Wrong labels but not breaking functionality

---

### 🟢 MINOR: MCP Prefixed Tools Not in Jargon Check

**Issue**: Tools like `mcp__some_tool__action` get cleaned by `getCleanActionName()` (removes `mcp__` prefix), but `isJargonToolName()` checks the **original** `toolName` before cleaning.

**Location**: 
- `src/renderer/features/agent-session/components/PendingReviewBar.tsx:1190` - checks `isJargonToolName(item.data.toolName)` on original name
- `src/renderer/features/agent-session/components/PendingReviewBar.tsx:146-164` - `getCleanActionName()` cleans the name

**Impact**: If an MCP tool's cleaned name is jargon (e.g., `mcp__something__execute` → `execute`), it won't be detected as jargon and will show the cleaned name instead of falling back to "Action needs your OK".

**Fix**: Check jargon on cleaned name OR add MCP prefix handling to jargon detection:

```typescript
// Option 1: Check cleaned name
const cleanedName = getCleanActionName(item.data);
if (cleanedName && cleanedName !== 'Unknown' && !isJargonToolName(cleanedName)) {
  return `Allow ${cleanedName}?`;
}

// Option 2: Add MCP prefix handling to isJargonToolName
export function isJargonToolName(toolName: string): boolean {
  const cleaned = toolName.replace(/^mcp__[^_]+__/i, '').toLowerCase();
  return JARGON_TOOL_NAMES.has(cleaned) || JARGON_TOOL_NAMES.has(toolName.toLowerCase());
}
```

**Severity**: 🟢 **MINOR** - Edge case, unlikely to occur in practice

---

### 🟢 MINOR: MCP Tools Without PackageName Fallback

**Issue**: MCP tools without `packageName` and not in jargon list (e.g., `web_scrape`) rely on `getCleanActionName()` which may produce unclear names.

**Example**: `mcp__some_service__web_scrape` → cleaned to "Web Scrape" → header "Allow Web Scrape?" (acceptable but generic)

**Location**: `src/renderer/features/agent-session/components/PendingReviewBar.tsx:1189-1192`

**Impact**: Acceptable fallback behavior, but could be improved with better name cleaning or MCP-specific handling.

**Fix**: Consider adding MCP-specific name formatting:

```typescript
function getCleanActionName(request: ToolApprovalRequest): string {
  const { toolName, input } = request;
  
  // Try to get tool_id from input (for router calls)
  const toolId = input?.tool_id as string | undefined;
  
  if (toolId) {
    // Remove package prefix if present
    const cleanToolId = toolId.includes('__') 
      ? toolId.split('__').pop() ?? toolId
      : toolId;
    return toTitleCase(cleanToolId);
  }
  
  // For MCP tools, extract action name more intelligently
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    if (parts.length >= 3) {
      // mcp__package__action → "Action"
      return toTitleCase(parts[parts.length - 1]);
    }
  }
  
  // Fallback: clean up the tool name
  const cleaned = toolName
    .replace(/^mcp__/i, '')
    .replace(/__/g, ' · ');
  return toTitleCase(cleaned);
}
```

**Severity**: 🟢 **MINOR** - Acceptable behavior, minor UX improvement possible

---

### 🟢 MINOR: Inconsistent Jargon Detection Order

**Issue**: `getHeaderLabel()` checks `isJargonToolName()` AFTER calling `getCleanActionName()`, but `getCleanActionName()` may have already cleaned an MCP tool name. The jargon check should happen on the cleaned name.

**Location**: `src/renderer/features/agent-session/components/PendingReviewBar.tsx:1189-1190`

**Current flow**:
1. Get cleaned action name: `getCleanActionName(item.data)` → "Execute"
2. Check if original tool name is jargon: `isJargonToolName(item.data.toolName)` → false (because original is `mcp__something__execute`)
3. Show "Allow Execute?" (should show "Rebel wants to work on your computer")

**Fix**: Check jargon on cleaned name:

```typescript
const actionName = getCleanActionName(item.data);
if (actionName && actionName !== 'Unknown') {
  // Check if cleaned name is jargon
  const isJargon = isJargonToolName(actionName) || isJargonToolName(item.data.toolName);
  if (!isJargon) {
    return `Allow ${actionName}?`;
  }
}
```

**Severity**: 🟢 **MINOR** - Edge case, unlikely to cause issues

---

## Recommendations

### Priority 1 (Critical)
1. ✅ **Add display configs for missing jargon tools** (`shell`, `cmd`, `powershell`, `terminal`, `subprocess`, `exec`, `run`, `spawn`)

### Priority 2 (Moderate)
2. ✅ **Improve `isGenericReason()` specificity** - Use length checks or exact matching to avoid false positives
3. ✅ **Fix `extractServiceFromReason()` false positives** - Add word boundary checks or revert to Task-only extraction

### Priority 3 (Minor)
4. ⚠️ **Handle MCP prefix in jargon detection** - Check cleaned names, not just original
5. ⚠️ **Improve MCP tool name cleaning** - Better extraction of action names from MCP prefixed tools
6. ⚠️ **Fix jargon detection order** - Check cleaned name, not original

---

## Testing Recommendations

1. **Test missing jargon tools**: Create approvals for `shell`, `cmd`, `powershell`, `terminal` → verify subtitle appears
2. **Test false positive reasons**: Use LLM-generated reasons starting with "Rebel couldn't verify" but >80 chars → verify reason is shown, not fallback
3. **Test service extraction**: Create tool with reason "performing linear regression analysis" → verify doesn't match "Linear"
4. **Test MCP tools**: Create `mcp__something__execute` → verify shows "Rebel wants to work on your computer", not "Allow Execute?"

---

## Conclusion

The changes improve tool display UX significantly, but **critical gaps** exist for missing jargon tool configs. The moderate issues (false positives) should be addressed to prevent confusion. Minor issues are edge cases that can be handled incrementally.

**Overall Assessment**: ✅ **Good foundation, needs fixes for production readiness**
