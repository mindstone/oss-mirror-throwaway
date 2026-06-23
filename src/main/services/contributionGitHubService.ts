/**
 * Contribution GitHub Service
 *
 * Handles forking, pushing connector files, and creating PRs on the
 * mindstone/mcp-servers repo via the GitHub REST API.
 *
 * Uses the Git Data API for atomic multi-file commits:
 * 1. POST /git/blobs per file
 * 2. POST /git/trees (single tree with all blobs)
 * 3. POST /git/commits (single commit)
 * 4. PATCH /git/refs/heads/{branch} (ref update)
 *
 * Security:
 * - Path allowlist: only connectors/<name>/ paths accepted
 * - Uses contribution-specific OAuth token (separate from MCP connector token)
 * - 401 → re-auth signal, 429 → backoff/retry
 *
 * @see docs/plans/260410_oss_mcp_integration_forward_plan.md (P4.5)
 */

import { createScopedLogger } from '@core/logger';
import type { ConnectorContribution } from '@core/services/contributionTypes';
import { getContributionGitHubToken } from './contributionGitHubAuthService';
import {
  clearCachedUsername,
  getCachedContributionGitHubUsername,
  setCachedContributionGitHubUsername,
  _resetUsernameCacheForTesting,
} from './contributionGitHubUsernameCache';

const log = createScopedLogger({ service: 'contribution-github-service' });

// ─── Constants ──────────────────────────────────────────────────────

const UPSTREAM_OWNER = 'mindstone';
const UPSTREAM_REPO = 'mcp-servers';
const GITHUB_API_BASE = 'https://api.github.com';

/** Maximum number of retries for 429 rate-limit responses. */
const MAX_RETRIES = 3;

/** Base delay in ms for exponential backoff. */
const BASE_RETRY_DELAY_MS = 1000;

/** Maximum polling attempts for async fork readiness. */
const MAX_FORK_POLL_ATTEMPTS = 10;

/** Delay between fork readiness polls in ms. */
const FORK_POLL_DELAY_MS = 2000;

// ─── Error Types ────────────────────────────────────────────────────

/**
 * Thrown when GitHub returns 401, indicating the contribution token is
 * invalid or expired. The renderer should prompt re-authentication.
 */
export class GitHubReAuthRequiredError extends Error {
  constructor(message = 'GitHub authentication failed — re-authorization required') {
    super(message);
    this.name = 'GitHubReAuthRequiredError';
  }
}

/**
 * Thrown when GitHub returns 429 and all retry attempts are exhausted.
 */
export class GitHubRateLimitError extends Error {
  constructor(message = 'GitHub API rate limit exceeded after retries') {
    super(message);
    this.name = 'GitHubRateLimitError';
  }
}

/**
 * Thrown when files outside the allowed connectors/<name>/ path are submitted.
 */
export class ContributionPathViolationError extends Error {
  readonly invalidPaths: string[];

  constructor(invalidPaths: string[]) {
    super(`Path allowlist violation: ${invalidPaths.join(', ')}`);
    this.name = 'ContributionPathViolationError';
    this.invalidPaths = invalidPaths;
  }
}

// ─── Types ──────────────────────────────────────────────────────────

/** A file to be pushed to the repository. */
export interface ConnectorFile {
  /** Relative path from repo root (e.g., "connectors/my-connector/src/index.ts"). */
  path: string;
  /** UTF-8 file content. */
  content: string;
}

/** Result of a fork operation. */
export interface ForkResult {
  owner: string;
  repo: string;
  defaultBranch: string;
}

/** Options for creating a PR. */
export interface CreatePROptions {
  owner: string;
  branch: string;
  connectorName: string;
  title: string;
  body: string;
}

/** Parsed 422 validation error entry from GitHub. */
interface GitHubValidationError {
  resource?: string;
  field?: string;
  code?: string;
  message?: string;
}

/** Parsed 422 validation body from GitHub. */
interface GitHubValidationBody {
  message?: string;
  errors?: GitHubValidationError[];
  documentation_url?: string;
}

