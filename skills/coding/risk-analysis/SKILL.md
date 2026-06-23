---
name: risk-analysis
description: "Deep risk analysis for code changes. Systematically evaluates potential regressions, edge cases, cross-platform issues, and unintended consequences before implementation. Asks the model to slow down and think through all codepaths, configurations, and failure modes."
last_updated: 2026-02-12
tools_required: []
agent_type: main_agent
---

# RISK_ANALYSIS

Systematic risk analysis for proposed code changes. Use this skill to surface unintended consequences, regressions, and edge cases **before** committing to an implementation.


## See Also

- [pre-implementation-feature-check](../pre-implementation-feature-check/SKILL.md) - pre-flight checks for duplicate work and feature rationale
- [sounding-board-mode](../../../rebel-system/skills/thinking/sounding-board-mode/SKILL.md) - structured discussion of approach and alternatives
- [devils-advocate](../../../rebel-system/skills/thinking/devils-advocate/SKILL.md) - stress-testing assumptions


## When to Use

- Before implementing a fix or feature that touches shared infrastructure
- When a change modifies validation, serialization, or data flow logic
- When introducing new defaults, fallbacks, or silent error handling
- When changing behavior that downstream consumers depend on
- When the blast radius of a change is unclear
- When working on cross-platform code (macOS, Windows, Linux)
- When modifying configuration schemas, API contracts, or IPC channels


## Process

**IMPORTANT**: Take your time with this analysis. Do not rush. Trace every codepath. Consider every consumer. Think about users on different machines, OS versions, network conditions, and configurations. The goal is to find problems *before* they reach users.


### Phase 1: Understand the Change Surface

Before assessing risk, build a complete picture of what the change touches.

1. **Identify the exact change**: What code is being added, modified, or removed? Get specific -- file paths, function names, line ranges.

2. **Map all callers and consumers**: Trace every place the modified code is called from. Use grep/search to find:
   - Direct function/method calls
   - Import references
   - IPC channel consumers (both main and renderer)
   - Config files that reference the changed behavior
   - Tests that exercise the changed codepaths

3. **Identify the data flow**: Trace data through the change:
   - What inputs does the modified code receive? What shapes/types can they have?
   - What outputs does it produce? Who consumes those outputs?
   - Are there intermediate transformations (serialization, parsing, normalization)?
   - Does the data cross process boundaries (main <-> renderer, main <-> MCP)?

4. **Check for implicit contracts**: Look for undocumented assumptions:
   - Does anything depend on the current error behavior (catching specific error codes/messages)?
   - Are there side effects that consumers rely on (logging, metrics, state mutations)?
   - Does the change affect timing or ordering guarantees?


### Phase 2: Systematic Risk Assessment

Work through each category below. For every risk identified, assign a severity and likelihood.

**Severity scale**: CRITICAL (data loss, security hole, app crash) | HIGH (feature broken, user-facing error) | MEDIUM (degraded experience, misleading behavior) | LOW (cosmetic, minor inconvenience)

**Likelihood scale**: CERTAIN (will happen) | LIKELY (probable in normal use) | POSSIBLE (edge case but realistic) | UNLIKELY (requires unusual conditions)


#### 2a. Regression Risks

- [ ] Does the change break any existing tests? Run them and check.
- [ ] Does it change the return type, shape, or semantics of any function?
- [ ] Does it change error handling behavior (different exceptions, swallowed errors, new error paths)?
- [ ] Does it change the default behavior for existing users who haven't changed their settings?
- [ ] Could it break backward compatibility with persisted data (stored configs, cached state, databases)?
- [ ] Does it affect any migration paths or version upgrade flows?


#### 2b. Cross-Platform Risks

