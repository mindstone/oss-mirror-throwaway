---
description: "End-user installation guide for packaged builds — platform installers, first launch, security prompts, productive setup"
last_updated: "2026-01-16"
---

### Introduction

This guide is for **end‑users** who have received a build of the app and want to install it on macOS, Windows, or Linux, and get to a productive first conversation.


### Who this guide is for

- **Non‑developers and power users** installing a packaged build on macOS (DMG), Windows (EXE installer), or Linux (DEB package).  
- If you are trying to **build or modify the app** itself, use `SETUP_DEVELOPMENT_ENVIRONMENT.md` instead.


### See also

- [SETUP_DEVELOPMENT_ENVIRONMENT.md](SETUP_DEVELOPMENT_ENVIRONMENT.md) – Development environment prerequisites, configuration (core directory, MCP, voice), and "it actually runs" checks
- [GIT_WORKTREES.md](GIT_WORKTREES.md) - Git worktree setup steps (for developers working with multiple branches)
- [ARCHITECTURE_OVERVIEW.md](ARCHITECTURE_OVERVIEW.md) – High-level system architecture, component responsibilities, and data flows
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md](SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) - Canonical reference for app settings, configuration surfaces, and environment variables
- [MCP_ARCHITECTURE.md](MCP_ARCHITECTURE.md) - MCP and Super-MCP configuration, discovery, HTTP vs stdio mode selection
- [VOICE_AND_AUDIO.md](VOICE_AND_AUDIO.md) - Voice/audio pipeline (STT/TTS, permissions, playback) and provider behavior
- [DISTRIBUTION](DISTRIBUTION.md) – Auto-updates, code signing, and platform-specific installation details
- [WINDOWS_SUPPORT.md](WINDOWS_SUPPORT.md) – Windows-specific implementation details and troubleshooting
- [LINUX_SUPPORT.md](LINUX_SUPPORT.md) – Linux-specific implementation details, Ubuntu installation, and troubleshooting


### Installing Mindstone Rebel on macOS

Most users will receive Mindstone Rebel as a **signed DMG file** (for example, `Mindstone Rebel-<version>.dmg`).

- **Step 1 – Download the DMG**
  - Save the `.dmg` file to a convenient location (e.g. `Downloads`).

- **Step 2 – Open the DMG**
  - Double‑click the `.dmg` file in Finder.  
  - A window will open showing the `Mindstone Rebel` app icon.

- **Step 3 – Install the app**
  - Drag the `Mindstone Rebel` icon into the **Applications** folder shortcut.  
  - Wait for the copy to complete, then eject the DMG from Finder when you’re done.

- **Step 4 – Launch the app**
  - Open **Applications** in Finder.  
  - Double‑click **Mindstone Rebel** to launch it.


### First‑time launch and macOS security (Gatekeeper)

Mindstone Rebel is **Developer ID‑signed** by **Mindstone Learning limited**, but it is currently **not notarized**.  
On first launch, macOS may show a warning such as:

> “Mindstone Rebel” cannot be opened because Apple cannot check it for malicious software.

This is expected. To open the app safely:

- **Option 1 – Right‑click Open (recommended)**
  1. In Finder, go to **Applications**.  
  2. Right‑click (or Control‑click) on **Mindstone Rebel**.  
  3. Choose **Open**.  
  4. When the dialog appears, click **Open** again.

- **Option 2 – Use Privacy & Security settings**
  1. Try to open **Mindstone Rebel** once (it will be blocked).  
  2. Open **System Settings → Privacy & Security → General**.  
  3. Look for a message about **“Mindstone Rebel was blocked”**.  
  4. Click **Open Anyway**, then confirm with **Open** in the dialog.

After you do this once, macOS will treat the app as trusted and it will open normally thereafter.

If you want to verify who signed the app, use Finder’s **Get Info** on the app and check that the signer is **Mindstone Learning limited**.



### Installing Mindstone Rebel on Windows

Windows users will receive Mindstone Rebel as an **EXE installer** (for example, `Mindstone Rebel-<version> Setup.exe`).

- **Step 1 – Download the installer**
  - Save the `.exe` file to a convenient location (e.g. `Downloads`).

- **Step 2 – Run the installer**
  - Double-click the `.exe` file to run it.
  - Windows SmartScreen may show a warning for unsigned apps. Click **More info** then **Run anyway** if prompted.