/** Result of PR create flow with explicit 422 classification. */
export type CreatePRResult =
  | {
      kind: 'success';
      prUrl: string;
      prNumber: number;
    }
  | {
      kind: 'duplicate-open';
      prUrl: string;
      prNumber: number;
    }
  | {
      kind: 'duplicate-closed';
      prUrl: string;
      prNumber: number;
    }
  | {
      kind: 'fresh-ref-not-yet-visible';
      body: unknown;
    }
  | {
      kind: 'unknown-422';
      body: unknown;
    };

/** Review information from a PR. */
export interface PRReview {
  state: string;
  user: string;
  body: string;
}

/** CI check run information. */
export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

/** Status of a PR. */
export interface PRStatus {
  prState: 'open' | 'closed';
  merged: boolean;
  reviews: PRReview[];
  checkRuns: CheckRun[];
  htmlUrl: string;
}

// ─── Internal State ─────────────────────────────────────────────────

/**
 * Derive a stable per-contribution submission branch.
 * contribution.id format: contrib-<base36-timestamp>-<6-char-base36-random>
 */
export function deriveSubmissionBranch(contribution: ConnectorContribution): string {
  const shortId = contribution.id.split('-').at(-1) ?? contribution.id;
  return `contribution/${contribution.connectorName}-${shortId}`;
}

// ─── Path Validation ────────────────────────────────────────────────

/**
 * Validate that all file paths are within connectors/<connectorName>/.
 * Blocks traversal, absolute paths, .github/, root configs, and paths
 * targeting different connector directories.
 */
export function validateConnectorPaths(
  connectorName: string,
  files: Pick<ConnectorFile, 'path'>[],
): { valid: boolean; invalidPaths: string[] } {
  const allowedPrefix = `connectors/${connectorName}/`;
  const invalidPaths: string[] = [];

  for (const file of files) {
    const p = file.path;

    // Reject empty paths
    if (!p) {
      invalidPaths.push(p);
      continue;
    }

    // Reject absolute paths
    if (p.startsWith('/')) {
      invalidPaths.push(p);
      continue;
    }

    // Reject path traversal
    if (p.includes('..')) {
      invalidPaths.push(p);
      continue;
    }

    // Reject .github/ directory
    if (p.startsWith('.github/') || p.startsWith('.github\\')) {
      invalidPaths.push(p);
      continue;
    }

    // Must be under connectors/<connectorName>/
    if (!p.startsWith(allowedPrefix)) {
      invalidPaths.push(p);
      continue;
    }

    // Must have content after the prefix (not just the directory itself)
    if (p === allowedPrefix || p.length <= allowedPrefix.length) {
      invalidPaths.push(p);
      continue;
    }
  }

  return {
    valid: invalidPaths.length === 0,
    invalidPaths,
  };
}

// ─── GitHub API Helpers ─────────────────────────────────────────────

/**
 * Get the current contribution GitHub token, throwing if unavailable.
 */
async function requireToken(): Promise<string> {
  const token = await getContributionGitHubToken();
  if (!token) {
    throw new GitHubReAuthRequiredError('No contribution GitHub token available — authentication required');
  }
  return token;
}

/**
 * Calculate retry delay from Retry-After header or exponential backoff.
 */
function getRetryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      return seconds * 1000;
    }
  }
  // Exponential backoff: 1s, 2s, 4s, ...
  return BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
}

function isSafeMethodFor5xxRetry(method: string | undefined): boolean {
  if (!method) {
    return true;
  }
  const normalizedMethod = method.toUpperCase();
  return normalizedMethod === 'GET' || normalizedMethod === 'HEAD';
}

/**
 * Test-only export of the safe-method classifier so the contract
 * (`GET` + `HEAD` retry; `POST` / `PATCH` / `PUT` / `DELETE` do not)
 * can be pinned without exercising the full `forkRepo`/`createPR`
 * call chain. The retry mechanics themselves are pinned via
 * end-to-end tests on the public functions.
 *
 * Stage 3 review (260427) — tester gpt-5.5 surfaced missing HEAD/PUT/DELETE
 * regression coverage.
 */
export const _isSafeMethodFor5xxRetryForTesting = isSafeMethodFor5xxRetry;

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make an authenticated GitHub API request with 401/429 handling.
 */
