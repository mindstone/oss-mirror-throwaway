# Contributing to Rebel

Thanks for your interest in contributing to Rebel. This document covers
the legal, technical, and behavioural ground rules for contributions.
Please read it before opening a pull request — it will save us all time.

## Before you start

1. **Read the [Code of Conduct](CODE_OF_CONDUCT.md).** All interaction in
   this project — issues, pull requests, discussions, Discord — is
   governed by it.
2. **Search existing issues and pull requests.** Your idea or fix may
   already be in flight.
3. **For non-trivial changes, open an issue first.** This avoids people
   doing significant work that we can't merge for design or scope reasons.

## Sign-off (Developer Certificate of Origin)

This project uses the **Developer Certificate of Origin 1.1** ([DCO.txt](DCO.txt)) —
not a CLA. There is no form to sign and no bot to click through; you certify
your contribution by adding a sign-off line to each commit:

```
git commit -s
```

This appends `Signed-off-by: Your Name <you@example.com>` to the commit
message. By signing off you certify the statements in [DCO.txt](DCO.txt) —
in short, that you wrote the contribution (or otherwise have the right to
submit it) and that you understand it is public and recorded indefinitely.

The DCO is the **provenance / sign-off** mechanism (it records that you have the
right to submit your contribution). The **operative inbound permission** is the
license + grant below — not the DCO text itself. (The stock DCO 1.1 wording
refers to "the open source license indicated in the file"; the Rebel core is
BSL-1.1, which is source-available and only becomes open source on its Change
Date, so the grant below — not the DCO's own phrasing — is what licenses
BSL-covered contributions to us.)

**Inbound = outbound, plus a licensing grant.** Unless a file says otherwise,
your contribution is submitted under the license that applies to the file you
changed — **BSL-1.1** for the core, **MIT** for the permissively-licensed
components. In addition, for **BSL-covered contributions**, by contributing you
grant Mindstone Learning Limited a perpetual, worldwide, non-exclusive,
royalty-free, sublicensable license to use, reproduce, modify, and distribute
your contribution as part of Rebel and its licensing — including offering Rebel
under a commercial license above the seat cap and the eventual MIT conversion of
each version. (Contributions to MIT-licensed components are already permissively
licensed, so they need no separate grant.) You retain copyright in your
contribution. This grant lets us keep Rebel's commercial and Fair-Source
licensing coherent without a heavyweight CLA.

## Provenance and original-work requirements

By signing off and submitting a contribution, you represent that:

1. The contribution is your **original work**, or you have the necessary
   rights from the original author to submit it under the DCO and this
   project's licenses.
2. The contribution does **not** contain code, documentation, or other
   material that you do not have the right to license to us, including
   employer-confidential material, code from incompatible licenses
   (e.g. AGPL or proprietary code), or material subject to non-disclosure
   obligations.
3. You will disclose any third-party material in your contribution and
   identify the source and license of that material in your pull request
   description.

We perform a provenance review on every pull request. Contributions that
appear to copy from incompatible sources, or where provenance cannot be
established, will not be merged.

## No secrets, no credentials, no internal data

This is a hard rule. **Do not include in any contribution:**

- API keys, OAuth client secrets, tokens, passwords, or other credentials
  — yours, ours, or anyone else's. Rebel injects credentials at runtime
  from user-provided configuration; secrets do not belong in source.
- Internal Mindstone endpoint URLs, hostnames, ticket references, account
  identifiers, or other infrastructure details.
- Personal data of users, customers, or employees — including email
  addresses, names, conversation excerpts, log fragments, or screenshots
  containing identifying information.
- Real company names in examples, fixtures, prompts, or test data.
  Illustrative content must use fictional placeholders (e.g. `Acme Corp`,
  `TechCorp`, `jane@example.com`) — never a real customer, design-partner,
  or prospect name. Known names are denylisted by the OSS leak gate
  (`npm run check:oss-surface`), but it only catches names it already
  knows — so don't introduce new ones.
- Material covered by a non-disclosure agreement with any third party.

If you accidentally include any of the above, **let us know immediately**
at **hello@mindstone.com** (subject line prefixed `[SECURITY]`) so we
can rotate credentials and rewrite history if needed. We treat
accidental inclusion as a security incident, not a discipline issue.

Our CI runs secret-scanning (TruffleHog) on every push. Pull requests
that fail this scan will not be merged until the secrets are removed and
rotated.

## API provider Terms of Service

