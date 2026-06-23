---
description: "GitHub MCP connector reference — official hosted OAuth setup, repo, issue, PR, Actions, search, and security tools"
last_updated: "2026-01-22"
---

# GitHub MCP

GitHub integration for Rebel uses GitHub's official hosted MCP server via OAuth.

**Status:** Stable (Jan 2026) - OAuth integration working via Rebel-side OAuth (bypasses DCR which GitHub doesn't support).

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - General MCP setup and troubleshooting
- [GitHub MCP Server Repository](https://github.com/github/github-mcp-server) - Official open-source implementation
- [GitHub MCP Server Docs](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/set-up-the-github-mcp-server) - Official setup guide
- [GitHub API Rate Limits](https://docs.github.com/en/rest/rate-limit) - API limits and best practices

## How It Works

GitHub's official hosted MCP server provides direct OAuth access:

```
User → Rebel → Super-MCP → GitHub MCP Server (api.githubcopilot.com) → GitHub API
```

**Key points:**
- One-click OAuth setup (same as Notion, Linear, Sentry)
- No Docker, PAT, or Copilot license required for most tools
- 40+ tools for repos, issues, PRs, actions, search, security scanning
- Only 2 Copilot-specific tools require a paid Copilot license

## Setup

1. Open **Settings → Connectors**
2. Search for **GitHub** and click **+ Add**
3. Complete OAuth in the browser popup
4. GitHub tools appear after Super-MCP restart (~30-60 seconds)

## Available Tools

GitHub's MCP provides 40+ tools:

### Repositories
- `repos:get` - Get repository information
- `repos:list_branches`, `repos:list_tags`, `repos:list_releases`
- `repos:get_file_contents`, `repos:create_or_update_file`
- `repos:push_files`, `repos:create_branch`, `repos:fork`

### Issues
- `issues:create`, `issues:get`, `issues:update`
- `issues:list`, `issues:add_comment`, `issues:search`

### Pull Requests
- `pull_requests:create`, `pull_requests:get`, `pull_requests:update`
- `pull_requests:list`, `pull_requests:merge`
- `pull_requests:get_diff`, `pull_requests:get_reviews`

### Actions (CI/CD)
- `actions:list_workflows`, `actions:run_workflow`
- `actions:list_workflow_runs`, `actions:get_workflow_run_logs`
- `actions:cancel_workflow_run`, `actions:rerun_workflow`

### Search
- `search:code`, `search:repos`, `search:issues`, `search:users`

### Security
- `code_scanning:list_alerts`, `code_scanning:get_alert`
- `secret_scanning:list_alerts`

### Other
- Projects, Discussions, Gists, Notifications

For the complete current tool list, see [GitHub's MCP documentation](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/use-the-github-mcp-server).

## Tool Access Tiers

| User Type | Available Tools |
|-----------|-----------------|
| All GitHub users (free) | All 40+ tools except Copilot-specific ones |
| Copilot subscribers | Additional: `assign_copilot_to_issue`, `request_copilot_review` |

## Usage Tips

**Searching for issues:**
- "Show open issues in myorg/myrepo"
- "Find issues labeled 'bug' in the frontend repo"
- "What PRs need my review?"

**Creating issues:**
- "Create an issue about the login button bug in myorg/myrepo"

**Working with PRs:**
- "Show the diff for PR #123"
- "List review comments on PR #456"
- "Merge PR #789"

**Checking CI/CD:**
- "What's the status of the latest workflow run?"
- "Show me failed jobs in the build workflow"
- "Re-run failed tests"

## Rate Limits

GitHub's API has usage limits (see [official docs](https://docs.github.com/en/rest/rate-limit)):
- 5,000 requests per hour for authenticated users
- Search API: 30 requests per minute

## Troubleshooting

### OAuth Popup Doesn't Open
- Check browser popup blocker settings
- Try a different browser
- Ensure you're logged into GitHub in your browser

### OAuth Completes But No Tools Appear
- Wait 30-60 seconds for Super-MCP restart
- Check Settings → Connectors to verify "Connected" status
- Try disconnecting and reconnecting

### "Permission Denied" Errors
- Verify your GitHub account has access to the repository
- For organization repos, ensure you've authorized the OAuth app

### Enterprise Users
- GitHub Enterprise Cloud: Should work (OAuth access may require admin approval)
- GitHub Enterprise Server (on-premises): **Not supported** via this connector
- Organization admins may need to enable "MCP servers in Copilot" policy

### Rate Limit Errors
- Wait a few minutes before retrying
- Use more specific searches

## Air-Gapped / Local Setup

If you cannot use OAuth (e.g., air-gapped environment), you can manually configure the local Docker version:

```json
{
  "name": "github",
  "transport": "stdio",
  "command": "docker",
  "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_your_token_here"
  }
}
```

Add this to your MCP config file manually. Requires Docker installed.

## Vendor MCP Considerations

| Aspect | Implication |
|--------|-------------|
| Bug fixes | Report to [GitHub MCP repo](https://github.com/github/github-mcp-server/issues) |
| Availability | Depends on GitHub's service uptime |
| Tool changes | May change with GitHub releases |
| GA Status | Generally available since September 2025 |

## Security Notes

- OAuth 2.1 + PKCE provides secure authentication
- Tokens can be revoked from GitHub's settings
- Access matches your GitHub permissions and org policies
