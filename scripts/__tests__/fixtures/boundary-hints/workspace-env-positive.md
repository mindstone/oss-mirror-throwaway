# Stable regression fixture: workspace-env positive hit

> Excerpt pattern from `docs-private/postmortems/260420_nano_banana_workspace_path_propagation_postmortem.md`.
> This fixture proves the tightened `mcp-workspace-env-propagation` registry entry
> still fires on the original 260420 bug class.
>
> DO NOT sync this with live postmortem edits — it is a regression anchor.

## Bug summary

The super-mcp router spawns the nano-banana OSS subprocess via
`super-mcp/src/clients/stdioClient.ts`. The subprocess reads its
workspace path from the `MCP_WORKSPACE_PATH` environment variable
(OSS-branded, matches the upstream contract). The router was
injecting `REBEL_WORKSPACE_PATH` instead of `MCP_WORKSPACE_PATH`,
so the subprocess fell back to the `.app` bundle path.

## Path touched

`super-mcp/src/clients/stdioClient.ts` — `buildChildEnv()` helper was
writing the wrong env-var name before spawning the child process.

## Expected behaviour

Fire `mcp-workspace-env-propagation` via both `path_glob` (stdioClient.ts)
and `identifier` (MCP_WORKSPACE_PATH + REBEL_WORKSPACE_PATH both present
in the prose).
