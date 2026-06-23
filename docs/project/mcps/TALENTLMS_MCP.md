---
description: "TalentLMS bundled MCP connector — LMS users, courses, enrolments, groups, reporting, assessments, setup, tool list"
last_updated: "2026-02-19"
---

# TalentLMS MCP

Cloud-based Learning Management System by Epignosis. Manage users, courses, enrolments, groups, and training progress.

**Status**: Implemented (Feb 2026)

**Tool Count**: 24 tools across 7 categories

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - General MCP configuration and discovery
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Development workflow for MCP improvements
- API docs: [TalentLMS API Documentation](https://www.talentlms.com/pages/docs/TalentLMS-API-Documentation.pdf)
- API v2 guide: [TalentLMS API V2](https://help.talentlms.com/hc/en-us/articles/24874457011356-TalentLMS-API-V2)
- Node.js SDK reference: [github.com/mashhour04/TalentLMS](https://github.com/mashhour04/TalentLMS)
- Source code: `resources/mcp/talentlms/`


## Overview

TalentLMS is available as a **bundled MCP** that runs locally with API key authentication.

| Attribute | Value |
|-----------|-------|
| **Provider** | Bundled MCP |
| **Auth** | HTTP Basic Auth (API key as username, empty password) |
| **Data flow** | Local only |
| **Setup** | Enter subdomain + API key from TalentLMS admin panel |
| **Rate limits** | 2,000-10,000 calls/hour depending on plan |


## Connector Catalog Entry

```json
{
  "id": "bundled-talentlms",
  "name": "TalentLMS",
  "provider": "bundled",
  "bundledConfig": {
    "authType": "api-key",
    "settingsKey": "talentlms.enabled",
    "serverName": "TalentLMS",
    "setupToolName": "configure_talentlms"
  }
}
```


## Tools

### Configuration

| Tool | Description |
|------|-------------|
| `configure_talentlms` | Configure API key and domain |

### Users

| Tool | Description |
|------|-------------|
| `list_talentlms_users` | List all users |
| `get_talentlms_user` | Get user by ID or email |
| `create_talentlms_user` | Create a new user |
| `set_talentlms_user_status` | Activate or deactivate a user |
| `get_talentlms_user_courses` | Get user's enrolled courses with progress |

### Courses

| Tool | Description |
|------|-------------|
| `list_talentlms_courses` | List all courses |
| `get_talentlms_course` | Get course details and content structure |
| `create_talentlms_course` | Create a new course |
| `get_talentlms_course_users` | Get enrolled users with completion status |
| `enrol_talentlms_user` | Enrol a user into a course |
| `unenrol_talentlms_user` | Remove a user from a course |
| `get_talentlms_course_sso_link` | Generate SSO link to launch user into course |

### Groups

| Tool | Description |
|------|-------------|
| `list_talentlms_groups` | List all groups |
| `get_talentlms_group` | Get group details with members and courses |
| `create_talentlms_group` | Create a new group |
| `add_course_to_talentlms_group` | Assign a course to a group |

### Branches

| Tool | Description |
|------|-------------|
| `list_talentlms_branches` | List branches (multi-tenant) |

### Reporting

| Tool | Description |
|------|-------------|
| `get_talentlms_site_info` | Get site-level statistics |
| `get_talentlms_timeline` | Get activity timeline for users or courses |
| `get_talentlms_user_progress` | Get detailed unit-by-unit progress |
| `get_talentlms_ilt_sessions` | Get instructor-led training sessions |

### Assessments

| Tool | Description |
|------|-------------|
| `get_talentlms_test_answers` | Get user's test/quiz answers and scores |
| `get_talentlms_survey_answers` | Get user's survey responses |


## Authentication

- **Method**: HTTP Basic Auth
- **Username**: API key
- **Password**: empty string
- **Requirements**: Paid TalentLMS plan, Super Admin access, API enabled in account settings
- **Base URL**: `https://{domain}.talentlms.com/api/v1/`


## Setup Flow

1. Go to **Settings -> Connectors** -> Find **TalentLMS**
2. Click **"Set up"**
3. Enter your TalentLMS subdomain (e.g., `acme` for `acme.talentlms.com`)
4. Enter your API key (from Admin Panel -> Account & Settings -> Security)
5. Click **Connect**

**Getting your API key:**
1. Log in to your TalentLMS as Super Admin
2. Go to Account & Settings -> Security
3. Enable API access
4. Copy the API key


## Technical Details

- **Type**: Bundled MCP (maintained by Mindstone)
- **Transport**: stdio (runs as subprocess)
- **Server script**: `resources/mcp/talentlms/build/index.js`
- **Environment Variables**:
  - `TALENTLMS_API_KEY` (required) - TalentLMS API key
  - `TALENTLMS_DOMAIN` (required) - TalentLMS subdomain


## Directory Structure

```
resources/mcp/talentlms/
├── src/
│   └── index.ts          # All tools, handlers, and MCP server
├── test-mcp.test.ts      # Mock API test suite (32 tests)
├── package.json
├── tsconfig.json
└── build/                # Compiled JS (gitignored)
```

## Integration Points

| File | What was added |
|------|---------------|
| `resources/connector-catalog.json` | `bundled-talentlms` catalog entry with setupFields (domain + apiKey) |
| `src/main/services/bundledMcpManager.ts` | `buildTalentLMSPayload` + BUNDLED_MCP_CATALOG entry |
| `src/main/services/mcpConfigManager.ts` | `'TalentLMS': 'bundled-talentlms'` in BUNDLED_SERVER_TO_CATALOG_ID |
| `scripts/mcp-config.json` | `"talentlms"` in bundledMcps array |


## Testing

### Smoke tests (Level 2)

TalentLMS is included in `UNCONFIGURED_TEST_MCPS` in `scripts/__tests__/mcp-smoke.test.ts`. This auto-tests:
- Server starts and registers all tools
- Calling a tool in unconfigured state returns `{ok: false}` gracefully
- Server remains stable after errors

Run: `npx vitest run scripts/__tests__/mcp-smoke.test.ts`

### Mock API tests (Level 3)

`resources/mcp/talentlms/test-mcp.test.ts` — 32 tests using `createMcpTestClientWithMockApi` harness:

| Category | Tests |
|----------|-------|
| Tool registration | All 24 tools present with valid schemas |
| Users | list, get by ID, get by email, create, set status, user courses |
| Courses | list, get, create, course users, enrol, unenrol, SSO link |
| Groups | list, get, create, add course to group |
| Branches | list |
| Reporting | site info, timeline, user progress |
| Assessments | test answers, survey answers, ILT sessions |
| Error handling | rate limit (429), auth failure (401), unconfigured state |
| Auth verification | Basic Auth header format (API key as username, empty password) |
| Stability | Server continues responding after errors |

Run: `npx vitest run resources/mcp/talentlms/test-mcp.test.ts`


## Known Limitations

- **No server-side pagination**: TalentLMS API v1 returns all results. Large tenants may see large payloads.
- **Paid plans only**: API access requires a paid TalentLMS subscription.
- **Super Admin required**: API key must be from a Super Admin account.
- **Rate limits vary by plan**: 2,000-10,000 calls/hour depending on subscription tier.


## Troubleshooting

**"Invalid API key or insufficient permissions":**
1. Verify API access is enabled in Account & Settings -> Security
2. Ensure the API key is from a Super Admin account
3. Re-enter credentials via Settings -> Connectors -> TalentLMS

**"Could not reach TalentLMS":**
1. Verify your subdomain is correct (e.g., `acme` not `acme.talentlms.com`)
2. Check that your TalentLMS instance is online

**"Rate limited":**
- Wait before retrying
- Rate limits: 2,000-10,000 calls/hour depending on your plan