async function githubFetch(
  endpoint: string,
  options: RequestInit = {},
  retryCount = 0,
): Promise<Response> {
  const token = await requireToken();

  const url = endpoint.startsWith('http') ? endpoint : `${GITHUB_API_BASE}${endpoint}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(options.headers as Record<string, string> ?? {}),
  };

  if (options.body && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  // 401 → re-auth required
  if (response.status === 401) {
    log.warn({ endpoint, status: 401 }, 'GitHub API returned 401 — contribution token is invalid or expired');
    throw new GitHubReAuthRequiredError();
  }

  // 429 → rate limit, retry with backoff
  if (response.status === 429) {
    if (retryCount >= MAX_RETRIES) {
      log.error({ endpoint, retryCount }, 'GitHub API rate limit exceeded after max retries');
      throw new GitHubRateLimitError();
    }

    const delay = getRetryDelay(response, retryCount);
    log.warn({ endpoint, retryCount, delayMs: delay }, 'GitHub API rate limited, retrying after backoff');
    await sleep(delay);
    return githubFetch(endpoint, options, retryCount + 1);
  }

  // 5xx on safe methods (GET/HEAD) → retry with exponential backoff.
  // Non-idempotent methods (POST/PATCH/PUT/DELETE) are surfaced immediately.
  if (
    response.status >= 500 &&
    response.status <= 599 &&
    isSafeMethodFor5xxRetry(options.method)
  ) {
    if (retryCount >= MAX_RETRIES) {
      log.error(
        { endpoint, status: response.status, retryCount, method: options.method ?? 'GET' },
        'GitHub API returned 5xx for safe request after max retries',
      );
      return response;
    }

    const delay = BASE_RETRY_DELAY_MS * Math.pow(2, retryCount);
    log.warn(
      { endpoint, status: response.status, retryCount, delayMs: delay, method: options.method ?? 'GET' },
      'GitHub API returned 5xx for safe request, retrying after backoff',
    );
    await sleep(delay);
    return githubFetch(endpoint, options, retryCount + 1);
  }

  return response;
}

// ─── Get Authenticated User ─────────────────────────────────────────

/**
 * Get the authenticated GitHub username (cached).
 */
async function getAuthenticatedUser(): Promise<string> {
  const cached = getCachedContributionGitHubUsername();
  if (cached) return cached;

  const response = await githubFetch('/user');
  if (!response.ok) {
    throw new Error(`Failed to get GitHub user: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { login: string };
  setCachedContributionGitHubUsername(data.login);
  return data.login;
}

// ─── Fork Management ────────────────────────────────────────────────

/**
 * Check if the user already has a fork of the upstream repo.
 */
async function checkExistingFork(username: string): Promise<ForkResult | null> {
  const response = await githubFetch(`/repos/${username}/${UPSTREAM_REPO}`);

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to check fork: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as {
    full_name: string;
    default_branch: string;
    fork?: boolean;
    parent?: { full_name: string };
  };

  // Verify it's actually a fork of the upstream repo
  if (data.fork && data.parent?.full_name === `${UPSTREAM_OWNER}/${UPSTREAM_REPO}`) {
    return {
      owner: username,
      repo: UPSTREAM_REPO,
      defaultBranch: data.default_branch,
    };
  }

  // User has a repo with the same name but it's not a fork of upstream
  return null;
}

/**
 * Wait for a newly created fork to become available.
 * GitHub creates forks asynchronously; we poll until the repo is accessible.
 */
async function waitForForkReady(username: string): Promise<ForkResult> {
  for (let attempt = 0; attempt < MAX_FORK_POLL_ATTEMPTS; attempt++) {
    const existing = await checkExistingFork(username);
    if (existing) {
      log.info({ attempt, owner: username }, 'Fork is ready');
      return existing;
    }

    log.info({ attempt, maxAttempts: MAX_FORK_POLL_ATTEMPTS }, 'Fork not ready yet, polling...');
    await sleep(FORK_POLL_DELAY_MS);
  }

  throw new Error(`Fork not ready after ${MAX_FORK_POLL_ATTEMPTS} polling attempts`);
}

/**
 * Fork the upstream mcp-servers repo.
 * Reuses an existing fork if one exists.
 * Polls for async fork readiness after creation.
 */
