---
description: "Architecture for external conversation ingress — scope resolution, adapters, buffering, trust boundaries, and Slack cloud webhook polish"
last_updated: "2026-05-03"
---

# External Conversation Architecture

## Overview

The External Conversation Architecture provides a unified interface for bridging external surface events (browser tabs, Office sidecars, Slack threads, Telegram/WhatsApp chats) into the Mindstone Rebel core agent loop. It decouples surface-specific ingress from the generic state machine, buffering, and routing logic.

## Key Components

1. **ConversationScopeResolver**: Determines whether an inbound event belongs to an existing conversation or starts a new one based on a defined shape (e.g. `SlackThreadContext` uses `(teamId, channelId, threadTs)`).
2. **ExternalConversationService**: Orchestrates message creation, delivery, buffering, and focus transitions.
3. **Adapters**: Surface-specific implementations that handle protocol specifics, secrets, verification, and dispatch. 
   - *Example*: `SlackThreadAdapter` (handles HMAC-SHA256 verification and replay protection).

## Data Flows
- Inbound external events hit the routing layer (e.g., Cloud Webhook or Desktop Polling).
- An adapter authenticates and converts the payload into an `ExternalContext` payload.
- The `ExternalConversationService` buffers or directly injects the context and text into `AgentTurnRegistry`.
- Outbound responses are delivered via the `deliverResponse()` interface on the adapter.

## Inbound Webhook Trust Boundary
- Signature verification and replay protection live **inside the adapter**, executed before calling into core services.

## References
- See `docs/plans/260502_unified_external_conversation_architecture.md` for the original design and staged implementation details.
- See `src/core/services/externalConversation/externalConversationService.ts` for the core service.
- See `src/core/services/externalConversation/externalContext.ts` for context types.

## Slack cloud webhook polish

Slack cloud thread delivery was hardened in the staged polish plan [`docs/plans/260503_slack_cloud_webhook_polish.md`](../plans/260503_slack_cloud_webhook_polish.md). That plan covers the managed/BYOK OAuth topology, cloud-vs-desktop delivery mutual exclusion, Slack thread metadata/chip parity, lifecycle telemetry, eval fixtures, and mobile DTO pass-through.

For operator setup, env vars, Slack app registration, log grep recipes, credential rotation, and smoke testing, use [SLACK_CLOUD_DEPLOYMENT](./SLACK_CLOUD_DEPLOYMENT.md).