- **Step 3 – Installation completes automatically**
  - The Squirrel.Windows installer runs silently and installs to `%LOCALAPPDATA%\rebel-app\`.
  - A desktop shortcut and Start Menu entry are created automatically.

- **Step 4 – Launch the app**
  - Use the desktop shortcut or find **Mindstone Rebel** in the Start Menu.

**Note:** The app auto-updates via Squirrel.Windows. Future updates will be downloaded and applied automatically on restart.


### Installing Mindstone Rebel on Linux (Ubuntu)

Linux users will receive Mindstone Rebel as a **DEB package** (for example, `mindstone-rebel_<version>_amd64.deb`).

**Supported Distributions:**
- Ubuntu 22.04 LTS
- Ubuntu 24.04 LTS

- **Step 1 – Download the DEB package**
  - Save the `.deb` file to a convenient location (e.g. `Downloads`).

- **Step 2 – Install the package**
  - Open a terminal and run:
    ```bash
    sudo apt install ./mindstone-rebel_<version>_amd64.deb
    ```
  - Or double-click the `.deb` file to open it in your software center.

- **Step 3 – Launch the app**
  - Find **Mindstone Rebel** in your application menu, or run `mindstone-rebel` from the terminal.

**Note:** Linux does not support auto-updates. To update, download and install the new DEB package manually.


#### Ubuntu 24.04 AppArmor Sandbox Issue

Ubuntu 24.04 introduced new AppArmor restrictions that may prevent Electron apps from starting properly. If the app crashes on launch or you see sandbox-related errors in the terminal, apply this workaround:

```bash
# Temporary fix (until reboot):
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0

