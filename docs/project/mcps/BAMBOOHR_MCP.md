---
description: "BambooHR MCP connector reference — community package, API key setup, HR tool domains, testing, technical risks"
last_updated: "2026-05-14"
---

# BambooHR MCP

Connect Rebel to BambooHR for employee data, time-off management, goals, recruiting, and HR analytics.

| Property | Value |
|----------|-------|
| **Status** | Beta — Community MCP |
| **Type** | Community MCP (npx) |
| **Provider** | twentytwokhz (Florin Bobis) |
| **Source** | https://github.com/twentytwokhz/bamboohr-mcp |
| **npm** | @twentytwokhz/bamboohr-mcp@1.1.1 |
| **Auth** | API Key + Company Subdomain |
| **Tools** | 79 |
| **License** | MIT |


## Overview

BambooHR MCP enables AI-powered interaction with BambooHR's HR platform. Query employees, manage time off, track goals, handle recruiting, view benefits, manage time tracking, and run reports.

The package provides 79 tools across 10 domains:
- **Employees** (9): directory, details, files, enriched data, table rows, CRUD
- **Time Off** (9): requests, who's out, types, policies, balances, create/approve
- **Files** (6): list, upload, delete employee/company files
- **Goals** (7): view, create, update, delete goals; add comments
- **Metadata & Training** (10): fields, changed employees, birthdays, training CRUD
- **Applicant Tracking** (10): jobs, applications, candidates, statuses
- **Benefits** (7): dependents, benefit plans, coverage levels
- **Time Tracking** (8): timesheets, clock in/out, hour records, projects
- **Certifications** (7): due dates, compliance reports, assessments
- **Reports & Datasets** (8): saved reports, custom reports, dataset queries


## Setup

### Prerequisites

- BambooHR account with API access
- Admin or appropriate permission level (API key inherits user permissions)
- Node.js 18+ installed locally

### Credentials

1. **API Key**: Log in to BambooHR → click your name (lower-left) → API Keys → Add New Key
2. **Company Subdomain**: The `{company}` part of `{company}.bamboohr.com`

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BAMBOOHR_API_KEY` | Yes | Your BambooHR API key |
| `BAMBOOHR_COMPANY_DOMAIN` | Yes | Company subdomain (e.g., `acme`) |


## Catalog Entry

- **ID**: `bamboohr`
- **Provider**: `community`
- **Category**: `productivity`
- **Version**: `@twentytwokhz/bamboohr-mcp@1.1.1` (pinned)


## Testing

Integration tests in `resources/mcp/bamboohr/test-mcp.test.ts`. Requires real credentials:

```bash
BAMBOOHR_API_KEY=... BAMBOOHR_COMPANY_DOMAIN=... npx vitest run resources/mcp/bamboohr/test-mcp.test.ts
```

Tests skip automatically when credentials are not set.


## Technical Details

- **API Base URL**: `https://{domain}.bamboohr.com/api/v1/`
- **Authentication**: HTTP Basic Auth (API key as username, `"x"` as password)
- **Caching**: 5-minute response cache for read operations
- **Retry Logic**: Exponential backoff for 429/503 responses
- **Safety**: Destructive operations require `confirm: true` parameter
- **Transport**: stdio (default)


## Risks and Considerations

1. **Community package**: Not an official BambooHR product. Package by solo developer (Florin Bobis). Set as `verified: false` in catalog.
2. **Version pinned**: At `1.1.1` — monitor for updates.
3. **Tool count**: 79 tools is high but comparable to HubSpot (68). Super-MCP progressive disclosure handles this.
4. **API key scope**: Inherits the generating user's full permissions. Users should create a dedicated key with appropriate access level.
5. **Rate limits**: BambooHR enforces API rate limits. The package includes retry logic for 429 responses.


## See Also

- [MCP_IMPROVEMENT_WORKFLOW](../MCP_IMPROVEMENT_WORKFLOW.md) — MCP development workflow
- [MCP_ARCHITECTURE](../MCP_ARCHITECTURE.md) — Connector catalog, provider types, auth patterns
- Planning doc: `docs/plans/obsolete/260220_bamboohr-mcp-connector.md`
