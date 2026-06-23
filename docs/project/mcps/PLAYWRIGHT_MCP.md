---
description: "Deprecated Playwright MCP connector — accessibility-tree browser automation, catalog config, core tools, opt-in capabilities, replacement path"
last_updated: "2026-04-05"
---

# Playwright MCP (DEPRECATED)

> **Deprecated**: The Playwright MCP has been replaced by agent-browser-based Browser Automation. The bundled `browser-automation` connector now uses `agent-browser` CLI instead of `playwright-core`. See `resources/mcp/agent-browser/` for the new implementation.

Official Microsoft Playwright MCP for browser automation via structured accessibility snapshots. Enables navigation, clicking, typing, screenshots, form filling, and content extraction without vision models.

## See Also

- [MCP_ARCHITECTURE.md](../MCP_ARCHITECTURE.md) - How MCPs are configured
- [MCP_IMPROVEMENT_WORKFLOW.md](../MCP_IMPROVEMENT_WORKFLOW.md) - Third-party MCP integration patterns
- [Official Repository](https://github.com/microsoft/playwright-mcp) - Source code and documentation
- [npm package](https://www.npmjs.com/package/@playwright/mcp) - Package registry


## Overview

| Attribute | Value |
|-----------|-------|
| **Provider** | Community (npm package) |
| **Transport** | stdio |
| **Package** | `@playwright/mcp@0.0.68` |
| **License** | Apache-2.0 |
| **Auth** | None |
| **Requires Setup** | No |
| **Status** | Stable (Feb 2026) |


## How It Works

Playwright MCP operates on the browser's accessibility tree rather than screenshots. The LLM receives structured element references (refs) and interacts with them deterministically. This avoids the ambiguity of coordinate-based or vision-model approaches.

The `--isolated` flag is set by default in Rebel's config, which keeps the browser profile in memory (no persistent logins). Users wanting persistent sessions should use the `bundled-browser-automation` connector instead.


## Connector Catalog Entry

```json
{
  "id": "playwright",
  "name": "Playwright",
  "category": "productivity",
  "provider": "community",
  "mcpConfig": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@playwright/mcp@0.0.68", "--isolated"]
  }
}
```


## Core Tools

| Tool | Description | Read-only |
|------|-------------|-----------|
| `browser_navigate` | Navigate to a URL | No |
| `browser_navigate_back` | Go back in history | No |
| `browser_click` | Click an element via accessibility ref | No |
| `browser_hover` | Hover over an element | No |
| `browser_type` | Type text into an editable element | No |
| `browser_fill_form` | Fill multiple form fields at once | No |
| `browser_select_option` | Select dropdown option | No |
| `browser_press_key` | Press a keyboard key | No |
| `browser_snapshot` | Capture accessibility tree snapshot | Yes |
| `browser_take_screenshot` | Take a visual screenshot | Yes |
| `browser_file_upload` | Upload files | No |
| `browser_handle_dialog` | Handle alerts/prompts/confirms | No |
| `browser_wait_for` | Wait for text or time | No |
| `browser_resize` | Resize browser viewport | No |
| `browser_tabs` | List/create/close/select tabs | No |
| `browser_network_requests` | List network requests | Yes |
| `browser_run_code` | Execute arbitrary Playwright code | No |
| `browser_install` | Install browser binaries | No |


## Opt-in Capabilities

Additional tools enabled via `--caps` flag (not enabled by default):

| Capability | Tools Added | Use Case |
|------------|-------------|----------|
| `vision` | `browser_mouse_click_xy`, `browser_mouse_drag_xy`, `browser_mouse_move_xy`, `browser_mouse_down`, `browser_mouse_up`, `browser_mouse_wheel` | Coordinate-based interaction |
| `pdf` | `browser_pdf_save` | Save pages as PDF |
| `testing` | `browser_generate_locator`, `browser_verify_element_visible`, `browser_verify_text_visible`, `browser_verify_value`, `browser_verify_list_visible` | Test assertions |
| `devtools` | Console and JS evaluation tools | Developer debugging |
| `tracing` | `browser_start_trace`, `browser_stop_trace` | Playwright trace recording |

Users can enable these by editing their MCP config to add `--caps vision,pdf` etc.


## Safety Notes

- `browser_run_code` executes arbitrary Playwright JavaScript. Rebel's tool safety system evaluates it as a side-effect verb, so it goes through the standard approval flow at `balanced` safety level.
- The `--isolated` flag prevents persistent session storage, reducing credential leakage risk.
- On first use, Playwright downloads ~200MB of Chromium binaries.
- Browser window opens visibly in headed mode (the default).


## Relationship to Other Browser Connectors

| Connector | Approach | Key Differentiator |
|-----------|----------|-------------------|
| **Playwright** | Accessibility snapshots via npx | Self-contained, no extension, isolated sessions |
| **Browser Automation** (bundled) | DOM-based, persistent profile | Persistent logins across sessions |
| **Browser MCP** (community) | Chrome extension bridge | Operates on existing browser tabs |


## Configuration Options

Key CLI flags (passed in `args`):

| Flag | Description | Default |
|------|-------------|---------|
| `--headless` | Run browser without visible window | headed |
| `--isolated` | Keep profile in memory only | persistent |
| `--browser` | Browser to use: chrome, firefox, webkit, msedge | chromium |
| `--viewport-size` | Viewport dimensions (e.g., "1280x720") | browser default |
| `--caps` | Enable additional capabilities | core only |
| `--user-data-dir` | Custom profile directory | temp directory |

Full configuration reference: [README](https://github.com/microsoft/playwright-mcp#configuration)


## Version History

| Version | Date | Notes |
|---------|------|-------|
| 0.0.68 | 2026-02-14 | Initial catalog addition |
