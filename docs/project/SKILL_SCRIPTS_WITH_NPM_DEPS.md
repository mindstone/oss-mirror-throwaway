---
description: "How to handle rebel-system skills that have Node.js scripts with npm dependencies. Covers the current copy-to-temp pattern, rationale, and future options."
last_updated: "2026-04-17"
---

# Skill Scripts with npm Dependencies

Some skills in `rebel-system/skills/` include Node.js scripts with npm dependencies (a `scripts/package.json`). This doc explains how they work, the current pattern, and future options.

## The Problem

In production, `rebel-system/` is bundled as a read-only extraResource inside the app package (`process.resourcesPath/rebel-system`). Skills can't `npm install` into their own directory because it's not writable.

In dev mode this isn't an issue -- `rebel-system/` is a writable git submodule.

## Current Skills with npm Dependencies

| Skill | Dependencies | Approx size |
|-------|-------------|-------------|
| [linkedin-export-parser](../../rebel-system/skills/data-analysis/linkedin-export-parser/SKILL.md) | adm-zip, csv-parse | ~1.5MB |
| [outlook-email-export-parser](../../rebel-system/skills/data-analysis/outlook-email-export-parser/SKILL.md) | pst-extractor, olm-reader | ~50MB installed |

## Current Pattern: Copy to Temp

Each skill's SKILL.md instructs the agent to:

1. Copy the `scripts/` folder to a writable temp location
2. Run `npm install` there
3. Run the script from there

```bash
cp -r rebel-system/skills/data-analysis/outlook-email-export-parser/scripts /tmp/outlook-parser
cd /tmp/outlook-parser && npm install
node parse_pst.js ~/Desktop/export.pst ~/Desktop/outlook-export
```

On Windows, use `%TEMP%\outlook-parser` instead of `/tmp/`.

### Why This Works

- The agent (LLM) can follow these instructions reliably
- No app code changes needed
- No build pipeline changes needed
- Works on all platforms
- Tested and verified (spike: 2026-04-17)

### Known Limitations

- Requires network access for `npm install` (won't work offline)
- Install takes a few seconds each time
- Temp dirs may accumulate if not cleaned up
- Agent must remember to do the copy step

## Future Options (Not Currently Needed)

These were evaluated (2026-04-17) and deferred because only 2 skills have this pattern. Revisit when a third skill appears or if real failures are reported.

### Prebundle with esbuild (~150 LOC build script)

Bundle each script + deps into a single `.cjs` file at build time. Agent runs `node .../dist/parse_pst.cjs` directly -- no npm install, no copy.

**Pros:** Zero runtime deps, fast, offline-capable, cleanest UX.
**Cons:** Build complexity, esbuild gotchas with binary parsers and dynamic requires, debugging bundled code is harder.
**Precedent:** `scripts/build-bundled-mcps.mjs` does exactly this for MCP servers.

### Ship node_modules at build time (~60 LOC build script)

A build step runs `npm ci` in each skill's scripts/ dir before packaging. node_modules ships with the app.

**Pros:** Simplest implementation, no bundling gotchas.
**Cons:** Size (~50MB for outlook deps, includes test fixtures), more files in app package.

### App-managed cache dir (significant new subsystem)

The app manages a `~/.rebel/skill-deps/` directory, installing and caching deps automatically.

**Pros:** Best UX (invisible to user/agent), handles versioning.
**Cons:** Substantial new code (locking, invalidation, error handling, offline), overkill for 2 skills.

## Decision Record

**2026-04-17:** Decided to keep the copy-to-temp pattern. Rationale:
- Only 2 skills affected
- Pattern works reliably (tested via spike)
- Zero build/release complexity
- Prebundling deferred until a third skill appears or failures are reported

## Writing New Skills with npm Dependencies

If adding a new skill with npm dependencies:

1. Follow the existing pattern: `scripts/package.json` + `.gitignore` (exclude `node_modules/`, `package-lock.json`)
2. Include copy-to-temp instructions in your SKILL.md (see outlook-email-export-parser for the template)
3. Prefer Node.js scripts over Python (Rebel bundles Node.js, not Python)
4. Prefer pure JS dependencies (no native addons) -- they work cross-platform without compilation
5. Test the full copy-to-temp flow before committing

## Related

- [REBEL_SYSTEM_SYNC](./REBEL_SYSTEM_SYNC.md) -- how rebel-system is bundled into releases
- [REBEL_SYSTEM_FILES](./REBEL_SYSTEM_FILES.md) -- rebel-system directory structure and audience
- [write-skill](../../rebel-system/skills/documentation/write-skill/SKILL.md) -- general skill authoring guide (see `scripts/` section)
- [coding-setup-with-Python](../../rebel-system/help-for-humans/coding-setup-with-Python.md) -- analogous user-facing guide for Python deps
- `scripts/build-bundled-mcps.mjs` -- existing esbuild bundling precedent for MCP servers
