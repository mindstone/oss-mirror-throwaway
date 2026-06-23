---
description: "CASA Tier 2 security scan runbook for Rebel OAuth compliance — source zipping, Fluid Attacks SAST, outputs, submission"
last_updated: "2026-03-22"
---

# CASA Security Scan

CASA (Cloud Application Security Assessment) is Google's security assessment framework required for apps using sensitive OAuth scopes. This document covers running the CASA Tier 2 SAST scan for Mindstone Rebel.

## See Also

- [SAFETY_SYSTEM_OVERVIEW.md](SAFETY_SYSTEM_OVERVIEW.md) - Safety system overview
- [App Defense Alliance CASA docs](https://appdefensealliance.dev/casa/tier-2/ast-guide/static-scan) - Official CASA scanning procedures
- `scripts/casa-create-zip.sh` - Zip creation script
- `scripts/casa-run-scan.sh` - Full scan script

## Quick Start

```bash
# Generate zip file only (for manual submission)
./scripts/casa-create-zip.sh

# Run full CASA scan (CASA-required checks only)
./scripts/casa-run-scan.sh

# Run full scan with ALL security checks
./scripts/casa-run-scan.sh --all
```

## Output Files

All outputs go to the `casa/` directory (gitignored):

| File | Description |
|------|-------------|
| `casa/mindstone-rebel-source-for-casa.zip` | Source code zip for submission |
| `casa/Fluid-Attacks-Results.csv` | Scan results |
| `casa/scan-work/` | Temporary working directory |

## What Gets Scanned

The zip includes application source code but excludes:
- `node_modules/`, build outputs (`dist/`, `out/`, `build/`)
- Environment files (`.env`, `.env.*`)
- Editor configs (`.vscode/`, `.idea/`)
- AI agent files (`AGENTS.md`, `CLAUDE.md`)
- Scripts (`scripts/`)
- Logs and temporary files

See `scripts/casa-create-zip.sh` for the complete exclusion list.

## How It Works

1. **Zip creation** - `casa-create-zip.sh` packages source code with appropriate exclusions
2. **Config download** - Downloads official CASA checks from App Defense Alliance
3. **Scan execution** - Runs Fluid Attacks SAST scanner via Docker
4. **Results** - Outputs CSV with findings

The scanner uses the `fluidattacks/sast` Docker image with checks specified by Google's App Defense Alliance.

## Understanding Results

Common findings:
- **F086 (Missing subresource integrity)** - HTML files loading CDN scripts without `integrity` attribute. Low severity, typically in documentation files not shipped with the app.

## Submission Process

1. Run `./scripts/casa-create-zip.sh` to generate the zip
2. Upload `casa/mindstone-rebel-source-for-casa.zip` to the CASA portal
3. If self-scanning, also upload `casa/Fluid-Attacks-Results.csv`

## Requirements

- Docker (or OrbStack) for running the Fluid Attacks scanner
- Internet access to download the official CASA config from App Defense Alliance
