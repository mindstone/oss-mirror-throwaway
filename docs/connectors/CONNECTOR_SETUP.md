# Connector setup guide (bring your own OAuth app)

This is the setup guide the in-app **"Connector setup"** dialog links to.

## Why connectors need setup

Rebel's OAuth connectors are **broken-by-default** in the open-source build. The
source tree ships with **no embedded OAuth client IDs or secrets** — Rebel reads
client credentials from the environment only. Until you register your own OAuth
app with a provider and supply the matching environment variables, that
connector cannot authenticate and the app shows a "needs an OAuth app" setup
dialog instead of starting the flow.

To enable a connector you:

1. Register an OAuth app in the provider's developer console.
2. Add the redirect URI(s) Rebel expects to that app.
3. Put the resulting client ID (and secret, where required) into the
   environment used to start Rebel.
4. Restart Rebel and connect.

### About the redirect URI

Most connectors complete OAuth through Rebel's **hosted callback worker** at
`https://rebel-auth.mindstone.com/<provider>/callback`. This worker is provided
on a **best-effort basis with no SLA** — it exists so the default desktop
experience works without you running any server infrastructure.

If you would rather not depend on it, every worker-backed connector's redirect
is **overridable** with a `<PROVIDER>_REDIRECT_URI` environment variable (for
example `SLACK_REDIRECT_URI`). Point it at a self-hosted worker that implements
the same callback/start routes, and register that URI in your OAuth app instead.

Two connectors do **not** use the worker:

- **Google** uses a localhost loopback (register the client as a "Desktop app").
- **HubSpot** uses fixed localhost loopback ports (register all four).

See each connector's section below for the exact value(s) to register.

### Where the environment variables go

Set the variables in **the environment that starts the app**:

- **Running from source:** create a `.env.local` file at the repository root and
  add the variables there. **Restart** the app after editing it.
- **Other launch methods:** export the variables in the shell/service
  environment that launches Rebel before it starts.

Variable values are read at launch, so a restart is always required after a
change.

---

## Slack

- **Register at:** <https://api.slack.com/apps>
- **Redirect URI to register:** `https://rebel-auth.mindstone.com/slack/callback`
  (override with `SLACK_REDIRECT_URI`).
- **Environment variables:**

  ```bash
  SLACK_CLIENT_ID=your_slack_oauth_client_id
  SLACK_CLIENT_SECRET=your_slack_oauth_client_secret
  ```

- **Scopes:** Rebel requests the bot and user scopes it needs (channel/message
  read + write, file read, reactions, search) automatically during the OAuth
  consent step — you do not pre-configure them in the app beyond enabling the
  OAuth flow.

## Google

- **Register at:** <https://console.cloud.google.com/apis/credentials>
- **Redirect URI to register:** none to pre-register. Create the OAuth client as
  a **"Desktop app"** — Google then permits a localhost loopback redirect
  (`http://127.0.0.1:<port>/callback`, where the port is assigned at connect
  time) without registering a specific URI.
- **Environment variables:**

  ```bash
  GOOGLE_CLIENT_ID=your_google_oauth_client_id
  GOOGLE_CLIENT_SECRET=your_google_oauth_client_secret
  ```

- **Scopes:** Rebel requests Google Workspace scopes (Gmail, Calendar, Drive,
  Docs/Sheets/Slides, Contacts) during consent. You can decline individual
  scopes on the Google consent screen; declined scopes disable the matching
  features. While your OAuth app is in "Testing" you must add each connecting
  account as a test user in the Google Cloud console.

## HubSpot

- **Register at:** <https://app.hubspot.com/developer>
- **Redirect URIs to register:** add **all four** localhost callback URLs (Rebel
  picks the first free port in the range at connect time):

  ```text
  http://localhost:8081/callback
  http://localhost:8082/callback
  http://localhost:8083/callback
  http://localhost:8084/callback
  ```

  HubSpot uses local loopback, not the hosted worker, so there is no
  `<PROVIDER>_REDIRECT_URI` override for it.
