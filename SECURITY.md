# Security Policy

We take the security of Rebel and its users seriously. This document
describes how to report a security issue, what to expect from us in
response, and the safe-harbour protections we extend to good-faith
researchers.

## Reporting a vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**
Public reports give attackers a window to exploit the issue before users
can update.

Instead, send a report to **hello@mindstone.com** with the subject line
prefixed `[SECURITY]`. Please include, to
the extent you can:

- A description of the issue and the impact you believe it has.
- Steps to reproduce, or a minimal proof-of-concept.
- The version of Rebel affected (commit SHA if you have it).
- Your operating system and any relevant environment details.
- Whether the issue has been disclosed elsewhere, and if so, to whom.

If you wish to encrypt your report, request our PGP public key in your
first email and we will send it before you share details.

## What you can expect from us

- **Acknowledgement within 48 hours** of receiving your report. If you do
  not hear from us within that window, please follow up — your message may
  not have reached us.
- A triage assessment within 5 working days, including our initial view of
  severity and likely remediation timeline.
- Regular status updates while we investigate and remediate. We aim to
  resolve high-severity issues within 30 days and lower-severity issues
  within 90 days, but timelines depend on the nature of the issue.
- Public credit in the security advisory and release notes, if you wish.
  Let us know how you would like to be credited (real name, handle, or
  anonymous).

## Coordinated disclosure

We follow a coordinated-disclosure model. We ask that you give us a
reasonable opportunity to remediate before publicly disclosing the issue —
typically the earlier of (a) 90 days after your initial report, (b) the
date a fix has been released, or (c) a date we mutually agree.

We will publish a security advisory through GitHub Security Advisories
once a fix is released, including (with your permission) acknowledgement
of the reporter.

## Safe harbour

When you make a good-faith effort to comply with this policy, we will:

- Not pursue or support legal action against you for accessing,
  identifying, or disclosing the vulnerability;
- Work with you to understand and resolve the issue quickly; and
- Recognise your contribution publicly, if you wish.

You are acting in good faith if you:

- Report the vulnerability promptly through the channel above;
- Do not access, modify, or destroy any user data beyond what is
  necessary to demonstrate the issue;
- Do not perform attacks that degrade service availability for other
  users (e.g. denial-of-service);
- Do not exploit the vulnerability beyond the minimum needed to confirm
  it; and
- Comply with applicable laws.

## Scope

In scope:

- The Rebel desktop application (this repository).
- The official Rebel build artifacts published by Mindstone Learning Limited
- Mindstone-operated infrastructure that this repository depends on for
  its open-source operation, including the OAuth-MCP redirect worker at
  `rebel-auth.mindstone.com`.

Out of scope:

- Third-party services Rebel integrates with (Slack, Microsoft, Salesforce,
  GitHub, OpenAI, Anthropic, etc.). Please report vulnerabilities in those
  services to the operators of those services directly.
- Self-hosted forks or modified versions of Rebel published by parties
  other than Mindstone Learning Limited
- Issues that require physical access to a user's already-compromised
  device, or that depend on a user installing malicious third-party
  software outside Rebel's control.
- Reports generated automatically by scanning tools without manual
  validation, where the underlying issue is theoretical or has no
  realistic exploit path.

## Questions

For questions about this policy that do not concern an active
vulnerability report, contact **hello@mindstone.com**.

---

Last updated: 2026-06-05
