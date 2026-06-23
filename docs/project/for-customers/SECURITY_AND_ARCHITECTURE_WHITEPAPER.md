---
description: "Customer-facing security and architecture whitepaper — local-first model, data handling, auth, access controls, compliance, known gaps"
last_updated: "2026-05-03"
---

# Mindstone Rebel: Security and Architecture Whitepaper

> **⚠️ UPDATE REQUIRED (Jan 2026):** This whitepaper references Klavis, which has been removed from Rebel. External tool access (Gmail, Slack, etc.) now uses **bundled MCP servers running locally** — tokens stay on the user's device, not third-party servers. This document needs updating to reflect the new architecture. See `docs/project/KLAVIS_TO_BUNDLED_MCP_MIGRATION.md` for details.

**Version:** 1.0
**Date:** 2025-12-04
**Classification:** Customer / Enterprise Procurement
**Maintainer:** Mindstone Learning Limited

---

## See Also

- **Skill for creating/updating this document:** `docs/project/WRITE_SECURITY_WHITEPAPER.md`
- **User-facing privacy policy:** `rebel-system/help-for-humans/Rebel-privacy-policy.md`
- **Technical architecture:** `rebel-system/help-for-humans/architecture-technical-description.md`

Mindstone security contact: `security@mindstone.com`

---

## Executive Summary

