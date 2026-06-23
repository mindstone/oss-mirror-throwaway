# Environment

## Repos

- **rebel-app**: `/Users/you/development/desktop/rebel-app-1` (branch: `feature/rebel-oss-provider-v2`)
- **mcp-servers**: `/Users/you/development/mcp-servers` (branch: `main`)

## npm Authentication

- User: `mindstone-engineering`
- Scope: `@mindstone-engineering`
- Registry: `https://registry.npmjs.org`
- Auth is configured globally (no project .npmrc needed)

## Credentials for Integration Tests

Available (in Electron router config at `$HOME/Library/Application Support/mindstone-rebel/mcp/super-mcp-router.json`):
- `RETELL_API_KEY` (32 chars) -- in `retellai` server entry
- `SALESFORCE_CLIENT_ID` (85 chars) -- in `Salesforce` server entry
- `SALESFORCE_CLIENT_SECRET` (64 chars) -- in `Salesforce` server entry

Not available:
- `OUTREACH_CLIENT_ID` -- not found in router config
- `OUTREACH_CLIENT_SECRET` -- not found in router config

**NEVER log, display, or commit credential values.** Extract with:
```bash
python3 -c "
import json
d = json.load(open('$HOME/Library/Application Support/mindstone-rebel/mcp/super-mcp-router.json'))
for name, cfg in d.get('mcpServers', {}).items():
    env = cfg.get('env', {})
    if 'RETELL_API_KEY' in env: print(env['RETELL_API_KEY'])
"
```

## System

- macOS, 48GB RAM, 14 CPU cores
- Node.js 20+ required (mcp-servers repo convention)
- npm ci for rebel-app, npm ci per connector in mcp-servers
