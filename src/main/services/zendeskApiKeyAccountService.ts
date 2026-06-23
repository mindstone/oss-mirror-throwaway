import { URL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { app } from 'electron';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'zendesk-api-key-accounts' });

export interface ZendeskAccount {
  subdomain: string;
  email: string;
  apiToken?: string;
  authenticatedAt?: string;
}

interface AccountsConfig {
  accounts: ZendeskAccount[];
  defaultSubdomain?: string;
}

const extractHostnameFromUserInput = (input: string): string => {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return trimmed
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .split('/')[0]
      .split('?')[0]
      .split('#')[0]
      .split(':')[0];
  }
};

export function validateZendeskSubdomain(input: string): string {
  const hostname = extractHostnameFromUserInput(input);
  let subdomain = hostname.trim().toLowerCase().replace(/\.$/, '');

  if (subdomain.endsWith('.zendesk.com')) {
    subdomain = subdomain.slice(0, -'.zendesk.com'.length);
  }

  if (subdomain.includes('.')) {
    throw new Error(
      'Invalid Zendesk subdomain: should be just the subdomain part (e.g., "acme" for acme.zendesk.com)',
    );
  }

  const singleCharRegex = /^[a-z0-9]$/;
  const multiCharRegex = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

  if (subdomain.length === 0) {
    throw new Error('Zendesk subdomain cannot be empty');
  }

  if (subdomain.length === 1) {
    if (!singleCharRegex.test(subdomain)) {
      throw new Error('Invalid Zendesk subdomain: must contain only letters, numbers, and hyphens');
    }
  } else if (!multiCharRegex.test(subdomain)) {
    throw new Error(
      'Invalid Zendesk subdomain: must contain only letters, numbers, and hyphens, and cannot start or end with a hyphen',
    );
  }

  return subdomain;
}

function getZendeskConfigDir(): string {
  return path.join(app.getPath('userData'), 'mcp', 'zendesk');
}

function getCredentialsDir(): string {
  return path.join(getZendeskConfigDir(), 'credentials');
}

function getAccountsPath(): string {
  return path.join(getZendeskConfigDir(), 'accounts.json');
}

function sanitizeSubdomain(subdomain: string): string {
  return subdomain.replace(/[^a-zA-Z0-9-]/g, '-');
}

function getLegacyTokenPath(subdomain: string): string {
  return path.join(getCredentialsDir(), `${sanitizeSubdomain(subdomain)}.token.json`);
}

async function loadAccounts(): Promise<AccountsConfig> {
  try {
    const data = await fs.readFile(getAccountsPath(), 'utf-8');
    return JSON.parse(data) as AccountsConfig;
  } catch {
    return { accounts: [] };
  }
}

async function saveAccounts(config: AccountsConfig): Promise<void> {
  const configDir = getZendeskConfigDir();
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(getAccountsPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export async function getZendeskAccounts(): Promise<
  Array<{
    subdomain: string;
    email: string;
    status: 'active' | 'expired' | 'error';
  }>
> {
  const config = await loadAccounts();
  return config.accounts.map((account) => ({
    subdomain: account.subdomain,
    email: account.email,
    status: account.apiToken ? 'active' : 'error',
  }));
}

export async function addZendeskApiKeyAccount(
  rawSubdomain: string,
  email: string,
  apiToken: string,
): Promise<{ subdomain: string; email: string }> {
  const subdomain = validateZendeskSubdomain(rawSubdomain);
  const trimmedEmail = email.trim();
  const trimmedToken = apiToken.trim();

  if (!trimmedEmail) throw new Error('Email is required');
  if (!trimmedToken) throw new Error('API token is required');

  const authString = Buffer.from(`${trimmedEmail}/token:${trimmedToken}`).toString('base64');
  const response = await fetch(`https://${subdomain}.zendesk.com/api/v2/users/me.json`, {
    method: 'GET',
    headers: { Authorization: `Basic ${authString}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  }).catch((err: Error) => {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error('Zendesk API request timed out. Check your internet connection and subdomain.');
    }
    throw new Error(`Failed to reach Zendesk API: ${err.message}`);
  });

  if (response.status === 401) {
    throw new Error('Invalid Zendesk credentials. Check your subdomain, email, and API token.');
  }
  if (!response.ok) {
    throw new Error(`Zendesk API error (${response.status}): ${response.statusText}`);
  }

  const config = await loadAccounts();
  const existingIdx = config.accounts.findIndex((account) => account.subdomain === subdomain);
  const accountEntry: ZendeskAccount = {
    subdomain,
    email: trimmedEmail,
    apiToken: trimmedToken,
    authenticatedAt: new Date().toISOString(),
  };

  if (existingIdx >= 0) {
    config.accounts[existingIdx] = accountEntry;
  } else {
    config.accounts.push(accountEntry);
  }

  if (!config.defaultSubdomain) {
    config.defaultSubdomain = subdomain;
  }

  await saveAccounts(config);
  log.info({ subdomain }, 'Zendesk API key account added');
  return { subdomain, email: trimmedEmail };
}

export async function removeZendeskAccount(subdomain: string): Promise<void> {
  const normalizedSubdomain = validateZendeskSubdomain(subdomain);
  const config = await loadAccounts();
  config.accounts = config.accounts.filter((account) => account.subdomain !== normalizedSubdomain);

  if (config.defaultSubdomain === normalizedSubdomain) {
    config.defaultSubdomain = config.accounts[0]?.subdomain;
  }

  try {
    await fs.unlink(getLegacyTokenPath(normalizedSubdomain));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err, subdomain: normalizedSubdomain }, 'Failed to remove legacy Zendesk OAuth token');
    }
  }

  await saveAccounts(config);
  log.info({ subdomain: normalizedSubdomain }, 'Zendesk account removed');
}
