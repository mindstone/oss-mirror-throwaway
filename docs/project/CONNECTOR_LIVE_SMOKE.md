---
description: "Live read-only connector-smoke harness (L1 credential-resolution CI catch + L2 opt-in live MCP smoke): safety model, how to run, adding a connector"
last_updated: "2026-06-11"
---

# Connector live read-only smoke tests

Two complementary layers catch a connector breaking (creds, token-refresh, spawn, or
API-contract) by automation instead of by a user bug report. Built to catch the OSS-scrub
commercial-OAuth-credentials regression class (see
`docs/plans/260608_connector-live-smoke-tests/PLAN.md`).

> **Part of the repo's live / real-API test surfaces** — see the signpost in
> [`TESTING_AUTOMATION_OVERVIEW.md` § Live-API integration test pattern](TESTING_AUTOMATION_OVERVIEW.md#live-api-integration-test-pattern),
> which indexes this, the LLM live-API tier (`tests/live-api`), and the OSS pre-publish
> real-API smoke (`scripts/test-oss-connectors.ts`).

## L1 — credential-resolution catch (CI, no keys, no network)

`src/main/__tests__/commercialOAuthCredentialResolution.test.ts` runs in the normal desktop
unit suite. It registers the REAL commercial provider (`LIVE_OAUTH_CREDENTIALS_PROVIDER` from
`@private/mindstone/bootstrap`) with all connector env vars cleared and asserts every
commercial connector (google / slack / hubspot / github / microsoft / plaud / digitalocean)
resolves NON-NULL; then it registers the OSS stub provider and asserts they all resolve NULL
(broken-by-default). This is the cheapest always-on catch — it would have failed THE bug in
the ordinary suite. It complements the static `scripts/check-commercial-capability-parity.ts`.

## L2 — live read-only connector smoke (opt-in, uses your stored tokens/keys)

Exercises the real desktop path for a representative sample of connectors spanning auth
families. LOCAL (stdio) connectors: resolve client creds + stored token → spawn the published
MCP via `npx -y @mindstone/mcp-server-<x>@<pin>` over stdio → call a read-only tool → assert the
response shape. REMOTE (http) connectors: read the stored OAuth access token → connect to the
hosted MCP via Streamable-HTTP with a Bearer header → call a read-only tool.

| Connector  | Transport | Auth family                      | Read-only ops (THE allowlist)                     |
| ---------- | --------- | -------------------------------- | ------------------------------------------------- |
| slack      | stdio     | oauth + client secret            | `list_slack_workspaces`, `list_slack_channels`, `get_slack_message_by_link` (`url` from `SLACK_SMOKE_PERMALINK`; skips green when unset) |
| google     | stdio     | oauth + client secret (multi)    | `list_workspace_accounts`, `list_workspace_calendars` |
| microsoft  | stdio     | oauth PKCE (clientId only)       | `list_calendars`                                  |
| elevenlabs | stdio     | api-key                          | `list_voices`                                     |
| replit     | stdio     | ssh key                          | `replit_check_connection`                         |
| vanta      | stdio     | oauth client_credentials (m2m)   | `vanta_list_controls`, `vanta_list_people`        |
| notion     | **http**  | remote oauth (Streamable-HTTP)   | `notion-get-users`, `notion-get-teams`            |

### How to run

```sh
npm run test:connectors:smoke
```

The tier is gated behind `RUN_CONNECTOR_SMOKE_TESTS` (the npm script sets it). Each cell runs
only if its connector is connected on this machine; otherwise it SKIPS green with a clear,
secret-free reason. The `scripts/check-connector-smoke-ran.ts` guard fails the explicit run if
*zero* cells ran (so an all-skipped run isn't a silent pass). On a machine with only Slack +
Google connected, those two run live and the rest skip — honest coverage.

Cells without stored desktop creds read from env (test-only): `ELEVENLABS_API_KEY`,
`VANTA_CLIENT_ID` / `VANTA_CLIENT_SECRET` (+ optional `VANTA_REGION`), `REPLIT_SMOKE_HOST` /
`REPLIT_SMOKE_USER`, and `REPLIT_SMOKE_KNOWN_HOSTS_LINE` (see the SSH note below). Notion reads
its bearer access token from the super-mcp OAuth store (see the remote-MCP family below).
Slack's attachment metadata op also reads `SLACK_SMOKE_PERMALINK`; set it to a permalink to any
message with an attachment in your workspace. If it is unset/blank, only that op skips green with
the standard connector-smoke skip diagnostic while the other Slack read-only ops can still run.

## Safety model — accurate, enforced by construction

The accurate claim (NOT "literally zero writes anywhere"):

> **No external / service-side mutations.** The allowlist is list/get only, fail-closed, and
> guard-proven — nothing is created, modified, or deleted on the connected service.
> **No mutation of the user's real auth state, local OR server-side.** OAuth refresh is
> **disabled** in every spawn, so the smoke can never rotate a (single-use) refresh token and
> invalidate the user's real credential file — an expired token skips-with-DEGRADED instead.
> Any other credential-state write authenticating-for-a-read might attempt (e.g. SSH
> known_hosts) is isolated to a **disposable temp `HOME`** — the user's real credential dirs
> are never spawn targets.

Enforced by independent layers, not convention:

1. **Allowlist from a pure SSOT + fail-closed runner.** The tool names `runConnectorSmoke`
   (`src/test-utils/connectorSmokeHarness.ts`) calls are resolved **from the zero-side-effect
   `tests/connector-smoke/connectorSmokeAllowlist.ts`, keyed by connector id — not from a
   mutable cell field** (a cell supplies per-op *arguments* only, and can only override an
   already-allowlisted op; an op may also declare pure-data env argument bindings that skip that
   op green when unset). It never lists the server's advertised tools to *select* a name, so a
   write/destructive tool the server exposes is structurally unreachable, and an adversarial cell
   edit can't introduce one. An empty allowlist FAILS (no silent zero-coverage).
2. **Read-only annotation guard (CI).** `scripts/check-connector-smoke-readonly.ts` (wired
   into `validate:fast`) FAILS the build unless every allowlisted op is `readOnlyHint: true` /
   not `destructiveHint: true` — local ops AST-proved from the connector source, remote ops
   against a curated `REMOTE_READONLY_OPS` set. Its test asserts it rejects a real write op
   (`post_slack_message`) and a non-curated remote op.
3. **No refresh-from-copy (the key auth-state guarantee).** Every OAuth stdio cell sets its
   connector's disable-refresh flag — `SLACK_DISABLE_REFRESH=1`, `GOOGLE_WORKSPACE_DISABLE_REFRESH=1`,
   `MICROSOFT_DISABLE_REFRESH=1` — so an expired token signals `auth_required` (→ skip-DEGRADED)
   rather than refreshing. This closes the subtle hole where refreshing from a temp-copied token
   rotates the (single-use) refresh token server-side and leaves the user's real file invalid.
4. **Disposable temp `HOME` + temp copies.** Every stdio child runs with `HOME` (and
   `npm_config_cache`) set to a throwaway temp dir, with only the needed credential material
   copied under it — so a missed/renamed override can't fall back to a real-home credential
   location (`$HOME/.google-workspace-mcp`, `$HOME/.replit-mcp`, `~/.ssh`). The harness always
   `rm -rf`'s it in teardown. Per connector: slack copies `config.json` + the workspace token;
   google copies the chosen instance's `accounts.json` + `credentials/`; microsoft copies the
   `microsoft-mcp` config dir; **replit** copies only the `rebel-replit` key into
   `<tempHOME>/.ssh`, forces `MCP_REPLIT_SSH_STRICT_HOST_KEY=1` + temp known_hosts (skip-green
   if the key/known-host line is absent — never appends to the real known_hosts); elevenlabs/vanta
   are bearer-key only. **notion (remote/http)** makes no local write at all — it only READS the
   `access_token` and sends it as a Bearer header; `refresh_token` is never read out.
5. **Opt-in gate.** Nothing runs unless `RUN_CONNECTOR_SMOKE_TESTS` is set.

Secrets (tokens / keys / client secrets) are never logged — diagnostics are scrubbed of any
cell-declared secret value, and auth-skip telemetry surfaces only the connector id + phase,
never the thrown error (so a token embedded in an SDK/server error can't leak).

### Remote (HTTP) MCP family — Notion

Some connectors are hosted MCPs reached over HTTP rather than a local stdio spawn. The harness
supports them via `transport: 'http'` + `buildHttpConnection()`:

- **Transport.** `StreamableHTTPClientTransport(new URL('https://mcp.notion.com/mcp'), {
  requestInit: { headers: { Authorization: 'Bearer <access_token>' } } })`.
- **Token sourcing.** The OAuth access token is read from the super-mcp store at
  `~/.super-mcp/oauth-tokens/<server>_tokens.json` (field `access_token`). Notion prefers
  `Notion-teammember-mindstone-com_tokens.json`, else falls back to any `Notion-*_tokens.json` with a
  non-empty `access_token`. The cell reads ONLY `access_token`; `refresh_token` is never read out
  or passed anywhere. No connected token → skip-green.
- **No local credential write.** The remote path spawns nothing and writes nothing locally — it
  only reads the token file and sends a header. So there is no temp-copy to make.
- **Read-only basis (two layers, since there's no local source to AST-prove).**
  1. **Curated allowlist, guard-enforced.** Remote allowlist entries are marked `remote: true`;
     the static guard (`check-connector-smoke-readonly.ts`) requires every remote op to be in the
     hardcoded `REMOTE_READONLY_OPS` set (with a read-only citation comment). A non-curated / write
     op on a remote allowlist FAILS the build — it is NOT silently skipped. (Its unit test asserts
     a non-curated remote op fails.)
  2. **Runtime server-advertised check.** After connecting, the runner fetches the remote server's
     advertised tool annotations and asserts each allowlisted op advertises `readOnlyHint === true`
     (and not `destructiveHint`) BEFORE calling it; otherwise it fails without calling. This
     VERIFIES the curated choice — we still only ever call the static allowlist, never a name
     selected from the server's list.
- **Citation.** Notion's remote MCP advertises `readOnlyHint:true, destructiveHint:false` for
  `notion-get-users` and `notion-get-teams` (both `get-`/"Retrieves a list" reads), confirmed by a
  live spike (16 tools advertised; `notion-get-users` returned results, `isError:false`).
- **401 / expired token.** A remote auth failure (HTTP 401/403, "Unauthorized", "invalid_token",
  "token expired") thrown at connect or call time is caught and treated as the skip-with-DEGRADED
  path (reason "token expired/needs reconnect"), never a hard red. A generic network/server error
  still fails.

### auth_required is surfaced, not silently swallowed

If a connector returns `auth_required` immediately (the connected account's token has expired),
the cell **skips** (a plain expiry must not turn the live tier red). But when the commercial
client creds DID resolve and the connector still reports `auth_required`, the runner logs a
prominent `[connector-smoke] DEGRADED …` line — because that can be a real live-path regression
(a wrong/renamed spawn env var), not just an expired token. So it's visible in the run output
rather than an invisible skip. The dedicated L1 unit test owns the commercial-credential
regression and fails loud on it.

## Adding a connector

1. Add the allowlist entry to `tests/connector-smoke/connectorSmokeAllowlist.ts` (the pure,
   side-effect-free source of truth the static guard reads):
   - **LOCAL (stdio):** `{ connector, toolSourceConnectorDir (the dir under
     `mcp-servers/connectors/`), readOnlyOps }`. Each op MUST be annotated `readOnlyHint: true` /
     not `destructiveHint: true` in the connector source (the guard AST-proves it).
     If an op needs operator-supplied call arguments, declare `envArguments` on that op; missing
     or blank env vars skip only that op green.
   - **REMOTE (http):** `{ connector, remote: true, readOnlyOps }` — and add each op to the
     `REMOTE_READONLY_OPS` set with a read-only citation. The guard FAILS unless the op is curated.
2. Add a `ConnectorSmokeCell` to `tests/connector-smoke/connectorSmokeCells.ts`:
   - `prereqs`: cheap presence checks (token file `fs.existsSync`, or env var present) — each
     returns false ⇒ the cell skips green.
   - Per-op argument overrides belong in `argsFor` only when the arguments cannot be expressed as
     static allowlist data or `envArguments`.
   - **stdio cells** — `buildSpawn`: command/version mirroring `resources/connector-catalog.json`.
     **Copy any credential material into an `mkdtemp` dir (use `makeTempDir`), point the spawn
     paths at the COPY, and return its `cleanup` as `ConnectorSpawn.cleanup`** — never pass the
     user's real credential dir as a spawn target.
   - **remote cells** — set `transport: 'http'` + `buildHttpConnection` returning `{ url, headers }`
     (read the access token, pass it as a Bearer header; never pass `refresh_token`).
   - `secretsToScrub`: any secret value (token / key / client secret) to redact from diagnostics.
   - `clientCredsResolved` (OAuth/remote cells): so an `auth_required`/401 despite resolved creds
     surfaces a DEGRADED warning.
3. Add a thin `tests/connector-smoke/<connector>.live.test.ts` that calls
   `runConnectorSmoke(<cell>)`.
4. Run `npx tsx scripts/check-connector-smoke-readonly.ts` — it must pass (proves the ops are
   read-only). Then `npm run test:connectors:smoke`.
