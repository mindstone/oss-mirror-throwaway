#!/usr/bin/env node

// Assigns the latest TestFlight build to an external beta group via the
// App Store Connect API. Requires an ASC API key (Key ID, Issuer ID, and
// private key in PEM/P8 format).
//
// Required env vars:
//   ASC_KEY_ID          - App Store Connect API Key ID
//   ASC_ISSUER_ID       - App Store Connect Issuer ID
//   ASC_PRIVATE_KEY     - Private key contents (.p8 PEM string)
//   ASC_APP_ID          - Numeric App Store Connect app ID (e.g. 6760136915)
//   ASC_BETA_GROUP_NAME - Name of the external test group to assign the build to
//
// Usage:
//   node scripts/ci/assign-testflight-group.mjs

import { createSign } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY, ASC_APP_ID, ASC_BETA_GROUP_NAME } = process.env;

if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_PRIVATE_KEY || !ASC_APP_ID || !ASC_BETA_GROUP_NAME) {
  console.error('Missing required env vars: ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY, ASC_APP_ID, ASC_BETA_GROUP_NAME');
  process.exit(1);
}

const ASC_BASE = 'https://api.appstoreconnect.apple.com/v1';

function base64url(data) {
  return Buffer.from(data).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function derToRaw(derSig) {
  let offset = 2;
  if (derSig[1] & 0x80) offset += (derSig[1] & 0x7f);

  offset += 1; // 0x02
  const rLen = derSig[offset++];
  const r = derSig.subarray(offset, offset + rLen);
  offset += rLen;

  offset += 1; // 0x02
  const sLen = derSig[offset++];
  const s = derSig.subarray(offset, offset + sLen);

  const rTrimmed = r[0] === 0 ? r.subarray(1) : r;
  const sTrimmed = s[0] === 0 ? s.subarray(1) : s;
  const raw = Buffer.alloc(64);
  rTrimmed.copy(raw, 32 - rTrimmed.length);
  sTrimmed.copy(raw, 64 - sTrimmed.length);
  return raw;
}

function generateJWT() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' };
  const payload = { iss: ASC_ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;

  const sign = createSign('SHA256');
  sign.update(signingInput);
  const derSig = sign.sign(ASC_PRIVATE_KEY);
  const encodedSig = Buffer.from(derToRaw(derSig)).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  return `${signingInput}.${encodedSig}`;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ascFetch(path, options = {}, { retries = 3, backoffMs = 1000 } = {}) {
  const url = path.startsWith('http') ? path : `${ASC_BASE}${path}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const token = generateJWT();
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (res.status === 204) return null;
    if (res.ok) return res.json();

    const body = await res.text();

    const isRetryable = res.status >= 500 || res.status === 429;
    if (isRetryable && attempt < retries) {
      const delay = backoffMs * 2 ** attempt;
      console.warn(`ASC API ${res.status} (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms...`);
      await sleep(delay);
      continue;
    }

    const suffix = isRetryable ? ` (after ${attempt + 1} attempts)` : '';
    throw new Error(`ASC API ${res.status}${suffix}: ${body}`);
  }
}

async function findBetaGroup() {
  const data = await ascFetch(`/apps/${ASC_APP_ID}/betaGroups`);
  const group = data.data.find((g) => g.attributes.name === ASC_BETA_GROUP_NAME);
  if (!group) {
    console.error(`Beta group "${ASC_BETA_GROUP_NAME}" not found. Available groups:`);
    data.data.forEach((g) => console.error(`  - "${g.attributes.name}" (${g.id})`));
    process.exit(1);
  }
  return group.id;
}

async function findLatestBuild() {
  const data = await ascFetch(
    `/builds?filter[app]=${ASC_APP_ID}&filter[processingState]=VALID&sort=-uploadedDate&limit=1&fields[builds]=version,uploadedDate,processingState`
  );
  if (!data.data.length) {
    throw new Error('No valid builds found for app');
  }
  const build = data.data[0];
  console.log(`Latest build: ${build.attributes.version} (uploaded ${build.attributes.uploadedDate})`);
  return build.id;
}

async function assignBuildToGroup(buildId, groupId) {
  await ascFetch(`/builds/${buildId}/relationships/betaGroups`, {
    method: 'POST',
    body: JSON.stringify({ data: [{ type: 'betaGroups', id: groupId }] }),
  });
}

async function setReleaseNotes(buildId, notes) {
  // Get existing localizations
  const data = await ascFetch(`/builds/${buildId}/betaBuildLocalizations`);
  const existing = data.data.find((l) => l.attributes.locale === 'en-US');

  if (existing) {
    // Update existing localization
    await ascFetch(`/betaBuildLocalizations/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        data: {
          type: 'betaBuildLocalizations',
          id: existing.id,
          attributes: { whatsNew: notes },
        },
      }),
    });
  } else {
    // Create new localization
    await ascFetch('/betaBuildLocalizations', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'betaBuildLocalizations',
          attributes: { locale: 'en-US', whatsNew: notes },
          relationships: {
            build: { data: { type: 'builds', id: buildId } },
          },
        },
      }),
    });
  }
}

