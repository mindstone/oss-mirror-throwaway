---
description: "Python runtime support in Rebel — built-in skills, Python MCPs, uvx detection, setup guidance for non-technical users"
last_updated: "2026-06-10"
---

# Python Runtime Support

How Mindstone Rebel uses Python across the application - from built-in skills to community MCPs - and how we detect and support Python for non-technical users.

## See Also

- [MCP_IMPROVEMENT_WORKFLOW.md](MCP_IMPROVEMENT_WORKFLOW.md) - When to use `runtime: 'python'` field for MCPs
- [mcps/ELEVENLABS_MCP.md](mcps/ELEVENLABS_MCP.md) - Example Python MCP documentation
- `src/main/services/pythonRuntimeService.ts` - Detection service + macOS shim resolver (`macosCommandResolvesToCltShim`)
- `src/core/services/safety/toolSafetyService.ts` - `macosCltShimGuard` / `windowsPythonGuard` (agent Bash tool shim guards)
- `rebel-system/help-for-humans/coding-setup-with-Python.md` - User-facing Python setup guide
- [Astral uv documentation](https://docs.astral.sh/uv/) - Official uvx/uv installation guide

## Overview

Python is used in several places within Mindstone Rebel:

1. **Built-in skills** - Many Anthropic official skills include Python scripts for document processing, GIF creation, validation, etc.
2. **Community MCPs** - Some MCPs use Python/uvx instead of Node/npx
3. **Agent-executed scripts** - The agent may write and run Python scripts to accomplish tasks

Since our target users are non-technical knowledge workers, we need to:

1. **Detect** if Python/uvx is available on their system
2. **Indicate** which connectors require Python (badges in Settings UI)
3. **Guide** users through setup if Python isn't installed

## Where Python is Used

### Built-in Skills (rebel-system)

The `rebel-system/skills/Anthropic-official-skills/` directory contains many Python scripts:

| Skill | Python Usage |
|-------|--------------|
| `document-skills/Word-document-docx/` | Document parsing, OOXML manipulation |
| `document-skills/PowerPoint-pptx/` | PowerPoint processing (thumbnails, rearrange, replace) |
| `document-skills/pdf/` | PDF form filling, image conversion, validation |
| `document-skills/Excel-xlsx/` | Excel recalculation |
| `slack-gif-creator/` | GIF animation templates (bounce, spin, fade, etc.) |
| `skill-creator/` | Skill packaging and validation |
| `coding/build-custom-mcp-server/` | MCP evaluation scripts (consolidated from Anthropic-mcp-builder) |
| `webapp-testing/` | Server testing utilities |

These scripts are invoked by the agent when executing skill instructions. They require Python 3 to be installed on the user's system.

### Python MCPs

Community MCPs that use `uvx` as their command runner:

| MCP | Description |
|-----|-------------|
| `elevenlabs-mcp` | Voice synthesis and sound effects |

More Python MCPs may be added - check `resources/connector-catalog.json` for entries with `"runtime": "python"`.

### Agent-Written Scripts

The agent can write and execute Python scripts to accomplish tasks like:
- Data processing and analysis
- File format conversions
- Web scraping
- API integrations

## Python Detection Service

### Why Custom Detection?

GUI apps launched from Dock/Finder (macOS) or Start Menu (Windows) don't inherit the user's shell PATH. This means `python3` or `uvx` might work in Terminal but fail when spawned from Electron.

### Libraries Used

| Package | Purpose |
|---------|---------|
| `shell-path` | Gets full PATH from user's login shell (fixes GUI PATH issue) |
| `which` | Cross-platform executable finder |
| `processProbe` (built-in `child_process`) | Process execution with timeouts (prevents hangs) |

### Detection Logic

The service (`src/main/services/pythonRuntimeService.ts`) checks:

1. **Python 3** - In order of preference:
   - Windows: `py -3`, `python3`, `python` (validates version ≥3.0)
   - macOS/Linux: `python3`, `python` (validates version ≥3.0)

2. **uvx** - The Python package runner:
   - Checks PATH (augmented with shell-path)
   - Checks common installation directories

3. **Extra paths checked** (GUI apps often miss these):
   - macOS: `/opt/homebrew/bin`, `~/.local/bin`, `~/.cargo/bin`
   - Windows: `%USERPROFILE%\.local\bin`, `%APPDATA%\Python\Scripts`
   - Linux: `~/.local/bin`, `/usr/local/bin`, `~/.cargo/bin`

### Response Interface

```typescript
interface PythonRuntimeStatus {
  // Primary indicator - determines "ready" vs "setup needed"
  uvxAvailable: boolean;
  uvxVersion: string | null;
  uvxPath: string | null;
  
  // Secondary info
  pythonAvailable: boolean;
  pythonVersion: string | null;
  pythonPath: string | null;
  
  checkedAt: number;  // Cache timestamp
}
```

### Performance

- **5-second timeout** on all subprocess calls (prevents hangs from broken installs)
- **30-second cache** (avoids repeated checks when user browses Settings)
- **Async execution** (doesn't block UI)

## Cross-Platform Installation

### macOS

```bash
# Recommended: Install uv (includes uvx)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Alternative: Homebrew
brew install uv

# Python (if not already installed)
brew install python@3.12
```

Default locations:
- Homebrew Python: `/opt/homebrew/bin/python3`
- uv/uvx: `~/.local/bin/uvx` or `/opt/homebrew/bin/uvx`

### Windows

```powershell
# Recommended: Install uv (includes uvx)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# Alternative: winget
winget install astral-sh.uv

# Python (if not already installed)
winget install Python.Python.3.12
```

Default locations:
- Python: `%LOCALAPPDATA%\Programs\Python\Python312\python.exe`
- Python Launcher: `py.exe` (in PATH)
- uv/uvx: `%USERPROFILE%\.local\bin\uvx.exe`

### Linux

```bash
# Recommended: Install uv (includes uvx)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Alternative: pipx
pipx install uv

# Python (usually pre-installed, or via package manager)
sudo apt install python3  # Debian/Ubuntu
sudo dnf install python3  # Fedora
```

Default locations:
- System Python: `/usr/bin/python3`
- uv/uvx: `~/.local/bin/uvx`

## Python for Built-in Skills

### Dependencies

Built-in skills may require specific Python packages. Common dependencies include:

| Package | Used By | Purpose |
|---------|---------|---------|
| `pillow` | slack-gif-creator, pdf scripts | Image processing |
| `python-docx` | document-skills/Word-document-docx | Word document manipulation |
| `python-pptx` | document-skills/PowerPoint-pptx | PowerPoint manipulation |
| `PyMuPDF` / `fitz` | document-skills/pdf | PDF processing |
| `openpyxl` | document-skills/Excel-xlsx | Excel processing |

The agent typically installs these on-demand using `pip install` or `uv pip install`.

### Execution Model

When the agent executes a skill with Python scripts:

1. Agent reads the skill's SKILL.md for instructions
2. Agent writes or copies the Python script to workspace
3. Agent runs `python3 script.py` (or `python script.py` on Windows)
4. Script output is captured and processed

Scripts run in the user's default Python environment. For isolation, the agent may create a virtual environment.

## Python MCPs: Configuration and Invocation

Python MCPs use `uvx` as the command runner (similar to how Node MCPs use `npx`).

### Connector Catalog Entry

```json
{
  "id": "elevenlabs-mcp",
  "name": "ElevenLabs MCP",
  "provider": "community",
  "mcpConfig": {
    "transport": "stdio",
    "command": "uvx",
    "args": ["elevenlabs-mcp"]
  },
  "runtime": "python",
  "requiresSetup": true,
  "setupFields": [
    { "id": "apiKey", "label": "API Key", "type": "password", "envVar": "ELEVENLABS_API_KEY" }
  ]
}
```

### How uvx Works

`uvx` is part of the [uv](https://docs.astral.sh/uv/) toolchain. It:

1. Creates an isolated virtual environment (cached)
2. Installs the requested package
3. Runs the package's entry point
4. Cleans up (env is cached for next run)

This is analogous to `npx` for Node packages but with Python's faster dependency resolution.

## UI Integration

### Python Badge

Connector cards in Settings show a "Python" badge when `runtime === 'python'`. The badge:
- Uses `FileCode2` icon from lucide-react
- Blue color (informational, not alarming)
- Tooltip: "This connector requires Python"

### Status Indicator

When a Python MCP card is expanded:
- Calls `window.miscApi.checkPythonRuntime()` to check status
- Shows "Python ready ✓" (green) if uvx is available
- Shows "Python setup needed" with "Get help setting up" button if not

### Help Flow

The "Get help setting up" button:
1. Closes Settings dialog
2. Starts a new conversation with a pre-filled prompt
3. Agent guides user through Python/uvx installation
4. Prompt includes restart reminder (PATH changes require app restart)

## Troubleshooting

### "Python not detected" but it's installed

**Cause:** GUI apps don't inherit shell PATH modifications from `.zshrc`/`.bashrc`.

**Solutions:**
1. Restart Rebel after installing Python (picks up PATH changes)
2. Install Python/uvx to a standard location (homebrew, system paths)
3. Check if `uvx --version` works in Terminal first

### uvx found but MCP fails to start

**Cause:** The Python MCP package itself may have issues.

**Solutions:**
1. Try running manually: `uvx <package-name> --help`
2. Check if API key / env vars are configured
3. Check MCP-specific docs in `docs/project/mcps/`

### Windows: "py" not recognized

**Cause:** Python Launcher (`py.exe`) not installed or not in PATH.

**Solutions:**
1. Install Python from python.org (includes launcher)
2. Or use `winget install Python.Python.3.12`
3. Ensure "Add to PATH" was checked during install

### macOS CLT shim hazard

**Cause:** On macOS, `/usr/bin/python3` and `/usr/bin/python` are not real Python interpreters — they're xcode-select tool-shims (`com.apple.dt.xcode_select.tool-shim`). When Command Line Developer Tools (CLT) is not installed, executing either path triggers the OS-native "Install Command Line Developer Tools" dialog. This is the same class of hazard as the Windows Microsoft Store `python3.exe` stub, just plumbed through xcode-select instead of the Store.

**Mitigation:** The detection service probes CLT presence via `xcode-select -p` (which queries state — only `xcode-select --install` triggers the install flow), resolves Python candidates with `/usr/bin/which -a` (path lookup, no exec), and filters out shim paths (`/usr/bin/python3`, `/usr/bin/python`, plus anything whose realpath points there) before any `execFile` call when CLT is missing. See `detectPythonDarwin` in `src/main/services/pythonRuntimeService.ts`.

**Symptom history:** Sentry REBEL-5R0 / Linear FOX-3400 — user saw the Spanish-locale install dialog appear repeatedly while browsing Settings. Each Settings card expansion ran `python3 --version` against the shim, prompting the dialog every time the user clicked "Cancel".

### macOS CLT shim hazard — agent Bash tool path

The CLT shim dialog has two distinct triggers, both fixed for Python and guarded more broadly on the agent Bash path:

| Path | Trigger | Fix | Ticket |
|------|---------|-----|--------|
| Detection service | `detectPythonDarwin` probing `/usr/bin/python3` while browsing Settings | Filter shim paths before any `execFile` (above) | FOX-3400 |
| Agent Bash tool | `runBashTool` exec'ing `python3`, `git`, `make`, `swift`, or another CLT-shimmed binary directly in an agent-authored command | `macosCltShimGuard` pre-tool deny (below) | REBEL-674 / FOX-3482 + Round 3 follow-up |

**Cause:** Even with the detection service hardened, the agent's Bash tool can spawn CLT-shimmed binaries directly — e.g. `python3 script.py`, `/usr/bin/python3 x.py`, `git status`, `make build`, `env swift ...`, or `FOO=bar python3 ...`. On a CLT-missing Mac where the `/usr/bin` shim is the first PATH hit, that spawn pops the same OS "Install Command Line Developer Tools" modal, which the user experiences as Rebel "randomly asking to download developer tools".

**Mitigation:** `macosCltShimGuard` (in `src/core/services/safety/toolSafetyService.ts`, the sibling of the existing `windowsPythonGuard` for the Microsoft Store stub) runs as a PreToolUse safety check. It detects a CLT-shimmed invocation in the command header (`detectMacosCltShimCommandInHeader` handles bare names, absolute `/usr/bin/...` paths, the `env`/`/usr/bin/env` wrapper, and leading `VAR=val` assignments), then calls `macosCommandResolvesToCltShim` (in `src/main/services/pythonRuntimeService.ts`). The resolver:

- Resolves the **FIRST PATH hit** over the SPAWN's PATH (`process.env.PATH`, which is what `runBashTool` actually uses) via `/usr/bin/which -a` — **never** `shellPath()` and **never** `checkPythonRuntime().pythonAvailable`. Gating on "any Python exists" would false-allow when `/usr/bin` precedes Homebrew in the spawn PATH and the shell still hits the shim first; PATH ORDER decides which binary runs.
- Resolves the hit without exec'ing it (exec'ing the shim is precisely what pops the dialog), realpath'ing to catch symlinks pointing at the shim.

When the first hit is the `/usr/bin` shim **and** CLT is missing (`shim_blocked`), the guard returns a plain per-tool **deny** with an agent-steering message. Python keeps its existing guidance: don't retry the same command; accomplish the task without Python, or tell the user to install Python (python.org / `brew install python`). Other developer tools tell the agent not to retry and to suggest `xcode-select --install` only if the user's goal needs that tool. A real Homebrew/uv Python or Homebrew Git (`safe`) runs normally; a missing command (`not_found`) fails naturally with a clear shell error.

**Symptom history:** Sentry REBEL-674 / Linear FOX-3482 — the install dialog appeared when the agent ran a Python command via the Bash tool, distinct from (and surviving) the FOX-3400 detection-service fix. The Round 3 follow-up generalized the same guard to the broader CLT-shimmed binary set (`git`, `clang`, `make`, `swift`, etc.).

### Detection hangs

**Cause:** Broken Python install, antivirus interference, or network shims.

**Mitigation:** Detection has 5-second timeout per check. If it times out, status shows as unavailable.

## Known Limitations

1. **Anaconda/Conda environments** - Detection doesn't find Python in conda envs (only base system/user installs)
2. **WSL on Windows** - Python in WSL isn't detected from Windows Rebel
3. **pyenv** - May work if shims are in PATH, but not guaranteed
4. **Restart required** - After installing Python/uvx, user must restart Rebel for PATH changes to take effect

## Future Considerations

- **Bundled Python** - Could bundle Python like we bundle Node, eliminating setup friction
- **Other runtimes** - Schema supports `runtime: 'ruby'`, `runtime: 'go'` etc. if needed
- **Conda detection** - Could add conda env discovery for data science users
