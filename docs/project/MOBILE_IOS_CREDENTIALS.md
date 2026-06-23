---
description: "EAS Build iOS credential setup for mobile releases — App Store Connect API keys, team IDs, env vars, troubleshooting"
last_updated: "2026-03-27"
---

# iOS Credentials Setup for EAS Build

How to set up iOS credentials (provisioning profiles, distribution certificates) for EAS Build using an App Store Connect API Key instead of Apple ID/password login.

## When You Need This

- First time building with a new iOS target (e.g., adding a widget extension)
- `eas build` fails with "Failed to set up credentials. Credentials are not set up."
- Apple ID login via `eas credentials` fails with authentication errors

## Prerequisites

You need an **App Store Connect API Key** (`.p8` file). If you already have one, skip to [Running the Build](#running-the-build).

## Creating an App Store Connect API Key

1. Go to [App Store Connect > Users and Access > Integrations > App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api)
2. Click **Generate API Key** (or the **+** button)
3. Give it a name (e.g., "EAS Build")
4. Select the **Admin** role (required for provisioning profile management)
5. Click **Generate**
6. **Download the `.p8` file immediately** — Apple only lets you download it once
7. Note the **Key ID** (shown in the table, e.g., `A86K9LT4AQ`)
8. Note the **Issuer ID** (shown at the top of the page)

Store the `.p8` file somewhere safe and permanent (e.g., `~/.appstoreconnect/AuthKey_<KEY_ID>.p8`).

## Finding Your Apple Team ID

1. Go to [developer.apple.com/account](https://developer.apple.com/account)
2. Your **Team ID** is shown under Membership details (e.g., `6HGKU9RW3U`)
3. Note your **Team Type**: `COMPANY_OR_ORGANIZATION`, `INDIVIDUAL`, or `IN_HOUSE`

You can also find these on [expo.dev](https://expo.dev) under your project's Credentials > Apple Teams.

## Running the Build

Set these environment variables and run `eas build` (interactive mode, no `--non-interactive`):

```bash
cd mobile && \
  EXPO_ASC_API_KEY_PATH="/path/to/AuthKey_XXXXXXXXXX.p8" \
  EXPO_ASC_KEY_ID="XXXXXXXXXX" \
  EXPO_ASC_ISSUER_ID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" \
  EXPO_APPLE_TEAM_ID="XXXXXXXXXX" \
  EXPO_APPLE_TEAM_TYPE="COMPANY_OR_ORGANIZATION" \
  eas build --profile production --platform ios
```

EAS will use the API key to authenticate with Apple Developer Portal and automatically create any missing provisioning profiles (e.g., for widget extensions).

Once credentials are set up on EAS servers, subsequent `--non-interactive` CI builds will reuse them without needing the API key.

## Environment Variables Reference

| Variable | Description | Example |
|---|---|---|
| `EXPO_ASC_API_KEY_PATH` | Path to your `.p8` key file | `~/.appstoreconnect/AuthKey_A86K9LT4AQ.p8` |
| `EXPO_ASC_KEY_ID` | Key ID from App Store Connect | `A86K9LT4AQ` |
| `EXPO_ASC_ISSUER_ID` | Issuer ID from App Store Connect | `f9675cff-f45d-4116-bd2c-2372142cee09` |
| `EXPO_APPLE_TEAM_ID` | Apple Developer Team ID | `6HGKU9RW3U` |
| `EXPO_APPLE_TEAM_TYPE` | Team type | `COMPANY_OR_ORGANIZATION` / `INDIVIDUAL` / `IN_HOUSE` |

## Troubleshooting

**Apple ID login fails with "Buffer" error**: This is a known eas-cli bug. Use the API key approach above instead.

**"Credentials are not set up" in CI**: Run `eas build` interactively once (locally) with the API key env vars to create the credentials. After that, CI non-interactive builds will work.

**Lost your `.p8` file**: Create a new API key at [appstoreconnect.apple.com](https://appstoreconnect.apple.com/access/integrations/api). Old keys can be revoked there too.
