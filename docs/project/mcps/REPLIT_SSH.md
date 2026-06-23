---
description: "Replit SSH MCP connector — OSS SFTP package, SSH key resolution, tool-safety rationale, catalog registration, hardening notes"
last_updated: "2026-05-22"
---

# Replit SSH MCP

Manage Replit projects over SSH — read, write, and list files in running Replit projects. Desktop-only, SFTP-based, cross-platform.

| Field | Value |
|-------|-------|
| **Type** | `rebel-oss` npm package (`@mindstone/mcp-server-replit-ssh@0.1.0` at v0.4.41 migration; current catalog pin `0.1.2`) |
| **Provider** | Mindstone `rebel-oss` |
| **Transport** | stdio |
| **Auth** | SSH key (resolved from `~/.ssh/config`, fallback `~/.ssh/rebel-replit`) — no API key or OAuth |
| **Status** | Migrated to OSS May 2026 |

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) — General MCP setup, discovery, and troubleshooting
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) — Third-party MCP integration patterns
- [MCP_TESTING.md](../MCP_TESTING.md) — Test levels and harness usage
- [Replit SSH docs](https://docs.replit.com/power-ups/ssh) — Official Replit SSH reference
- Planning doc: `docs/plans/260414_replit_project_manager_skill.md`
- OSS migration plan: `docs/plans/260519_replit_ssh_oss_migration.md`
- Security review: `docs-private/reports/security-reviews/260519_bundled-replit-ssh_0.1.0.md`
- Current catalog entry: `resources/connector-catalog.json` (`bundled-replit-ssh`)
- Legacy bundled tree: `resources/mcp/replit-ssh/` — deleted during v0.4.41 cleanup
- Skill: `rebel-system/skills/coding/replit-project-manager/`
- User-facing doc: `rebel-system/help-for-humans/connectors/replit.md`


## Overview

The Replit SSH MCP enables Rebel to manage files in running Replit projects via SFTP. It's designed for non-technical users — Rebel acts as "project manager" and Replit Agent does the building.

**Architecture:** Skill + `rebel-oss` MCP package. The MCP server handles SSH file operations (benefiting from Rebel's tool safety system), while the skill orchestrates workflows, templates, and user guidance.

**Why MCP instead of bash?** Tool safety. Bash-based SSH commands match `NEVER_TRUST_SUBSTRINGS` (contains "bash"/"shell"), meaning every invocation triggers LLM safety evaluation with no permanent trust option. MCP tools get verb-based treatment: `replit_check_connection`, `replit_list_files`, and `replit_read_file` are auto-allowed (read-only verbs in `TRUSTABLE_READ_ONLY_VERBS`); `replit_write_file` gets one-time LLM evaluation then "Always allow."


## Architecture

```
resources/connector-catalog.json
└── bundled-replit-ssh
    ├── provider: "rebel-oss"
    ├── mcpConfig.args: ["-y", "@mindstone/mcp-server-replit-ssh@0.1.2"]
    └── bundledConfig: { authType: "none", settingsKey: "replitSsh.enabled", serverName: "ReplitSSH" }
```

The package source lives in `mindstone/mcp-servers`; Rebel only ships the catalog pin and host setup metadata. v0.4.41 removed the legacy `resources/mcp/replit-ssh/` bundled tree after the catalog flip, so there is no bundled-manager fallback path.

**Package shape and hardening:**
- Structured recovery contract: failures return `{ ok: false, code, error, resolution }` with actionable setup guidance.
- Timeouts compose caller cancellation with package deadlines via `AbortSignal.any()`.
- SSH config parsing uses a safe static AST evaluator instead of `ssh-config.compute()`; this closes the Match-exec RCE class documented in the migration security review.
- Config and key writes are atomic and permission-hardened; POSIX paths use restrictive modes, and Windows ACL hardening fails closed rather than accepting weak key permissions.
- SSH host-key verification remains documented as deferred because Replit rotates SSH endpoints; see [Known Limitations](#known-limitations).

**Dependencies** (in the OSS package):

| Package | Purpose |
|---------|---------|
| `ssh2` | SSH client + SFTP — pure-JS with optional native crypto fallback |
| `sshpk` | Ed25519 key pair generation — pure-JS, no `ssh-keygen` dependency |
| `ssh-config` | Programmatic `~/.ssh/config` read/write — parsed through a safe static evaluator (no `Match exec` evaluation) |
| `@modelcontextprotocol/sdk` | MCP server framework |

**esbuild note:** ssh2 includes optional native bindings (`.node` files). The build uses `loader: { '.node': 'empty' }` to replace them with empty modules — ssh2 gracefully falls back to pure-JS crypto.


## Connector Catalog Entry

```json
{
  "id": "bundled-replit-ssh",
  "name": "Replit",
  "description": "Manage Replit projects over SSH...",
  "category": "development",
  "provider": "rebel-oss",
  "mcpConfig": {
    "command": "npx",
    "args": ["-y", "@mindstone/mcp-server-replit-ssh@0.1.2"]
  },
  "bundledConfig": {
    "authType": "none",
    "settingsKey": "replitSsh.enabled",
    "serverName": "ReplitSSH"
  },
  "icon": "terminal"
}
```

**`authType: "none"`** — unlike API-key MCPs, the SSH key is resolved from `~/.ssh/config` (matching OpenSSH behavior), falling back to `~/.ssh/rebel-replit`. No credentials pass through env vars or bridge state. SSH key setup is handled conversationally via the skill invoking `replit_setup_ssh`.


## Host Registration

The host resolves Replit SSH from the catalog like any other `rebel-oss` connector. `bundledConfig` is intentionally preserved for Settings identity, setup semantics, and migration compatibility, but spawning uses the exact npm spec above. No bridge state or provider key is required.


## Tools Reference

### `replit_check_connection`

Verify SSH connectivity to a Replit project.

| Attribute | Value |
|-----------|-------|
| **Safety** | Auto-allowed (`check` verb → `TRUSTABLE_READ_ONLY_VERBS`) |
| **Annotations** | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` |

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | Yes | SSH host (e.g., `<uuid>-00-<hash>.riker.replit.dev`) |
| `user` | string | Yes | SSH username (UUID from Replit SSH command) |
| `verbose` | boolean | No | Enable verbose diagnostics — captures handshake, auth attempts, key validation, and timing. Use when troubleshooting. |

**Success response:**
```json
{
  "ok": true,
  "workingDirectory": "/home/runner/<project>",
  "sftpSupported": true,
  "serverVersion": "Replit-SSH-Proxy"
}
```

**Failure response** (connection failures include `diagnostics`; preflight failures like missing key may not):
```json
{
  "ok": false,
  "error": "...",
  "resolution": "...",
  "next_step": { "action": "..." },
  "diagnostics": {
    "durationMs": 2990,
    "events": [{ "timestamp": 0, "event": "connect_start", "detail": "..." }, ...],
    "keyType": "ed25519",
    "keyFingerprint": "SHA256:..."
  }
}
```

### `replit_list_files`

List files and directories in a Replit project path.

| Attribute | Value |
|-----------|-------|
| **Safety** | Auto-allowed (`list` verb → `TRUSTABLE_READ_ONLY_VERBS`) |
| **Annotations** | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` |

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `host` | string | Yes | — | SSH host |
| `user` | string | Yes | — | SSH username |
| `path` | string | No | `.` | Directory path (relative to project root) |

**Success response:** Array of `{ name, type, size }` entries.

### `replit_read_file`

Read a file from a Replit project. Returns text for text files, base64 for binary (detected by null-byte check in first 8KB).

| Attribute | Value |
|-----------|-------|
| **Safety** | Auto-allowed (`read` verb → `TRUSTABLE_READ_ONLY_VERBS`) |
| **Annotations** | `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` |

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | Yes | SSH host |
| `user` | string | Yes | SSH username |
| `path` | string | Yes | File path (relative to project root) |

**Success response:**
```json
{
  "ok": true,
  "path": "src/index.ts",
  "content": "...",
  "encoding": "utf-8",
  "size": 1234
}
```

### `replit_write_file`

Write content to a file using atomic write with SHA-256 verification.

| Attribute | Value |
|-----------|-------|
| **Safety** | LLM evaluation → user "Always allow" once per session |
| **Annotations** | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true` |

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | Yes | SSH host |
| `user` | string | Yes | SSH username |
| `path` | string | Yes | File path (relative to project root) |
| `content` | string | Yes | File content to write |

**Atomic write sequence:**
1. Create parent directories (recursive, idempotent)
2. Write to `<path>.rebel-tmp`
3. Rename temp → final (atomic on POSIX)
4. Read back the **final file** and SHA-256 verify against input
5. Return `{ ok: true, verified: true }` or error
6. On failure: clean up temp file if it exists

### `replit_setup_ssh`

Generate SSH key pair, configure `~/.ssh/config`, return public key for Replit account registration.

| Attribute | Value |
|-----------|-------|
| **Safety** | LLM evaluation → user approves (one-time operation) |
| **Annotations** | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true` |

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `force_regenerate` | boolean | No | `false` | Generate a new key even if one exists |

**What it does:**
1. Checks if `~/.ssh/rebel-replit` exists
2. If not (or `force_regenerate`): generates Ed25519 key via `sshpk`, writes private + public key files through atomic temp+rename writes
3. Hardens file permissions: `0o600` on POSIX, user-only ACL on Windows; Windows ACL hardening fails closed if it cannot prove the key is private to the user
4. Parses `~/.ssh/config` through the safe static AST path, then atomically adds a `Host *.replit.dev` block if absent (preserves existing entries)
5. Returns public key content and next-step instructions

**Success response:**
```json
{
  "ok": true,
  "publicKey": "ssh-ed25519 AAAA...",
  "alreadyExisted": false,
  "configUpdated": true,
  "message": "SSH key generated and config updated..."
}
```


## SSH Connection Lifecycle

### Connection Cache

Connections are cached by `host:user` key with a 60-second idle timeout:

- **On first use:** SSH connect → open SFTP channel → cache
- **On reuse:** Verify alive via `sftp.stat('.')` → reset idle timer → return cached session
- **Invalidation:** `close`, `end`, or `error` events trigger immediate removal
- **Stale detection:** If `stat('.')` fails, the connection is discarded and a fresh one is created transparently
- **Not used by `check_connection`:** The diagnostic tool creates a disposable connection

### Timeouts

- **SSH connect:** 30 seconds (`SSH_CONNECT_TIMEOUT_MS`)
- **SFTP channel open:** 30 seconds
- **Connection idle:** 60 seconds (`CONNECTION_IDLE_TIMEOUT_MS`)
- **Alive check:** 5 seconds

Package-level deadlines are composed with caller cancellation via `AbortSignal.any()`, so host stop/restart signals do not wait for the full SSH timeout.

### Host Validation

Every tool validates the `host` parameter against `*.replit.dev` before any SSH activity. Non-matching hosts are rejected immediately with a structured error — this prevents prompt-injection-directed SSH to non-Replit targets.


## Safety Features

### Host Allowlist

Only `*.replit.dev` hostnames are accepted. Validated before SSH key read (fail-fast).

### Path Traversal Prevention

All file operations normalise paths via `path/posix` (remote is always Linux) and reject:
- Absolute paths (`/`, `\`, drive letters)
- Traversal segments (`..`)

Validation runs before SSH key read — path errors surface even without SSH keys configured.

### Atomic Writes with Verification

Write flow: temp file → rename → read back **final file** → SHA-256 verify. Temp files cleaned up on failure. Never deletes user files.

### SFTP-Only (No Exec Fallback)

All file operations use SFTP. No shell/exec fallback — eliminates injection risk from shell escaping. SFTP is confirmed working through Replit's SSH proxy.

### Tool Safety Verb Matching

| Tool | Verb | Safety Outcome |
|------|------|----------------|
| `replit_check_connection` | `check` | Auto-allowed (zero friction) |
| `replit_list_files` | `list` | Auto-allowed (zero friction) |
| `replit_read_file` | `read` | Auto-allowed (zero friction) |
| `replit_write_file` | `write` | LLM eval → "Always allow" once |
| `replit_setup_ssh` | `setup` | LLM eval → user approves |

### Structured Logging

Per-operation log to stderr: `{ tool, host: '<redacted>', path, result, duration }`. Host is redacted to first segment. Never logs file content or key material.


## Error Handling

All errors follow a structured format:

```json
{
  "ok": false,
  "code": "AUTH_FAILED",
  "error": "Plain English description of what happened",
  "resolution": "Most likely cause and how to fix it"
}
```

### SSH Error Disambiguation

Error translation uses **banner-based disambiguation** to distinguish sleeping projects from auth failures. Replit's SSH proxy sends a "Welcome to the Replit SSH Proxy" banner before auth. The presence/absence of this banner, combined with handshake completion, drives the error message:

| Signals | Diagnosis | User-Facing Guidance |
|---------|-----------|---------------------|
| Banner received + auth rejected | **Confirmed auth problem** | Key not registered, wrong key, or no Core plan. Check replit.com → SSH Keys. |
| No banner + timeout | **Project sleeping or unreachable** | Open project in browser to wake it up. |
| Banner + handshake + timeout | **Proxy alive, container sleeping** | Project behind proxy not responding. Wake it up. |
| `ECONNREFUSED` | **Project not running** | Open project in browser. |
| `ENOTFOUND` | **Hostname rotated** | Get fresh SSH command from Replit. (Rare — Replit uses wildcard DNS.) |
| `SFTP_UNAVAILABLE` | **SSH works, SFTP doesn't** | Temporary — retry. |

**Key validation:** `validatePrivateKey()` runs inside `preflightChecks()` — every tool validates the key parses correctly via `sshpk` before attempting SSH. Corrupted or wrong-format keys surface immediately with a clear error and `force_regenerate` guidance.

**Diagnostics:** `check_connection` always includes a `diagnostics` object on failure (event timeline, key type, key fingerprint). Pass `verbose=true` to get diagnostics on success too. See source code for the full event schema.

### SFTP Error Translation

| SFTP Status Code | User-Facing Message |
|------------------|-------------------|
| 2 (No such file) | "File or directory not found." |
| 3 (Permission denied) | "Permission denied." |
| 4 (Failure) | "Operation failed." |


## Testing

### Unit Tests

```bash
# In mindstone/mcp-servers package workspace
npm test -- --filter mcp-server-replit-ssh
```

Tests cover tool registration, schema validation, annotations, host validation, path traversal, directory path rejection for read/write, missing params, SSH key errors, setup tool idempotency/force-regenerate, atomic config/key writes, Windows ACL fail-closed behavior, safe SSH config AST evaluation, diagnostics shape, event structure, and auth-vs-sleeping disambiguation.

### Catalog Smoke Test

```bash
npm run test:oss-connectors -- --connector bundled-replit-ssh --list-only
```

Verifies the catalog-pinned npm package starts, registers tools, and responds to `list_tools`.

### Validation

```bash
npm run validate:fast
```

Includes catalog/provider validation and the static checks that guard `rebel-oss` connector pins. The legacy bundled source/bundle checks no longer include `resources/mcp/replit-ssh/` because that tree was deleted.

### Integration Testing

Real SSH testing against a live Replit project. Test matrix covers:
- Connection to active and sleeping projects
- File read/write round-trip with SHA-256 verification
- Large file transfer (~50KB)
- SSH key setup (new, idempotent, force regenerate)
- Error paths (invalid host, non-existent files, connection loss)


## Known Limitations

- **Desktop-only** — SSH key storage requires local filesystem
- **Project must be awake** — sleeping Replit projects reject SSH connections
- **SSH endpoint may change** — Replit assigns new hostnames per session
- **SFTP-only** — no shell exec, which means no server-side commands (by design)
- **Windows ACLs** — key permissions use user-only ACLs on Windows and fail closed if hardening cannot be verified
- **No file deletion** — by design; write and read only
- **File size** — files are buffered in memory for read/write. No practical limit has been hit with typical Replit projects, but very large files (>10MB) may cause high memory usage. Streaming is not implemented.
- **Host key verification** — documented as deferred. SSH config uses `StrictHostKeyChecking: accept-new` because Replit rotates hostnames per session. Traditional host key pinning is impractical in this environment. Security currently relies on the DNS-based `.replit.dev` host allowlist and TLS/SSH transport security.
- **Non-atomic overwrite fallback** — atomic overwrite depends on the `ext_openssh_rename` SFTP extension (POSIX `rename(3)`), which Replit's OpenSSH server always provides. If that extension is unavailable and the target file already exists, `replit_write_file` fails closed (returns a `RENAME_UNSUPPORTED` error) rather than attempting an unsafe unlink-then-rename that could lose data on crash.


## References

- [Replit SSH Documentation](https://docs.replit.com/power-ups/ssh)
- [ssh2 library](https://github.com/mscdex/ssh2)
- [sshpk library](https://github.com/TritonDataCenter/node-sshpk)
- [ssh-config library](https://github.com/nicksrandall/ssh-config)