export async function forkRepo(): Promise<ForkResult> {
  const username = await getAuthenticatedUser();

  // Check for existing fork first
  const existingFork = await checkExistingFork(username);
  if (existingFork) {
    log.info({ owner: username }, 'Reusing existing fork');
    return existingFork;
  }

  // Create new fork
  log.info({ upstream: `${UPSTREAM_OWNER}/${UPSTREAM_REPO}` }, 'Creating new fork');
  const forkResponse = await githubFetch(
    `/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/forks`,
    { method: 'POST', body: JSON.stringify({ default_branch_only: true }) },
  );

  if (!forkResponse.ok && forkResponse.status !== 202) {
    const errorBody = await forkResponse.text();
    throw new Error(`Failed to create fork: ${forkResponse.status} — ${errorBody}`);
  }

  // Fork creation is async — poll until ready
  return waitForForkReady(username);
}

// ─── Git Data API Push ──────────────────────────────────────────────

/**
 * Push connector files to the fork using the Git Data API.
 * Creates a single atomic commit with all files.
 *
 * Steps:
 * 1. Get base commit SHA from branch ref (or default branch if target doesn't exist)
 * 2. Get base tree SHA from commit
 * 3. Create blobs for each file
 * 4. Create new tree with all blobs
 * 5. Create commit pointing to new tree
 * 6. Create or update branch ref to new commit
 */
export async function pushConnectorFiles(
  connectorName: string,
  forkOwner: string,
  branch: string,
  files: ConnectorFile[],
  defaultBranch = 'main',
  commitMessage?: string,
): Promise<{ commitSha: string }> {
  // Validate paths first
  const pathCheck = validateConnectorPaths(connectorName, files);
  if (!pathCheck.valid) {
    throw new ContributionPathViolationError(pathCheck.invalidPaths);
  }

  const repoBase = `/repos/${forkOwner}/${UPSTREAM_REPO}`;

  // Step 1: Get the current branch ref (base commit SHA).
  // If the branch does not exist yet (first-time contribution), fall back
  // to the default branch and flag that we need to create the ref later.
  let branchIsNew = false;
  let baseCommitSha: string;

  const refResponse = await githubFetch(`${repoBase}/git/ref/heads/${branch}`);

  if (refResponse.ok) {
    const refData = await refResponse.json() as { object: { sha: string } };
    baseCommitSha = refData.object.sha;
  } else if (refResponse.status === 404) {
    // Branch does not exist — base off the default branch
    log.info({ branch, defaultBranch }, 'Branch ref not found, creating from default branch');
    branchIsNew = true;

    const defaultRefResponse = await githubFetch(`${repoBase}/git/ref/heads/${defaultBranch}`);
    if (!defaultRefResponse.ok) {
      throw new Error(`Failed to get default branch ref: ${defaultRefResponse.status}`);
    }
    const defaultRefData = await defaultRefResponse.json() as { object: { sha: string } };
    baseCommitSha = defaultRefData.object.sha;
  } else {
    throw new Error(`Failed to get branch ref: ${refResponse.status}`);
  }

  // Step 2: Get the base tree SHA from the base commit
  const commitResponse = await githubFetch(`${repoBase}/git/commits/${baseCommitSha}`);
  if (!commitResponse.ok) {
    throw new Error(`Failed to get base commit: ${commitResponse.status}`);
  }
  const commitData = await commitResponse.json() as { tree: { sha: string } };
  const baseTreeSha = commitData.tree.sha;

  // Step 3: Create blobs for each file
  const blobShas: { path: string; sha: string }[] = [];
  for (const file of files) {
    const blobResponse = await githubFetch(`${repoBase}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({
        content: file.content,
        encoding: 'utf-8',
      }),
    });

    if (!blobResponse.ok) {
      throw new Error(`Failed to create blob for ${file.path}: ${blobResponse.status}`);
    }

    const blobData = await blobResponse.json() as { sha: string };
    blobShas.push({ path: file.path, sha: blobData.sha });
  }

  // Step 4: Create new tree with all blobs
  const treeItems = blobShas.map((blob) => ({
    path: blob.path,
    mode: '100644' as const,
    type: 'blob' as const,
    sha: blob.sha,
  }));

  const treeResponse = await githubFetch(`${repoBase}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: treeItems,
    }),
  });

  if (!treeResponse.ok) {
    throw new Error(`Failed to create tree: ${treeResponse.status}`);
  }
  const treeData = await treeResponse.json() as { sha: string };

  // Step 5: Create commit
  const resolvedCommitMessage = commitMessage ?? `feat(connector): add ${connectorName} connector`;
  const newCommitResponse = await githubFetch(`${repoBase}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: resolvedCommitMessage,
      tree: treeData.sha,
      parents: [baseCommitSha],
    }),
  });

  if (!newCommitResponse.ok) {
    throw new Error(`Failed to create commit: ${newCommitResponse.status}`);
  }
  const newCommitData = await newCommitResponse.json() as { sha: string };

  // Step 6: Create or update branch ref
  let refUpdateResponse: Response;
  if (branchIsNew) {
    // Create new branch ref via POST
    refUpdateResponse = await githubFetch(`${repoBase}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({
        ref: `refs/heads/${branch}`,
        sha: newCommitData.sha,
      }),
    });
  } else {
    // Update existing branch ref via PATCH
    refUpdateResponse = await githubFetch(`${repoBase}/git/refs/heads/${branch}`, {
      method: 'PATCH',
      body: JSON.stringify({
        sha: newCommitData.sha,
        force: false,
      }),
    });
  }

  if (!refUpdateResponse.ok) {
    throw new Error(`Failed to ${branchIsNew ? 'create' : 'update'} ref: ${refUpdateResponse.status}`);
  }

  log.info(
    { connectorName, commitSha: newCommitData.sha, fileCount: files.length },
    'Pushed connector files via Git Data API',
  );

  return { commitSha: newCommitData.sha };
}