Mindstone Rebel is a local-first, voice-enabled AI assistant desktop application for macOS and Windows, with Linux support in beta. It connects to AI model providers (primarily Anthropic's Claude) and integrates with external tools via the Model Context Protocol (MCP).

**Key security characteristics:**

- **Local-first architecture**: User conversations, files, and session history are stored on the user's device. Mindstone does not operate a backend that processes or stores user content.
- **Direct API connections**: The app connects directly to AI providers (Anthropic, OpenAI, ElevenLabs) using API keys provided by the user.
- **MCP gateway integration**: External tool access (Gmail, Slack, etc.) routes through Klavis.ai, a third-party MCP gateway with SOC 2 Type 2 certification.
- **Workspace-scoped file access**: File operations are primarily scoped to a user-selected workspace directory by default, with some documented exceptions (see §4.1).
- **Code-signed distribution**: Builds are signed with a Developer ID certificate from Mindstone Learning Limited.

This document provides a comprehensive overview of the application's architecture, data handling practices, security controls, and development processes for enterprise security evaluation.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Data Handling and Privacy](#2-data-handling-and-privacy)
3. [Authentication and Credential Storage](#3-authentication-and-credential-storage)
4. [Access Controls](#4-access-controls)
5. [Code Integrity and Distribution](#5-code-integrity-and-distribution)
6. [Third-Party Dependencies](#6-third-party-dependencies)
7. [Software Development Lifecycle (SDLC)](#7-software-development-lifecycle-sdlc)
8. [Release Process](#8-release-process)
9. [Incident Response](#9-incident-response)
10. [Service Level Commitments](#10-service-level-commitments)
11. [Compliance and Standards](#11-compliance-and-standards)
12. [Known Limitations](#12-known-limitations)
13. [Appendix A: Open Questions](#appendix-a-open-questions)
14. [Appendix B: Security Concerns](#appendix-b-security-concerns)
15. [Appendix C: Document Improvement Recommendations](#appendix-c-document-improvement-recommendations)
16. [Appendix D: References and Citations](#appendix-d-references-and-citations)

---

## 1. Architecture Overview

### 1.1 Application Model

Mindstone Rebel is an Electron-based desktop application with a multi-process architecture:

| Process | Role | Security Boundary |
|---------|------|-------------------|
| **Main** | Node.js process handling system operations, IPC, file access, and external API calls | Privileged; has full Node.js capabilities |
| **Renderer** | Chromium-based process running the React UI | Sandboxed via context isolation; no direct Node.js access |
| **Preload** | Bridge script exposing typed APIs to the renderer | Minimal surface area; validates all IPC calls |

**Electron security configuration:**
- `contextIsolation: true` — Renderer cannot access Node.js globals directly
- `nodeIntegration: false` — Renderer has no Node.js APIs
- `sandbox: false` — See [Known Limitations](#12-known-limitations)

> **Citation:** Electron security model documented at [electronjs.org/docs/latest/tutorial/security](https://www.electronjs.org/docs/latest/tutorial/security)

### 1.2 Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER'S DEVICE                                   │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────────────┐  │
│  │   Renderer   │◄──►│   Preload    │◄──►│         Main Process         │  │
│  │   (React)    │IPC │   (Bridge)   │IPC │  • Settings (electron-store) │  │
│  │              │    │              │    │  • Session history           │  │
│  │              │    │              │    │  • Workspace file ops        │  │
│  └──────────────┘    └──────────────┘    │  • Agent execution           │  │
│                                          └───────────────┬──────────────┘  │
└──────────────────────────────────────────────────────────┼──────────────────┘
                                                           │ HTTPS
                    ┌──────────────────────────────────────┼──────────────────┐
                    ▼                                      ▼                  ▼
           ┌───────────────┐                    ┌─────────────────┐  ┌────────────────┐
           │  Claude API   │                    │   Klavis MCP    │  │ Voice Providers│
           │  (Anthropic)  │                    │   Gateway       │  │ (OpenAI/11Labs)│
           │               │                    │                 │  │                │
           │ • Model calls │                    │ • Gmail, Slack  │  │ • STT (Whisper)│
           │ • Agent SDK   │                    │ • Calendar, etc │  │ • TTS          │
           └───────────────┘                    └─────────────────┘  └────────────────┘
```

### 1.3 Local-First Design

Mindstone Rebel currently operates without a Mindstone-operated backend for user data:

- **Conversations**: Stored locally in `electron-store` under the user's application data directory
- **Files**: Read from and written to a user-selected workspace directory on the local filesystem
- **Settings**: Persisted locally via `electron-store`
- **Session history**: Stored locally with bounded retention

**Storage locations by platform:**
- macOS: `~/Library/Application Support/mindstone-rebel/`
- Windows: `%APPDATA%\mindstone-rebel\`
- Linux (if supported): `~/.config/mindstone-rebel/` (XDG default)

> **Citation:** Privacy policy at `rebel-system/help-for-humans/Rebel-privacy-policy.md`

---

## 2. Data Handling and Privacy

### 2.1 Data Categories and Destinations

| Data Type | Stays Local | Sent to Third Parties | Notes |
|-----------|-------------|----------------------|-------|
| User conversations | ✓ Session history | Prompts sent to AI provider | Anthropic API; not used for training per their policy |
| Workspace files | ✓ On-device | File contents may be sent to AI provider as context | User-initiated via agent tools |
| API keys | ✓ electron-store | Transmitted in headers to respective providers | HTTPS only; never logged |
| Voice audio | ✓ In-memory only | Sent to STT/TTS provider | Not persisted locally |
| Analytics | — | RudderStack | Anonymous by default; see §2.3 |
| Error telemetry | — | Sentry | Crash reports; no user content |

### 2.2 Third-Party Data Processing

**Anthropic (Claude API)**
- Receives: User prompts, conversation context, workspace file contents (when tool-accessed)
- Policy: API data not used for model training
- Reference: [anthropic.com/legal/privacy](https://www.anthropic.com/legal/privacy)

**Klavis.ai (MCP Gateway)**
- Receives: API requests to connected services (Gmail, Slack, etc.)
- Retention: Stores all API requests/responses by default; no fixed retention period
- Logging Control: Teams can disable logging of interaction logs, API call details, and conversation history via Settings (minimal retention for security, compliance, billing, and service functionality still applies)
- Deletion: Available upon GDPR request
- Certifications: SOC 2 Type 2
- Policy: Google Workspace data explicitly NOT used for AI training
- Reference: [klavis.ai/privacy-policy](https://www.klavis.ai/privacy-policy)

**OpenAI (Whisper STT, voice TTS and potentially other services)**
- Receives: Audio recordings for transcription and text for generating voice (currently); may expand to include other OpenAI services in future
- Policy: API data not used for training by default
- Reference: [openai.com/policies/api-data-usage](https://openai.com/policies/api-data-usage)

**ElevenLabs (STT/TTS)**
- Receives: Audio for transcription; text for speech synthesis
- Reference: [elevenlabs.io/privacy](https://elevenlabs.io/privacy)

### 2.3 Analytics and Telemetry

Mindstone Rebel collects limited usage telemetry via RudderStack:

**What is collected:**
- Anonymous UUID (stable per installation)
- Company-level data (e.g. company name)
- FUTURE Individual-level data (e.g. name, email address, probably IP address, role, and other information)
- Feature usage counts (e.g., voice mode activated, automation run)
- Performance metrics (e.g., turn duration, token counts)
- Error types and codes (no stack traces with user data)
- Onboarding progression

**What is NOT collected:**
- Conversation content or transcripts
- File contents or paths
- API keys or credentials

**Identity handling:**
- A stable anonymous ID (UUID) is generated on first launch and stored locally
- User email is either provided by the company technical contact or automatically fetched from connected services (Gmail/Outlook via Klavis) after onboarding completes.
- In RudderStack analytics: Email is used as the `userId` for user identification
- In Sentry error tracking: The anonymous ID is used as the user `id`; email is stored as a separate `email` field when available

> **NOTE:** Email collection is automatic after onboarding, not explicitly user-initiated. This is disclosed here for transparency.

**Opt-out:** Analytics is disabled when RudderStack credentials are not configured or set to `DISABLED`.

> **Citation:** Analytics implementation verified in `src/main/analytics.ts`, `src/renderer/src/analytics.ts`, `src/main/services/userProfileService.ts`

### 2.4 Logging

Structured logs are written to:
- macOS: `~/Library/Application Support/mindstone-rebel/logs/`
- Windows: `%APPDATA%\mindstone-rebel\logs\`

**Log content:**
- API keys are redacted via Pino logger configuration
- File paths may appear in logs; file contents do not
- Session IDs are hashed before logging

---

## 3. Authentication and Credential Storage

### 3.1 API Key Storage

API keys are stored locally using `electron-store`:

| Key | Purpose | Storage |
|-----|---------|---------|
| `claude.apiKey` | Anthropic API access | electron-store (local JSON) |
| `voice.openaiApiKey` | OpenAI Whisper STT | electron-store |
| `voice.elevenlabsApiKey` | ElevenLabs STT/TTS | electron-store |

**Security characteristics:**
- Keys stored as plaintext in JSON file within user's application data directory
- Protected by OS-level file permissions
- Never transmitted to Mindstone servers
- Redacted in all log output

> **Citation:** Settings storage in `src/main/settingsStore.ts`; redaction in `src/core/logger.ts`

### 3.2 MCP OAuth Flows

External service authentication (Gmail, Slack, etc.) uses OAuth via Klavis:

1. User initiates connection in settings
2. Klavis provides OAuth authorization URL
3. User authenticates in browser
4. Klavis stores OAuth tokens
5. Subsequent API calls route through Klavis with stored tokens

**Security note:** OAuth tokens are stored by Klavis, not locally. Mindstone Rebel does not have direct access to these tokens.

### 3.3 No Mindstone Backend Authentication

Mindstone Rebel does not require user accounts or authentication with Mindstone. All authentication is:
- Direct to AI providers (API keys)
- Delegated to Klavis (OAuth for connected services)

---

## 4. Access Controls

### 4.1 Workspace Path Enforcement

File operations are primarily scoped to a user-selected workspace directory (`coreDirectory`), but this is not a hard security boundary:

**Default enforcement mechanism:**
```
User request → IPC handler → resolveLibraryPath() → Validate path starts with workspace root → Execute or reject
```

**Operations with workspace validation:**
- `library:read-file` — Enforced
- `library:write-file` — Enforced
- `library:create-file` — Enforced with secondary check
- `library:create-folder` — Enforced with secondary check
- `library:rename-item` — Enforced with secondary check
- `library:move-item` — Enforced with secondary check
- `library:delete-item` — Enforced with secondary check

**Intentional expansions:**
- **Symlinks:** Users can create symlinks or junction points (Windows) within their workspace pointing to external directories (e.g., Google Drive, OneDrive). Files accessed via symlinks/junction points are transparently converted to workspace-relative paths.
- **Workspace selection:** Users can freely change their workspace directory to any location on their system.

**Known bypasses:** See [Appendix B: Security Concerns](#appendix-b-security-concerns) for unintentional code paths that may bypass validation.

> **Citation:** Path validation in `src/main/utils/systemUtils.ts:resolveLibraryPath()`; handler enforcement in `src/main/ipc/libraryHandlers.ts`

### 4.2 IPC Security

Inter-process communication is secured via:

**Contract validation:**
- 80+ IPC channels with Zod schema validation
- Request and response types enforced at runtime
- Invalid payloads rejected before processing

**Preload bridge:**
- Explicit allowlist of exposed APIs via `contextBridge.exposeInMainWorld()`
- No direct `ipcRenderer` access from renderer
- Domain-organized API namespaces (`libraryApi`, `settingsApi`, etc.)

> **Citation:** IPC contracts in `src/shared/ipc/contracts.ts`; preload bridge in `src/preload/index.ts`

### 4.3 OS-Level Permissions

**macOS:**
- Microphone access requested via system dialog
- File access may require "Full Disk Access" or "Files and Folders" permission for certain directories
- App guides users to System Settings when permissions are missing

**Windows:**
- Standard file system permissions apply
- No special entitlements required

### 4.4 Tool Safety (In Beta)

Mindstone Rebel includes a tool safety system that evaluates MCP tool calls before execution using an LLM-based risk assessment.

**How it works:**
1. When the AI agent attempts to use an MCP tool (e.g., send email, delete files), a lightweight LLM (Claude Haiku) evaluates the operation's risk level
2. Risk is classified as low, medium, or high based on the user's security level setting and the operation's potential impact
3. High-risk operations prompt the user for approval before proceeding

**User-configurable security levels:**
| Level | Behavior |
|-------|----------|
| Run without asking | Only prompts for catastrophic operations |
| Ask, if action is risky (default) | Prompts for destructive or irreversible operations |
| Always ask before running | Prompts for most data modifications |

**Additional controls:**
- Users can add custom safety instructions (e.g., "Always ask before emailing anyone outside our company")
- Session-scoped approvals allow users to approve a tool once for the current session
- Metadata operations (list, search, get) are automatically allowed without evaluation

> **Status:** This feature is in beta and under active development.

> **Citation:** Tool safety implementation in `src/main/services/toolSafetyService.ts`; documentation at `docs/project/SECURITY_SAFETY_OF_TOOLS.md`

---

## 5. Code Integrity and Distribution

### 5.1 Code Signing

| Platform | Signing Status | Certificate |
|----------|---------------|-------------|
| macOS | Developer ID signed | Mindstone Learning Limited |
| Windows | TODO: Verify current status | TODO |

**Verification (macOS):**
```bash
codesign --display --verbose=4 /Applications/Mindstone\ Rebel.app
```

### 5.2 Notarization Status

**macOS:** NOT NOTARIZED

**Reason (historical):** The Claude Agent SDK (removed April 2026) included third-party native binaries (JetBrains plugin components) that were not signed. Apple's notarization requires all embedded binaries to be signed. Notarization should be re-evaluated now that the SDK has been removed.

**User impact:** First launch shows Gatekeeper warning: "Mindstone Rebel cannot be opened because Apple cannot check it for malicious software."

**Workaround:** Right-click → Open, or System Settings → Privacy & Security → Open Anyway

> **Citation:** Notarization limitation documented in `docs/project/DISTRIBUTION.md`

### 5.3 Update Distribution

- Updates distributed via direct download (DMG for macOS, installer for Windows)
- No auto-update mechanism currently implemented
- Users download new versions manually

---

## 6. Third-Party Dependencies

### 6.1 Core Dependencies

| Dependency | Purpose | Security Relevance |
|------------|---------|-------------------|
| Electron | Desktop app framework | Process isolation, chromium security updates |
| Rebel Core | AI agent execution | In-process runtime; direct Anthropic API communication (replaced Claude Agent SDK in April 2026) |
| electron-store | Local settings persistence | JSON file in user data directory |
| Pino | Structured logging | Configured with key redaction |
| RudderStack SDK | Analytics | Sends to RudderStack data plane |
| Sentry SDK | Error telemetry | Crash reporting |

### 6.2 MCP Ecosystem

MCP (Model Context Protocol) servers provide tool capabilities:

- **Transport:** HTTP (preferred) or stdio
- **Execution:** Via bundled Node.js runtime (npx)
- **Configuration:** JSON config file selected by user

> **Citation:** MCP protocol at [modelcontextprotocol.io](https://modelcontextprotocol.io/)

### 6.3 Bundled Node.js Runtime

Packaged builds include a complete Node.js installation (~100MB) to ensure MCP servers work without requiring users to install Node.js system-wide.

**Contents:**
- Node.js binary
- npm
- npx

> **Citation:** Bundle script in `scripts/bundle-node.mjs`; runtime setup in `src/main/utils/systemUtils.ts`

---

## 7. Software Development Lifecycle (SDLC)

### 7.1 Version Control

- **Repository:** Private GitHub repository
- **Branch strategy:** Feature branches merged to `dev`, then to `main` for release
- **Access control:** Team members with appropriate GitHub permissions

### 7.2 Code Review

TODO: Document code review requirements (PR approvals, reviewer requirements)

### 7.3 Automated Testing

| Test Type | Framework | Coverage |
|-----------|-----------|----------|
| Unit tests | Vitest | Core utilities and services |
| Integration tests | Vitest | MCP HTTP mode, service interactions |
| E2E tests | Playwright | UI flows, packaged app behavior |

**CI validation:**
- `npm run lint` — TypeScript type checking
- `npm run validate:fast` — Quick validation suite
- Test suites run in GitHub Actions

> **Citation:** Test configuration in `vitest.config.ts`, `playwright.config.ts`; CI workflows in `.github/workflows/`

### 7.4 Dependency Management

TODO: Document dependency review process (Dependabot configuration, security audit frequency)

### 7.5 Security Testing

TODO: Document security testing practices (penetration testing, vulnerability scanning)

---

## 8. Release Process

### 8.1 Build Pipeline

1. Code merged to `main` branch
2. CI pipeline triggers automatically
3. Build artifacts created:
   - macOS: DMG (arm64 and x64)
   - Windows: Installer
4. Artifacts uploaded to distribution storage (Google Cloud Storage)

### 8.2 Version Management

- Version defined in `package.json` (`appVersion`)
- Semantic versioning (MAJOR.MINOR.PATCH)
- Changelog maintained in `CHANGELOG.md`

### 8.3 Release Approval

TODO: Document release approval process (who approves, criteria for release)

> **Citation:** CI/CD documented in `docs/project/CI_PIPELINE.md`

---

## 9. Incident Response

### 9.1 Security Contact

TODO: Provide security contact email (e.g., security@mindstone.com)

### 9.2 Vulnerability Reporting

TODO: Document vulnerability reporting process

### 9.3 Incident Response Plan

TODO: Document incident response procedures

### 9.4 Breach Notification

TODO: Document breach notification procedures and timelines

---

## 10. Service Level Commitments

### 10.1 Mindstone Rebel Application

As a local-first application, Mindstone Rebel's functionality depends on:
- Local installation functioning correctly
- Network connectivity to third-party APIs (Claude, Klavis, voice providers)

**Mindstone does not provide uptime SLAs** for the application itself, as it runs locally.

### 10.2 Third-Party Service Dependencies

**Anthropic (Claude API):**
- Enterprise customers should refer to Anthropic's enterprise agreements
- Reference: [anthropic.com/enterprise](https://www.anthropic.com/)

**Klavis.ai:**
- Services provided "as is" and "as available" per their Terms of Service
- No public uptime SLA
- Enterprise support: Under 4-hour response time (per their documentation)
- Reference: [klavis.ai/terms-of-service](https://www.klavis.ai/terms-of-service)

### 10.3 Support

TODO: Document Mindstone support tiers and response times

---

## 11. Compliance and Standards

### 11.1 Mindstone Compliance Status

| Standard | Status |
|----------|--------|
| ISO 27001 | In progress (not certified) |
| SOC 2 | Not certified |
| GDPR | Data minimization practices; local-first design supports compliance |

### 11.2 Third-Party Compliance

**Klavis.ai:**
- SOC 2 Type 2 certified
- GDPR compliant (standard contractual clauses for international transfers)
- Google Workspace data not used for AI training

### 11.3 Data Residency

- User data stored locally on user's device
- API calls route to provider data centers (varies by provider)
- Klavis data processing: Refer to Klavis privacy policy for data center locations

---

## 12. Known Limitations

### 12.1 Electron Sandbox Disabled

**Current state:** `sandbox: false` in BrowserWindow configuration

**Impact:** Renderer process has more privileges than strictly necessary

**Mitigation:** Context isolation is enabled; IPC validates all cross-process calls

**Planned:** Evaluate enabling sandbox without breaking functionality

### 12.2 macOS Notarization

**Current state:** Application is signed but not notarized

**Impact:** Users see Gatekeeper warning on first launch

**Cause (historical):** Former upstream dependency (Claude Agent SDK, removed April 2026) contained unsigned binaries

**Planned:** Monitor upstream for resolution

### 12.3 Session History Encryption

**Current state:** Session history stored as unencrypted JSON

**Impact:** Conversation history readable by anyone with file system access

**Mitigation:** Relies on OS-level file permissions and disk encryption (e.g., FileVault)

**Planned:** Evaluate encryption at rest for sensitive data

---

## Appendix A: Open Questions

The following items require clarification or additional information:

| Question | Context | Owner |
|----------|---------|-------|
| Windows code signing status | Need to verify current signing certificate for Windows builds | TODO |
| SDLC code review requirements | Document PR approval process and reviewer requirements | TODO |
| Dependency security audit frequency | Document how often dependencies are reviewed for vulnerabilities | TODO |
| Security testing practices | Document penetration testing and vulnerability scanning | TODO |
| Release approval process | Document who approves releases and criteria | TODO |
| Security contact email | Provide official security contact | TODO |
| Vulnerability reporting process | Document how external parties report vulnerabilities | TODO |
| Incident response plan | Document procedures for security incidents | TODO |
| Breach notification timeline | Document notification procedures and timelines | TODO |
| Support SLAs | Document support tiers and response times | TODO |
| Vanta questionnaire responses | Incorporate responses from company Vanta documentation | TODO |

---

## Appendix B: Security Concerns

### SECURITY PRIORITY: HIGH

#### B.1 Library file access boundary (absolute-path bypass remediated)

**Status:** Resolved (desktop read handlers)

**Description:** The historical absolute-path bypass in `library:read-file-base64` has been remediated. Desktop library reads now enforce workspace containment and include a narrowly-scoped read-only salvage path for malformed relative links that over-traverse with leading `../`.

**Location:** `src/main/ipc/libraryHandlers.ts` (`library:read-file`, `library:read-file-base64`, `resolveWorkspaceEscapeSalvage`)

**Salvage scope and safeguards:**
- Read-only only (`library:read-file`, `library:read-file-base64`)
- Dangerous path forms rejected (`rejectDangerousPath`)
- Salvage strips only leading `..`, then re-validates lexical containment (`isPathInsideLexical`)
- Candidate must already exist and be a regular file (`fs.stat().isFile()`)
- Write/create/delete handlers are unchanged and remain fail-closed on path escape

**Residual model note:** Existing workspace symlink trust behavior is unchanged by this remediation.

**Risk:** Low — guarded read fallback with strict containment and no write-surface expansion.

---

#### B.2 `rebel-media` Protocol Handler Path Validation

**Description:** The `rebel-media://` custom protocol reads files without workspace validation.

**Location:** `src/main/index.ts:960-996`

**Impact:** If a `rebel-media://` URL with an arbitrary path is loaded, any file can be read.

**Current usage:** Used for serving video files (intro videos, onboarding).

**Risk:** Lower — URLs are generated internally, but protocol is registered globally.

---

### SECURITY PRIORITY: MEDIUM

#### B.4 Electron Sandbox Disabled

**Description:** The Electron sandbox is disabled (`sandbox: false`).

**Location:** `src/main/index.ts` (BrowserWindow configuration)

**Impact:** Renderer process has more system access than necessary; reduces defense in depth.

**Risk:** Low with current mitigations (context isolation enabled, IPC validation).

---

### SECURITY PRIORITY: LOW

#### B.5 Unencrypted Session History

**Description:** Conversation history stored as plaintext JSON files.

**Location:** `~/Library/Application Support/mindstone-rebel/sessions/` directory containing:
- `index.json` - Lightweight session summaries
- `<sessionId>.json` - Individual session files

**Impact:** Anyone with filesystem access can read conversation history.

**Risk:** Low — Protected by OS file permissions; recommend FileVault/BitLocker.

---

## Appendix C: Document Improvement Recommendations

### C.1 Content Improvements

1. **Complete TODO sections:** Fill in all TODO items marked throughout the document, particularly SDLC and Incident Response sections.

2. **Add architecture diagrams:** Include detailed diagrams showing data flows for specific scenarios (agent turn, voice transcription, MCP tool call).

3. **Add threat model:** Document threat model with attack vectors and mitigations.

4. **Add compliance matrix:** Create detailed mapping of controls to compliance frameworks (SOC 2, ISO 27001).

### C.2 Process Improvements

1. **Regular review cadence:** Establish quarterly review of this document.

2. **Automated validation:** Add CI checks to verify code citations remain accurate.

3. **Version tracking:** Track document version alongside application version.

4. **Customer feedback loop:** Collect questions from customer security reviews to improve document.

### C.3 Supporting Documents

1. **Data flow diagrams:** Detailed diagrams for each third-party integration.

2. **Penetration test reports:** Include summaries of any security assessments.

3. **Vendor security assessments:** Summarize security reviews of key vendors (Klavis, Anthropic).

---

## Appendix D: References and Citations

### Code References

| Citation | File Path | Description |
|----------|-----------|-------------|
| Analytics implementation | `src/main/analytics.ts` | Main process analytics |
| Analytics tracking | `src/renderer/src/tracking.ts` | Renderer tracking helpers |
| Email collection | `src/main/services/userProfileService.ts` | Automatic email fetch |
| IPC contracts | `src/shared/ipc/contracts.ts` | 80+ typed IPC channels |
| Logger redaction | `src/core/logger.ts` | API key redaction config |
| Path validation | `src/main/utils/systemUtils.ts` | `resolveLibraryPath()` |
| Preload bridge | `src/preload/index.ts` | IPC exposure to renderer |
| Settings store | `src/main/settingsStore.ts` | electron-store usage |
| Workspace handlers | `src/main/ipc/libraryHandlers.ts` | File operation handlers |

### Internal Documentation

| Document | Path | Description |
|----------|------|-------------|
| Analytics doc | `docs/project/ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md` | Analytics implementation details |
| Architecture | `docs/project/ARCHITECTURE_OVERVIEW.md` | System architecture |
| Distribution | `docs/project/DISTRIBUTION.md` | Packaging and signing |
| Privacy policy | `rebel-system/help-for-humans/Rebel-privacy-policy.md` | User-facing privacy policy |
| Settings | `docs/project/SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md` | Configuration reference |
| Workspace | `docs/project/LIBRARY_AND_FILE_ACCESS.md` | File access controls |

### External References

| Resource | URL | Description |
|----------|-----|-------------|
| Anthropic Privacy | https://www.anthropic.com/legal/privacy | Claude API data handling |
| Anthropic API Docs | https://docs.anthropic.com/ | Claude API documentation |
| Electron Security | https://www.electronjs.org/docs/latest/tutorial/security | Electron security guide |
| ElevenLabs Privacy | https://elevenlabs.io/privacy | Voice provider privacy |
| Klavis Privacy | https://www.klavis.ai/privacy-policy | MCP gateway privacy |
| Klavis Terms | https://www.klavis.ai/terms-of-service | MCP gateway terms |
| MCP Protocol | https://modelcontextprotocol.io/ | Model Context Protocol spec |
| OpenAI API Usage | https://openai.com/policies/api-data-usage | OpenAI data handling |

---

## Document Control

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-12-04 | Mindstone | Initial version |

---

*This document is provided for enterprise security evaluation purposes. For questions or clarifications, contact Mindstone at hello@mindstone.com.*