Rebel integrates with many third-party services (Slack, Microsoft,
Salesforce, GitHub, OpenAI, Anthropic, OpenRouter, and others — see the
connector catalogue). Each integration is subject to that provider's
Terms of Service.

**Connector contributions must comply with the upstream provider's ToS.**
In particular, contributions must not:

- Bypass rate limits, billing meters, or quotas the provider sets.
- Scrape data from the provider beyond what the API explicitly permits.
- Enable credential sharing across users in a way the provider prohibits.
- Misrepresent the application to the provider's OAuth consent screen
  or API.

If you are unsure whether a proposed change complies with a provider's
ToS, ask in the issue thread before opening a pull request. We would
rather have the conversation early than reject a finished PR.

## How contributions are licensed

By signing off on (`git commit -s`) and submitting a contribution, you agree
that:

- Your contribution is submitted under the license that applies to the file
  you changed (BSL-1.1 for the core; MIT for permissively-licensed
  components), per the inbound = outbound rule above. For BSL-covered
  contributions you also grant Mindstone Learning Limited the additional
  licensing grant described under "Sign-off (Developer Certificate of Origin)"
  above.
- A **BSL-covered** contribution becomes part of the Software and is
  distributed under the Business Source License 1.1 (BSL-1.1); see the
  [LICENSE](LICENSE) file. A contribution to an **MIT-licensed** component stays
  under MIT.
- On the Change Date for each version containing your BSL-covered contribution
  (the second anniversary of that version's first public release), that version
  becomes available under the MIT License, in accordance with the BSL-1.1 Change
  License.

You retain ownership of the copyright in your contribution. The grant you make
to Mindstone Learning Limited is set out under "Sign-off (Developer Certificate
of Origin)" above and includes the right to sublicense.

## Technical basics

Project conventions, validation commands (`npm run validate:fast`),
testing (`npm run test`, `npm run test:e2e`), and architecture pointers
live in `AGENTS.md`. Read that first.

In short:

- Use `npm ci` (not `npm install`) to install.
- Run `npm run validate:fast` before opening a PR.
- Match existing code style; no new linters, formatters, or build tools
  without prior discussion.
- Add or update tests for behavioural changes.
- For UI changes, follow the design-system guidance in `AGENTS.md`.
- Keep commits atomic and use the commit-message format described in
  `AGENTS.md`.

## Pull request flow

A note on how this repository works: it is a **public mirror** of our
internal source of truth, published as a single squashed commit and
force-replaced on each release. Because of that, the mirror has no
long-lived `dev` branch and we don't merge PRs here directly. Instead, an
approved change is **landed via our internal back-port** onto our source of
truth, and then **appears in the next mirror publish**. Your authorship is
preserved throughout — see "How contributions are credited" below.

1. Fork the repository and create a feature branch from the default
   branch.
2. Make your changes. Keep them focused — a single PR should do one
   thing.
3. Sign off your commits with `git commit -s` (Developer Certificate of Origin).
4. Push and open a pull request against the default branch.
5. Address review feedback. We aim to respond within **5 working days**.
6. Once approved and CI is green, a maintainer back-ports your change to
   our internal source of truth and credits you. Your PR is then **closed
   as landed (not merged)**, and the change appears in the next mirror
   publish.

## How contributions are credited

Because the public mirror is squashed and shares no per-contributor git
history, we preserve credit deliberately:

- A `Co-authored-by:` trailer on the landing commit.
- An entry in [CONTRIBUTORS.md](CONTRIBUTORS.md) — please contribute
  under your **GitHub handle** (or your own email), so credit survives the
  mirror transform.
- A comment on your PR when it is closed-as-landed, linking the change and
  thanking you.

## Reporting bugs and requesting features

- **Bugs:** open a GitHub issue using the bug template. Include
  reproduction steps, expected vs. actual behaviour, your OS and Rebel
  version, and any relevant logs (with secrets and personal data
  redacted).
- **Features:** open a GitHub issue using the feature template, or start
  a discussion in GitHub Discussions. We are friendlier to feature
  proposals that come with a clear use case and a willingness to help
  build the thing.

For security vulnerabilities, follow [SECURITY.md](SECURITY.md) — do not
file a public issue.

## Questions

General questions: **hello@mindstone.com** or GitHub Discussions.
Security: **hello@mindstone.com** (subject line prefixed `[SECURITY]`).
Legal / licensing / trademark: **hello@mindstone.com**.

---

Last updated: 2026-06-09
