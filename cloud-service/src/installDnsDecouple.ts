/**
 * Leaf side-effect module: install the decoupled-DNS undici dispatcher as early
 * as possible in cloud boot — BEFORE `./bootstrap` (and its static-import graph,
 * which may perform top-level outbound fetches) is evaluated. Imported from
 * server.ts immediately after `./installGracefulFs` + `./platformInit`.
 *
 * Under ESM, import order is evaluation order, so importing this leaf module
 * before `./bootstrap` guarantees the global dispatcher is in place before any
 * transitively-imported module can issue an outbound fetch. The installer is
 * idempotent, so bootstrap()'s own call is a harmless no-op.
 *
 * @see ../../src/core/utils/dnsThreadpoolDecouple.ts
 * @see docs/plans/260617_meeting-bot-dns-starvation/PLAN.md
 */
import { installGlobalUndiciDnsDecouple } from '@core/utils/dnsThreadpoolDecouple';

installGlobalUndiciDnsDecouple();
