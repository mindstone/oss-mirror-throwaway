/// <reference types="node" />
// Desktop-project credential isolation — run credential-absent by default, matching CI.
//
// The CLI / agent-turn / local-model-proxy auth gate resolves Claude credentials from
// `settings.models.apiKey` with an ambient `process.env.ANTHROPIC_API_KEY` (and OAuth-token)
// FALLBACK. Tests that mock only a stale namespace or otherwise omit auth then pass on a
// developer's machine — where those env vars are present — but FAIL in CI, which has none.
// That "works on my machine" gap shipped multiple red beta desktop-unit gates and kept beta
// broken for ~a day (see docs/plans/260607_oss-scrub-regression-class). Stripping the ambient
// PRODUCTION Claude credentials here forces every desktop test to provide auth explicitly
// (e.g. `settings.models.apiKey`, or by setting the env var inside the test), so the
// dependence can no longer hide locally — a dev sees the same failure CI would.
//
// Scope: desktop project only (the measured blast radius). Skipped when RUN_LIVE_API_TESTS
// is set, because the gated live-api suite legitimately needs real credentials. Note the
// gated live tests read TEST_*-prefixed keys (TEST_ANTHROPIC_API_KEY etc.), which are left
// untouched regardless.
if (!process.env.RUN_LIVE_API_TESTS) {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
}