- **Environment variables:**

  ```bash
  HUBSPOT_CLIENT_ID=your_hubspot_oauth_client_id
  HUBSPOT_CLIENT_SECRET=your_hubspot_oauth_client_secret
  ```

- **Scopes:** Rebel requests CRM read scopes (contacts, companies, deals,
  products, line items, lists, owners) plus optional write/extended scopes.
  Configure the same scopes in your HubSpot app's auth settings; some optional
  scopes require a paid HubSpot tier.

## GitHub

- **Register at:** <https://github.com/settings/developers> (create an OAuth App)
- **Redirect URI to register:** `https://rebel-auth.mindstone.com/github/callback`
  (override with `GITHUB_REDIRECT_URI`).
- **Environment variables:**

  ```bash
  GITHUB_CLIENT_ID=your_github_oauth_client_id
  GITHUB_CLIENT_SECRET=your_github_oauth_client_secret
  ```

## Microsoft

- **Register at:** <https://entra.microsoft.com/> (Microsoft Entra admin center →
  App registrations)
- **Redirect URI to register:** `https://rebel-auth.mindstone.com/microsoft/callback`
  (override with `MICROSOFT_REDIRECT_URI`).
- **Environment variables:** Microsoft uses the **PKCE public-client** flow, so
  you supply a **client ID only** — there is no client secret.

  ```bash
  MICROSOFT_CLIENT_ID=your_microsoft_public_client_id
  ```

- **Notes:** register the app as a public client / native app and add the
  redirect URI under the platform configuration. Rebel requests Microsoft Graph
  scopes (mail, calendar, files) during consent.

## Plaud

Plaud's OAuth API is currently in **early beta / limited access (waitlist)**, so
there is no general self-serve way to register an OAuth app today. Once you have
been granted access, follow Plaud's authorization guide and supply the
credentials they issue.

- **Reference:** <https://plaud.mintlify.app/api_guide/api_intro/authorization>
- **Redirect URI to register:** `https://rebel-auth.mindstone.com/plaud/callback`
  (override with `PLAUD_REDIRECT_URI`).
- **Environment variables:**

  ```bash
  PLAUD_CLIENT_ID=your_plaud_oauth_client_id
  PLAUD_CLIENT_SECRET=your_plaud_oauth_client_secret
  ```

This connector is intentionally not self-serve in the UI — it shows honest
limited-access copy rather than promising a register-an-app flow.

## DigitalOcean

- **Register at:** <https://cloud.digitalocean.com/account/api/applications>
- **Redirect URI to register:** `https://rebel-auth.mindstone.com/digitalocean/callback`
  (override with `DIGITAL_OCEAN_REDIRECT_URI`).
- **Environment variables:**

  ```bash
  DIGITAL_OCEAN_CLIENT_ID=your_digital_ocean_oauth_client_id
  DIGITAL_OCEAN_CLIENT_SECRET=your_digital_ocean_oauth_client_secret
  ```

## Salesforce

Salesforce has no universal developer console — you create a **Connected App**
inside your own Salesforce org (Setup → App Manager → New Connected App) and
enable OAuth settings on it.

- **Reference:** <https://help.salesforce.com/s/articleView?id=sf.connected_app_create.htm&type=5>
- **Redirect URI to register:** `https://rebel-auth.mindstone.com/salesforce/callback`
  (override with `SALESFORCE_REDIRECT_URI`).
- **Environment variables:**

  ```bash
  SALESFORCE_CLIENT_ID=your_salesforce_connected_app_client_id
  SALESFORCE_CLIENT_SECRET=your_salesforce_connected_app_client_secret
  ```

- **Scopes:** enable the `api`, `refresh_token`, and `offline_access` OAuth
  scopes on the Connected App so Rebel can call the API and refresh tokens.

---

## A note on Discourse

Discourse is **not** an OAuth-client connector and is intentionally absent from
the list above. It uses Discourse's built-in **User API Key** flow: Rebel
generates a per-connection key pair and registers itself with the Discourse site
at connect time, so there is **no OAuth app to register and no client ID/secret
to set**. Just connect to your Discourse site from within the app and approve
the User API Key request there.
