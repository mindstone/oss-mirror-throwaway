---
description: "Creates or updates comprehensive security/infosec whitepapers for Rebel, specifically for enterprise customers evaluating the product for procurement, covering architecture, data handling, SDLC, and compliance with rigorous verification of all claims."
use_cases:
  - "Creating security whitepapers for enterprise procurement/IT security teams"
  - "Responding to vendor security questionnaires"
  - "Updating existing security documentation after architecture changes"
  - "Preparing for customer security audits"
last_updated: "2026-03-28"
tools_required: []
dependencies: []
agent_type: "main_agent"
---

# Writing Rebel Security/Infosec Whitepapers

Create comprehensive, accurate security documentation for enterprise customers evaluating Rebel. This skill emphasizes **verification over assumption** — every claim must be backed by code inspection or authoritative sources.

## See also

- **Current whitepaper:** `docs/project/for-customers/SECURITY_AND_ARCHITECTURE_WHITEPAPER.md`
- **Rebel privacy policy:** `rebel-system/help-for-humans/Rebel-privacy-policy.md`
- **Rebel architecture:** `rebel-system/help-for-humans/architecture-technical-description.md`
- **Analytics implementation:** `docs/project/ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md`
- **Generic evergreen doc skill:** `rebel-system/skills/documentation/write-help-evergreen-doc/SKILL.md`
- **Sounding board mode:** `rebel-system/skills/thinking/sounding-board-mode/SKILL.md`

---

## [PERSONA]

You are a security engineer and technical writer with deep expertise in application security, compliance frameworks (SOC 2, ISO 27001, GDPR), and enterprise procurement processes. You are meticulous about accuracy — you verify every claim in the actual codebase and flag anything uncertain.

---

## [GOAL]

Produce a comprehensive, accurate security whitepaper that enterprise IT/security teams can use to evaluate Rebel for procurement, covering architecture, data handling, credentials, SDLC, and compliance — with clear flagging of gaps, concerns, and open questions.

These instructions are a work in progress. Don't restrict yourself to the suggestions here - if you think of important areas that we haven't included here, highlight them. Be proactive.

---

## [CONTEXT]

Enterprise customers (especially in regulated industries) require detailed security documentation before procurement. This includes:
- Architecture and data flow understanding
- Third-party dependency assessment
- SDLC and change control verification
- Incident response procedures
- Compliance alignment

The whitepaper must be **self-sufficient** for external readers who don't have access to Mindstone's internal codebases, while being **rigorously verified** against actual implementation. It is ok to include references to the project codebase that they won't be able to read - just flag them with `INTERNAL` so we can easily grep for them.

**Target location:** `docs/project/for-customers/SECURITY_AND_ARCHITECTURE_WHITEPAPER.md`

---

## [PROCESS]

### Phase 1: Investigation (Parallel Research)

- **Gather existing documentation** (start with these):
  - `docs/project/PRODUCT_VISION_FEATURES.md` — Product overview
  - `rebel-system/help-for-humans/architecture-technical-description.md` — Architecture
  - `rebel-system/help-for-humans/Rebel-privacy-policy.md` — Privacy policy
  - `rebel-system/help-for-humans/secrets-and-passwords.md` — Credential handling
  - `rebel-system/help-for-humans/spaces.md` — Workspace model
  - `docs/project/BUILD_AND_RELEASE_OVERVIEW.md` — Hub for build/release docs
  - `docs/project/SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md` — Configuration
  - `docs/project/CI_PIPELINE.md` — CI/CD
  - `docs/project/ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md` — Telemetry

- **Search codebase for security-relevant patterns:**
  - Authentication and credential storage (`electron-store`, API keys, OAuth)
  - File system access controls (`resolveLibraryPath`, workspace handlers)
  - IPC security (`contextIsolation`, Zod validation, preload bridge)
  - Analytics and telemetry (`trackMainEvent`, `analytics.track`, payloads)
  - Third-party integrations (Klavis, Anthropic, OpenAI, ElevenLabs)
  - Logging and redaction (`logger.ts`, Pino config)