// ─── PR Management ──────────────────────────────────────────────────

function parse422Body(rawBody: string): unknown {
  if (!rawBody) return { message: '' };
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return { message: rawBody };
  }
}

function extractValidationErrors(body: unknown): GitHubValidationError[] {
  if (typeof body !== 'object' || body === null) {
    return [];
  }
  const candidate = (body as GitHubValidationBody).errors;
  if (!Array.isArray(candidate)) {
    return [];
  }
  return candidate.filter((entry): entry is GitHubValidationError =>
    typeof entry === 'object' && entry !== null,
  );
}

function classify422(body: unknown): 'fresh-ref-not-yet-visible' | 'duplicate-pr' | 'unknown-422' {
  const errors = extractValidationErrors(body);

  // Prefer structured `errors[]` inspection over top-level message matching.
  const freshRef = errors.some((entry) =>
    entry.field === 'head' &&
    (entry.code === 'invalid' || entry.message?.includes('does not exist') === true),
  );
  if (freshRef) {
    return 'fresh-ref-not-yet-visible';
  }

  const duplicate = errors.some((entry) =>
    entry.message?.includes('A pull request already exists') === true,
  );
  if (duplicate) {
    return 'duplicate-pr';
  }

  return 'unknown-422';
}

type PullState = 'open' | 'closed' | 'all';

/**
 * Create a PR from the fork to the upstream repo.
 * Classifies 422 responses so the caller can orchestrate retries.
 */
export async function createPR(options: CreatePROptions): Promise<CreatePRResult> {
  const { owner, branch, connectorName, title, body } = options;

  const response = await githubFetch(
    `/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/pulls`,
    {
      method: 'POST',
      body: JSON.stringify({
        title,
        body,
        head: `${owner}:${branch}`,
        base: 'main',
      }),
    },
  );

  // Successful creation
  if (response.ok) {
    const data = await response.json() as { number: number; html_url: string };
    log.info({ prNumber: data.number, connectorName }, 'Created PR');
    return {
      kind: 'success',
      prUrl: data.html_url,
      prNumber: data.number,
    };
  }

  // 422 = validation errors (duplicate PR, fresh ref not visible yet, etc.)
  if (response.status === 422) {
    const rawBody = await response.text();
    const parsedBody = parse422Body(rawBody);
    const classification = classify422(parsedBody);

    if (classification === 'fresh-ref-not-yet-visible') {
      log.info(
        { owner, branch, connectorName },
        'PR creation returned 422: head ref not yet visible',
      );
      return { kind: 'fresh-ref-not-yet-visible', body: parsedBody };
    }

    if (classification === 'duplicate-pr') {
      log.info(
        { owner, branch, connectorName },
        'PR creation returned 422: duplicate PR detected, looking up existing PR',
      );
      try {
        return await lookupExistingPR(owner, branch, 'all');
      } catch (lookupError) {
        log.warn(
          {
            owner,
            branch,
            connectorName,
            err: lookupError instanceof Error ? lookupError.message : String(lookupError),
          },
          'PR creation duplicate lookup failed after 422',
        );
        return { kind: 'unknown-422', body: parsedBody };
      }
    }

    return { kind: 'unknown-422', body: parsedBody };
  }

  const errorBody = await response.text();
  throw new Error(`Failed to create PR: ${response.status} — ${errorBody}`);
}