# Permanent fix:
echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/99-apparmor-userns.conf
sudo sysctl --system
```

This relaxes AppArmor's namespace restrictions to allow the Electron sandbox to function. The app should launch normally after applying this fix.




### First run: what you’ll see

When Mindstone Rebel launches successfully:

- You’ll see a **landing view** in a single window:
  - A short description of the app.  
  - A large **voice button** inviting you to “press to speak”.  
  - Small controls to open **history**, **settings**, and **workspace**.
- From here you can either:
  - Start talking immediately (after granting microphone permission).  
  - Or open **Settings** to configure your workspace and API keys first.


### Granting microphone and file permissions

Mindstone Rebel needs access to your **microphone** and to a **workspace directory** on disk to be most useful.

- **Microphone access**
  - When you first try to use the voice button, macOS will ask for permission to use the microphone.  
  - Click **OK** to allow access.  
  - If you see a banner in the app about microphone permissions, follow its steps; it can also open the relevant System Settings pane for you.

- **Workspace / file access**
  - The app works against a single **workspace directory** called the `coreDirectory`.  
  - On macOS, certain folders (for example `Documents` or external drives) may require extra permissions.  
  - If the app cannot read or write your chosen folder, it will show a workspace permission banner with a button to open the appropriate System Settings page.

You can change these permissions later in **System Settings → Privacy & Security**.


### Choosing a workspace (core directory)

The workspace is the folder that Mindstone Rebel will treat as your **project root**.  
The agent can browse, read, and (when you confirm) edit files inside this directory.

- **Recommended choice**
  - Pick a **project folder** (for example, a Git repository, documentation folder, or knowledge base), not your entire home folder.  
  - This keeps the file tree manageable and focuses the agent on the files you care about.

- **How to set the workspace**
  1. Open **Settings** from the landing view or the app header.  
  2. Find the **Core workspace directory** section.  
  3. Click the picker and choose a folder on disk.  
  4. Confirm the folder in the UI; the workspace sidebar will start showing a file tree based on this directory.

Once a workspace is set:

- The **workspace drawer** lets you browse files and open them in the built‑in editor.  
- The agent will treat this folder as its “world” when answering questions and running tools.

For a deeper explanation of workspace behavior and safety rules, see `LIBRARY_AND_FILE_ACCESS.md`.


### Configuring API keys and voice

Mindstone Rebel can run with **text only**, but voice and some advanced features require API keys.  
All sensitive keys are stored locally in your app settings.

- **Claude / core agent**
  - Depending on your environment, a Claude API key may be configured outside the app (for example via system environment or a local tool).  
  - If your setup requires a key in Settings, you’ll see a field for it under the **Models / Agent** section. Follow the instructions from your organization to populate it.

- **Speech recognition (STT)**
  - In **Settings → Voice**, choose a speech‑to‑text provider:
    - **OpenAI Whisper** (higher accuracy, potentially higher latency).  
    - **ElevenLabs Scribe** (optimized for low latency, good for rapid conversations).
  - Enter the corresponding API key:
    - `openaiApiKey` for OpenAI Whisper.  
    - `elevenlabsApiKey` for ElevenLabs Scribe.

- **Text‑to‑speech (TTS)**
  - Rebel can optionally **speak replies** back to you.  
  - In the same Voice settings, you can configure a TTS provider and voice where available; this may reuse the same provider/API key.

You can always disable voice and use text only if you prefer.
For deeper technical details on the audio pipeline and providers, see `VOICE_AND_AUDIO.md`.


### (Optional) Enabling MCP tools

Mindstone Rebel can connect to **MCP servers** (tools such as filesystem, Git, HTTP, and custom integrations) via a single MCP configuration file.

If your team provides one:

1. Open **Settings → MCP config file**.  
2. Use **Choose…** to select the JSON config file you’ve been given **or** use **Discover** to scan common locations (Claude Desktop, Cursor, Super‑MCP).  
3. Once configured, the agent can call tools described in that file during a conversation.

If you do not have an MCP config file, you can ignore this section; the core agent will still work using local context and your workspace.
For more detail, see `MCP_ARCHITECTURE.md`.


### Your first conversation

Once the app is installed, permissions granted, and (optionally) keys configured:

1. **Set your workspace** if you haven’t already.  
2. Decide whether to start with **voice** or **text**:
   - For voice: click the large voice button, speak your question, then release. The transcript will appear and the agent will respond.  
   - For text: switch to text mode in the recorder strip and type your question, then press **Send**.
3. Watch the **conversation pane** as the agent thinks, calls tools, and replies.  
4. Use the **workspace drawer** to open files that the agent mentions, or to inspect edits.

You can keep asking follow‑up questions in the same conversation; the agent will use previous messages and your workspace to maintain context.


### Working with history and conversations

Mindstone Rebel organizes your discussions into **conversations**:

- The **Conversations sidebar** shows your recent conversations with titles and timestamps.  
- Clicking a conversation restores its transcript so you can continue where you left off.  
- You can delete conversations you no longer need directly from the sidebar.

Conversations are stored locally on your machine and are **bounded in number** so that old ones are eventually cleaned up.  
For a deeper explanation of how sessions and history work, see `ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md`.


### Basic troubleshooting

If things don’t work as expected, try the following:

- **The app doesn’t open at all**
  - Make sure you followed one of the Gatekeeper flows in **“First‑time launch and macOS security”** above.  
  - Check **System Settings → Privacy & Security → General** for an “Open Anyway” button for Mindstone Rebel.

- **Microphone doesn’t work / voice button is disabled**
  - Check for a banner inside the app about microphone permissions and follow its instructions.  
  - In **System Settings → Privacy & Security → Microphone**, ensure **Mindstone Rebel** is allowed to use the microphone.

- **Workspace is empty or file operations fail**
  - Open **Settings** and confirm that **Core workspace directory** is set to a folder you can access.  
  - If the app shows a workspace permission banner, use its button to open the Files/Full Disk Access settings and grant access.  
  - Consider choosing a folder under your home directory (for example `~/dev/my-project`) instead of system folders.

- **Agent replies mention missing tools or APIs**
  - Confirm that any required API keys (Claude, OpenAI, ElevenLabs) are correctly entered in **Settings**.  
  - If MCP tools are expected but not available, check that the MCP config file path is set under **Settings → MCP config file**.

If problems persist, collecting logs can help your team or support investigate:
- **macOS:** `~/Library/Application Support/mindstone-rebel/logs/`
- **Windows:** `%APPDATA%\mindstone-rebel\logs\`
- **Linux:** `~/.config/mindstone-rebel/logs/`

For deeper technical debugging, see `SETUP_DEVELOPMENT_ENVIRONMENT.md`, `ARCHITECTURE_OVERVIEW.md`, `DISTRIBUTION.md`, `WINDOWS_SUPPORT.md`, and `LINUX_SUPPORT.md`.