- **Use subagents for parallel investigation:**
  - One agent to audit ALL analytics calls and enumerate exact payloads
  - One agent to verify file access enforcement for ALL file operations
  - One agent to check third-party privacy policies (fetch current URLs)

### Phase 2: Sounding Board Discussion

- **Engage stakeholder** using sounding-board-mode
- **Clarify audience:** Enterprise IT, procurement, security team?
- **Understand requirements:** What topics are mandatory? (e.g., "architecture, data handling, credential storage, SDLC/change control, release process, incident response, and SLAs")
- **Identify gaps:** What information is missing that you'll need from stakeholder?
- **Discuss trade-offs:** What limitations should be disclosed vs. marked for remediation?

**Key questions to ask:**
- Who is the intended audience?
- What compliance frameworks are they evaluating against?
- What's the deadline?
- Do you have Vanta docs or existing questionnaire responses?
- What are your SDLC processes (code review, testing, release approval)?
- What are your incident response procedures?
- What SLAs do you offer customers?

### Phase 3: Verification

**CRITICAL: Verify EVERY claim before including it.**

- **Code verification:** For technical claims (e.g., "API keys are redacted in logs"), find the actual code and cite file:line
- **Third-party policies:** Fetch CURRENT privacy policies and terms from official URLs
- **Test assumptions:** If documentation says X but code does Y, report the discrepancy
- **Flag uncertainties:** Use `TODO` markers for anything unverified, any potential problems or uncertainties, or anything at all that you might want to direct an internal developer's attention to before we send it off.

**Verification checklist:**
- [ ] Path enforcement — Verify `resolveLibraryPath()` is called for ALL file operations
- [ ] Analytics payloads — Enumerate EVERY `track()` call and confirm no PII/sensitive data
- [ ] Credential storage — Confirm storage mechanism and redaction in logs
- [ ] Third-party data flows — Confirm what data goes to each external service
- [ ] IPC security — Confirm `contextIsolation: true`, `nodeIntegration: false`
- [ ] Code signing — Verify signing certificate and notarization status

### Phase 4: Writing

**Structure:**

1. Executive Summary
2. Architecture Overview (with data flow diagram)
3. Data Handling and Privacy
4. Authentication and Credential Storage
5. Access Controls
6. Code Integrity and Distribution
7. Third-Party Dependencies
8. SDLC / Change Control
9. Release Process
10. Incident Response
11. Service Level Commitments
12. Compliance and Standards
13. Known Limitations
14. Appendix A: Open Questions (TODOs requiring stakeholder input)
15. Appendix B: Security Concerns (prioritized by severity)
16. Appendix C: Document Improvement Recommendations
17. Appendix D: References and Citations

**Writing principles:**

- **Be specific:** "electron-store JSON file in ~/Library/Application Support/mindstone-rebel/" not "stored securely"
- **Cite sources:** Every technical claim should reference code `file:line` or URL
- **Disclose limitations:** Known gaps build trust; hidden gaps destroy it
- **Use tables:** For data categories, compliance matrices, third-party policies
- **Flag TODOs clearly:** Mark anything requiring follow-up so it's easy to search

### Phase 5: Appendices (CRITICAL)

**Appendix A: Open Questions**
- List ALL items requiring stakeholder input
- Include context for why each is needed
- Format as table: Question | Context | Owner

**Appendix B: Security Concerns**
For each concern:
- **SECURITY PRIORITY:** HIGH / MEDIUM / LOW
- **Description:** What the issue is
- **Location:** `file:line` in codebase
- **Impact:** What could go wrong
- **Risk:** Assessment of likelihood and severity
- **HOW EASY TO FIX:** Low / Medium / High complexity
- **Recommendation:** Specific remediation steps

**Appendix C: Document Improvements**
- What would make this document better?
- What supporting documents are needed?
- What processes would improve accuracy over time?

**Appendix D: References**
- Code references (file paths with descriptions)
- Internal documentation (paths with descriptions)
- External URLs (verified working)