/**
 * Look up an existing PR from the given head branch.
 */
async function lookupExistingPR(
  owner: string,
  branch: string,
  state: PullState = 'open',
): Promise<Extract<CreatePRResult, { kind: 'duplicate-open' | 'duplicate-closed' }>> {
  const response = await githubFetch(
    `/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/pulls?head=${owner}:${branch}&state=${state}`,
  );

  if (!response.ok) {
    throw new Error(`Failed to look up existing PR: ${response.status}`);
  }

  const pulls = await response.json() as Array<{
    number: number;
    html_url: string;
    state: string;
  }>;

  if (pulls.length === 0) {
    throw new Error(`PR lookup returned no results for ${owner}:${branch} (state=${state})`);
  }

  const openPR = pulls.find((pull) => pull.state === 'open');
  if (openPR) {
    log.info({ prNumber: openPR.number }, 'Found existing open PR');
    return {
      kind: 'duplicate-open',
      prUrl: openPR.html_url,
      prNumber: openPR.number,
    };
  }

  const closedPR = pulls.find((pull) => pull.state === 'closed');
  if (!closedPR) {
    throw new Error(`PR lookup returned no open/closed PR for ${owner}:${branch}`);
  }
  log.warn({ prNumber: closedPR.number }, 'Found existing closed PR');
  return {
    kind: 'duplicate-closed',
    prUrl: closedPR.html_url,
    prNumber: closedPR.number,
  };
}

/**
 * Get the status of a PR including reviews and CI checks.
 */
export async function getPRStatus(prNumber: number): Promise<PRStatus> {
  // Get PR details
  const prResponse = await githubFetch(
    `/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/pulls/${prNumber}`,
  );

  if (!prResponse.ok) {
    throw new Error(`Failed to get PR status: ${prResponse.status}`);
  }

  const prData = await prResponse.json() as {
    number: number;
    state: 'open' | 'closed';
    html_url: string;
    merged: boolean;
    head: { sha: string };
  };

  // Get reviews
  const reviewsResponse = await githubFetch(
    `/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/pulls/${prNumber}/reviews`,
  );

  const reviewsData = reviewsResponse.ok
    ? await reviewsResponse.json() as Array<{
      state: string;
      user: { login: string };
      body: string;
    }>
    : [];

  // Get check runs for the head SHA
  const checksResponse = await githubFetch(
    `/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/commits/${prData.head.sha}/check-runs`,
  );

  const checksData = checksResponse.ok
    ? await checksResponse.json() as {
      check_runs: Array<{
        name: string;
        status: string;
        conclusion: string | null;
      }>;
    }
    : { check_runs: [] };

  return {
    prState: prData.state,
    merged: prData.merged,
    htmlUrl: prData.html_url,
    reviews: (Array.isArray(reviewsData) ? reviewsData : []).map((r) => ({
      state: r.state,
      user: r.user.login,
      body: r.body,
    })),
    checkRuns: checksData.check_runs.map((c) => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
    })),
  };
}

// ─── Testing ────────────────────────────────────────────────────────

/**
 * Clear the cached authenticated username.
 *
 * Must be called when the contribution GitHub account is removed or
 * when re-authentication occurs, to prevent stale owner lookups
 * in fork/PR operations.
 */
export { clearCachedUsername };

/** Reset internal state for testing. */
export function _resetForTesting(): void {
  _resetUsernameCacheForTesting();
}