// Ensures TestFlight testers are auto-notified once the build is approved.
// This is a per-build flag; we set it to `true` to match the expectation of
// "new build lands → testers get notified automatically".
async function enableAutoNotify(buildId) {
  const detail = await ascFetch(`/builds/${buildId}/buildBetaDetail`);
  if (!detail?.data?.id) {
    throw new Error('Could not resolve buildBetaDetail id for build');
  }
  await ascFetch(`/buildBetaDetails/${detail.data.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      data: {
        type: 'buildBetaDetails',
        id: detail.data.id,
        attributes: { autoNotifyEnabled: true },
      },
    }),
  });
}

// Submits the build for Beta App Review so external TestFlight groups can
// actually receive it. Without this step, uploaded builds sit in
// "Ready to Submit" forever and external testers never get the new build.
// Idempotent: checks for an existing submission before POSTing, and treats
// 409 Conflict (already submitted) as success.
async function submitForBetaReview(buildId) {
  // Check if a submission already exists — avoids 409 on reruns.
  try {
    const existing = await ascFetch(`/builds/${buildId}/betaAppReviewSubmission`);
    if (existing?.data?.id) {
      const state = existing.data.attributes?.betaReviewState ?? 'UNKNOWN';
      console.log(`Beta App Review submission already exists (state: ${state}) — skipping.`);
      return;
    }
  } catch (err) {
    // 404 here means "no submission yet", which is the normal path.
    if (!/ASC API 404/.test(err.message)) {
      throw err;
    }
  }

  try {
    await ascFetch('/betaAppReviewSubmissions', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'betaAppReviewSubmissions',
          relationships: {
            build: { data: { type: 'builds', id: buildId } },
          },
        },
      }),
    });
    console.log('Submitted build for Beta App Review.');
  } catch (err) {
    // 409 Conflict means a submission already exists — treat as success.
    if (/ASC API 409/.test(err.message)) {
      console.log('Beta App Review submission already exists (409 Conflict) — continuing.');
      return;
    }
    throw err;
  }
}

async function main() {
  console.log(`Finding beta group "${ASC_BETA_GROUP_NAME}"...`);
  const groupId = await findBetaGroup();
  console.log(`Found group: ${groupId}`);

  console.log('Finding latest build...');
  const buildId = await findLatestBuild();

  console.log(`Assigning build ${buildId} to group ${groupId}...`);
  await assignBuildToGroup(buildId, groupId);
  console.log('Done — build assigned to external test group.');

  // Set release notes (best-effort — never fail the build)
  try {
    const notesFile = process.env.ASC_RELEASE_NOTES_FILE;
    if (notesFile && existsSync(notesFile)) {
      let notes = readFileSync(notesFile, 'utf-8').trim();
      if (notes) {
        if (notes.length > 4000) {
          const lastNewline = notes.lastIndexOf('\n', 4000);
          notes = lastNewline > 0 ? notes.substring(0, lastNewline) : notes.substring(0, 4000);
        }
        console.log('Setting release notes...');
        await setReleaseNotes(buildId, notes);
        console.log('Done — release notes set.');
      }
    }
  } catch (err) {
    console.warn('Warning: Failed to set release notes:', err.message);
  }

  // Enable auto-notify so approved builds roll out to testers without manual
  // intervention. Best-effort — don't fail the build on a flaky ASC PATCH.
  try {
    console.log('Enabling auto-notify for testers...');
    await enableAutoNotify(buildId);
    console.log('Done — auto-notify enabled.');
  } catch (err) {
    console.warn('Warning: Failed to enable auto-notify:', err.message);
  }

  // Submit for Beta App Review. This is the step that was previously missing
  // and caused external testers to stay stuck on old builds. We fail the job
  // if submission fails, because without it the build cannot reach external
  // testers — silent failure here is exactly what landed us in this mess.
  console.log('Submitting build for Beta App Review...');
  await submitForBetaReview(buildId);
  console.log('Done — build submitted for Beta App Review. External testers will receive it once Apple approves.');
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