- [ ] Does the change involve file paths, separators, or filesystem operations? (Windows uses `\`, macOS/Linux use `/`)
- [ ] Does it spawn processes or use shell commands? (Windows has different shell semantics)
- [ ] Does it depend on OS-specific APIs, permissions, or capabilities? (Keychain vs Credential Manager vs keyring)
- [ ] Does it assume specific environment variables or directory structures? (`HOME` vs `USERPROFILE`, `~/.config` vs `AppData`)
- [ ] Does it handle symlinks? (Windows requires elevated privileges for symlinks)
- [ ] Does it deal with file locking or concurrent access? (Different OS behaviors)
- [ ] Does it assume case-sensitive or case-insensitive filesystem? (macOS is case-insensitive by default, Linux is case-sensitive)


#### 2c. Configuration & Environment Risks

- [ ] How does this behave with default settings vs customized settings?
- [ ] What happens if a required config value is missing, empty, or malformed?
- [ ] Does this interact with feature flags or experimental settings?
- [ ] What happens behind a proxy, VPN, or restrictive firewall?
- [ ] Does this behave differently in dev mode vs production build?
- [ ] Does this affect first-run experience differently from existing users?
- [ ] Are there locale/timezone/encoding assumptions? (UTF-8, date formats, number formats)


#### 2d. Concurrency & Timing Risks

- [ ] Can this code be called concurrently? If so, is it safe?
- [ ] Are there race conditions between this change and async operations?
- [ ] Does it depend on ordering of events that isn't guaranteed?
- [ ] What happens if the operation is interrupted (app quit, network drop, process crash)?
- [ ] What happens if it's called during app startup before other services are ready?
- [ ] What happens if it's called during app shutdown?


#### 2e. Data Integrity Risks

- [ ] Can this change cause silent data loss? (Stripping fields, truncating, overwriting)
- [ ] Can it cause silent data corruption? (Wrong types, encoding issues, partial writes)
- [ ] Does it affect data that users can't easily recover? (Conversations, settings, credentials)
- [ ] Does it change what gets logged or reported? (Lost diagnostics, missing breadcrumbs)
- [ ] Does it affect any audit trail or forensic capability?


#### 2f. Security & Privacy Risks

- [ ] Does the change expose new data to logs, error messages, or external services?
- [ ] Does it change permission boundaries or trust levels?
- [ ] Does it introduce new network calls or endpoints?
- [ ] Could it be exploited by a malicious MCP server or tool?
- [ ] Does it handle user secrets, tokens, or credentials?


#### 2g. Performance Risks

- [ ] Does it add work to a hot path (per-message, per-keystroke, per-render)?
- [ ] Does it increase memory usage (caching, buffering, accumulating)?
- [ ] Does it add network calls or disk I/O to a latency-sensitive path?
- [ ] Could it cause O(n^2) or worse behavior with large inputs?


#### 2h. Downstream & Integration Risks

- [ ] Does the change affect behavior visible to MCP servers or external tools?
- [ ] Does it change what Claude (the model) sees in tool results or error messages?
- [ ] Could it affect the model's behavior indirectly? (Different error messages may change retry patterns)
- [ ] Does it affect any API contracts with external services?
- [ ] Could it break CI/CD pipelines or automated testing?


### Phase 3: Edge Case Exploration

For the specific change being analyzed, enumerate concrete edge cases:

1. **Boundary values**: Empty strings, null/undefined, zero-length arrays, maximum-size inputs
2. **Missing data**: What if a field that's usually present is absent?
3. **Malformed data**: What if the input is the wrong type, has unexpected nesting, or contains special characters?
4. **Partial failures**: What if the operation succeeds partially (e.g., 3 of 5 items processed)?
5. **Stale state**: What if cached data is outdated or references deleted resources?
6. **Version skew**: What if the client and server are on different versions?


### Phase 4: Mitigation Assessment

For each identified risk:

1. **Can it be prevented?** (Schema validation, type narrowing, guard clauses)
2. **Can it be detected?** (Logging, monitoring, error reporting)
3. **Can it be recovered from?** (Retry logic, fallback behavior, user intervention)
4. **Can it be tested?** (Unit test, integration test, manual verification)


## Output Format

```markdown
## Risk Analysis: [Change Description]

### Change Summary
[1-3 sentence description of what's being changed and why]

### Change Surface
- Files modified: [list]
- Callers/consumers: [list]
- Data flow: [brief description]

### Risks Identified

#### [Risk Title] — Severity: [X] | Likelihood: [X]
**What**: [Description of the risk]
**How it manifests**: [Concrete scenario where this causes a problem]
**Who is affected**: [Which users/configurations/platforms]
**Mitigation**: [How to prevent or handle this]
**Test coverage**: [How to verify the mitigation works]

[Repeat for each risk]

### Edge Cases
| Scenario | Expected Behavior | Risk |
|----------|-------------------|------|
| [case]   | [what should happen] | [what could go wrong] |

### Recommendation
[SAFE TO PROCEED / PROCEED WITH MITIGATIONS / NEEDS REDESIGN / STOP]

**If PROCEED WITH MITIGATIONS:**
1. [Specific mitigation to implement before or alongside the change]
2. [Specific test to add]
3. [Specific monitoring to enable]

**If NEEDS REDESIGN:**
[Explain why and suggest alternative approaches]

### Residual Risk
[What risks remain even after mitigations? Are they acceptable?]
```


## Anti-Patterns to Watch For

These patterns frequently cause unintended consequences:

1. **Silent fallbacks**: Catching errors and returning defaults. The caller never knows something went wrong. Bugs hide for weeks.
2. **Global behavior changes**: Modifying a shared utility, validator, or config parser. Every consumer is affected.
3. **In-place mutation**: Modifying objects that other code holds references to. Side effects propagate unpredictably.
4. **Stripping data before logging**: You fix the immediate error but lose the ability to diagnose the root cause.
5. **Changing error messages**: Downstream code (including AI models) may match on error text. Changing messages changes behavior.
6. **Implicit ordering dependencies**: Assuming services initialize in a specific order, events fire in sequence, or promises resolve in order.
7. **Platform-specific defaults**: Using `os.homedir()` or `path.sep` correctly in one place but hardcoding `/` or `~` in another.
8. **Feature flag interactions**: A change that's safe when a flag is off but breaks when the flag is on (or vice versa).


## Important

- **Trace the full codepath, not just the immediate change.** Most regressions happen two or three hops away from the modified code.
- **Think about users who aren't like you.** Different OS, different locale, different settings, different MCP servers, first-time users vs power users.
- **Consider the temporal dimension.** What happens on first run after upgrade? What about data created by old code but read by new code?
- **Don't dismiss unlikely risks if the severity is critical.** A 5% chance of data loss is not acceptable.
- **When in doubt, flag it.** It's better to surface a risk that turns out to be a non-issue than to miss one that causes a regression.
