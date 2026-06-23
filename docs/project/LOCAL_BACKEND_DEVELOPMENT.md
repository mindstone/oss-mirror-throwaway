---
description: "Local backend development guide — running Electron against rebel-platform, OAuth setup, environment scripts, and verification"
last_updated: "2026-01-27"
---

### Introduction

This guide explains how to run the Mindstone Rebel frontend against a locally-running `rebel-platform` backend. This is useful for:

- Developing and testing backend changes alongside the Electron app
- Debugging authentication flows end-to-end
- Testing API integrations without affecting production


### See also

- [AUTHENTICATION.md](AUTHENTICATION.md) – OAuth, OTP, guest mode, token management, and offline support
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md](SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) – Canonical reference for app settings, configuration surfaces, and environment variables
- [SETUP_DEVELOPMENT_ENVIRONMENT.md](SETUP_DEVELOPMENT_ENVIRONMENT.md) – Dev prerequisites, configuration, and "it actually runs" checks


### Prerequisites

Before setting up local backend development, you'll need:

1. **Docker** – The backend runs in Docker containers
2. **gcloud CLI** – Required for authentication to GCP Secret Manager
3. **GCP access** – Access to the `nspr-bloom-staging` project (for OAuth credentials)
4. **rebel-platform repository** – Clone of the backend codebase


### Quick Start

1. **Authenticate with GCP** (one-time setup):
   ```bash
   gcloud auth application-default login
   ```

2. **Start the backend** (in the rebel-platform repo):
   ```bash
   # Follow rebel-platform's README for full setup
   pnpm dev
   ```

3. **Start the Electron app** (in the rebel-app repo):
   ```bash
   npm run dev:local
   ```

That's it! The `dev:local` script automatically sets `REBEL_API_URL=http://localhost:8080`.


### Backend Setup

The backend setup is documented in the `rebel-platform` repository. Key points:

- The backend runs on `http://localhost:8080` by default
- It uses Docker Compose for local development
- OAuth credentials are fetched from GCP Secret Manager (staging environment)
- Refer to `rebel-platform/README.md` for detailed setup instructions


### Frontend Setup

**Recommended: Use the npm scripts**

```bash
npm run dev          # Points at production (https://rebel.mindstone.com)
npm run dev:s101     # Points at staging (https://rebel.s101.mindstone.dev)
npm run dev:local    # Points at local backend (http://localhost:8080)
```

**Alternative: Manual environment variable**

If you need a different backend URL:

macOS/Linux:
```bash
export REBEL_API_URL=http://localhost:8080
npm run dev
```

Windows PowerShell:
```powershell
$env:REBEL_API_URL="http://localhost:8080"
npm run dev
```

**Verifying the connection**

1. Start the Electron app with `npm run dev:local`
2. Attempt to sign in – the OAuth flow should redirect through your local backend
3. Check the backend terminal for incoming requests (you should see `/api/auth/*` requests)


### OAuth Notes

OAuth authentication works the same way in local development:

- **PKCE flow**: The app uses OAuth 2.0 with PKCE (Proof Key for Code Exchange)
- **Loopback redirect**: OAuth redirects to `127.0.0.1` on a dynamic port
- **Backend credentials**: The local backend fetches OAuth client credentials from GCP Secret Manager (staging project)
- **Provider configuration**: Google, Slack, and HubSpot OAuth are configured in the staging GCP project

**Important**: You must run `gcloud auth application-default login` before starting the backend so it can access the staging secrets.


### Troubleshooting

**Backend won't start**

- Ensure Docker is running
- Check that you've run `gcloud auth application-default login`
- Verify you have access to the `nspr-bloom-staging` GCP project

**OAuth fails**

- Confirm the backend is running and accessible at `http://localhost:8080`
- Check that `REBEL_API_URL` is set correctly (no trailing slash)
- Look at backend logs for OAuth-related errors
- Ensure your GCP credentials haven't expired: `gcloud auth application-default login`

**App still connects to production**

- Verify `REBEL_API_URL` is exported in your current shell
- If using `.env.local`, ensure the file exists in the project root
- Restart the Electron app after changing environment variables

**CORS errors**

- The local backend should be configured to allow requests from the Electron app
- Check backend CORS settings if you see cross-origin errors in devtools


### Maintenance

- When authentication flows or backend URLs change, update this document
- Keep the troubleshooting section current with common issues
- Link to `rebel-platform` documentation rather than duplicating setup details
