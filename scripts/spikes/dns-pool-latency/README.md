# DNS Pool Latency Spike

Manual diagnostic spike for Stage 2 of `260621_provider-transport-resolver`.

This is not a CI test and is intentionally not named with a test suffix. It measures real
`dns.lookup('localhost')` latency while mixed libuv threadpool blockers are active, using one fresh child
process per matrix cell so `UV_THREADPOOL_SIZE` is read before the first async pool operation.

Run from the repo root:

```sh
node scripts/spikes/dns-pool-latency/run.mjs
```

The runner prints a table and writes a dated results artifact under
`docs/plans/260621_provider-transport-resolver/subagent_reports/`.