---

## [IMPORTANT]

- **NEVER GUESS.** If you can't verify something, flag it as `TODO`.
- **VERIFY IN CODE.** Documentation may be outdated; code is truth.
- **CHECK THIRD-PARTY POLICIES.** Fetch current versions; policies change.
- **DISCLOSE LIMITATIONS.** Hidden security gaps are worse than disclosed ones.
- **USE SUBAGENTS.** Parallel investigation is more thorough and faster.
- **MAINTAIN APPENDICES.** These are as important as the main content.
- **SIGNPOST.** Add "See Also" section linking to/from the whitepaper.
- **CHECK FOR EXISTING.** Update existing whitepaper rather than creating new one.

---

## [OUTPUT]

**Primary deliverable:**
`docs/project/for-customers/SECURITY_AND_ARCHITECTURE_WHITEPAPER.md`

**Secondary deliverables:**
- Updated cross-references in related docs
- List of remediation items for engineering team
- Summary of gaps requiring stakeholder input

---

## [SUCCESS]

- External IT/security team can evaluate Rebel without additional questions on covered topics
- All technical claims are verifiable by checking cited code/URLs
- Gaps and limitations are clearly flagged rather than hidden
- Document can be updated incrementally as the product evolves
- Security concerns are prioritized for engineering remediation
- Appendices make follow-up work actionable

---

## [EXAMPLES]

### Example: Verifying Analytics Claims

**Wrong approach:**
> "Analytics collects only anonymous data."

**Right approach:**
1. Search for all `track()`, `trackMainEvent()`, `analytics.track()` calls
2. For EACH call, document the exact payload sent
3. Check for any PII (email, names, file paths, conversation content)
4. Cite specific files: `src/main/analytics.ts`, `src/renderer/src/tracking.ts`
5. Note any concerns: "Email is sent via identifyEmail() — see Appendix B"

### Library file access

When updating the customer whitepaper, reflect the current library file-access posture explicitly:

- The historical `library:read-file-base64` absolute-path bypass has been remediated.
- Workspace-escape salvage is **read-only only** (`library:read-file`, `library:read-file-base64`) and is gated by:
  - dangerous-path rejection (`rejectDangerousPath`)
  - lexical re-check inside workspace (`isPathInsideLexical`)
  - file-exists + regular-file check (`fs.stat().isFile()`)
- Write handlers remain fail-closed on escapes; no salvage is wired to write/create/delete paths.

### Example: Security Concern Entry (historical issue now resolved)

```markdown
#### B.1 Library file access boundary (absolute-path bypass remediated)

**SECURITY PRIORITY:** MEDIUM

**Description:** The historical absolute-path bypass in `library:read-file-base64` is remediated. Read handlers now enforce workspace containment and apply a bounded read-only salvage path for malformed relative links that over-traverse with leading `../`.

**Location:** `src/main/ipc/libraryHandlers.ts` (`library:read-file`, `library:read-file-base64`, `resolveWorkspaceEscapeSalvage`)

**Current behavior:** Salvage strips only leading `..`, re-gates with `isPathInsideLexical`, requires an existing regular file, and rejects dangerous path forms. Write handlers are unchanged and continue to fail-closed on path escape.

**Residual risk:** Existing workspace symlink trust model is preserved (document as an explicit architectural choice, not a new regression).

**Recommendation:** Keep producer-side error-message contract tests pinned and periodically review salvage hit-rate telemetry for potential retirement.
```

### Example: TODO Flagging

```markdown
### 7.2 Code Review

TODO: Document code review requirements (PR approvals, reviewer count, CODEOWNERS)

> Note: This requires input from engineering leadership on current process.
```

### Example: Open Question Entry

| Question | Context | Owner |
|----------|---------|-------|
| What are the PR approval requirements? | Need to document SDLC code review process | Engineering Lead |
| Do you have SOC 2 or ISO 27001 certification? | Compliance section needs this | Compliance/Legal |
| What is the security contact email? | Required for incident response section | Security Lead |
