# @anastom/execution-host

Implement Anastom's shared local POSIX execution-ownership boundary. `LocalExecutionHost` prepares a detached supervisor without starting a worker, publishes sanitized identity, accepts explicit start authorization, relays bounded public observations and normalized results, and confirms descendant cleanup before reporting absence.

## Public API

The engine-owned `ExecutionHost` interface and execution reference types live in [`@anastom/engine`](../engine/README.md). This package exports `LocalExecutionHost`, its trusted hidden-runtime command options, sanitized local-process observation, and `runExecutionRuntimeHost` for a composition-root executable that reconstructs exact adapters from their credential-free descriptors.

`prepare` writes immutable plan identity, starts only the supervisor, and returns after private control and `awaiting-start` manifest records exist. `authorize` publishes the exact start authority; the supervisor persists `starting`, waits for the isolated runtime host's readiness proof, persists `active`, and only then sends launch input. `collect` returns after normalized terminal evidence and confirmed cleanup are durable. `inspect` and `terminate` fail closed when identity or cleanup cannot be established.

The documented entry point is [src/index.ts](src/index.ts). Generate optional HTML API documentation with `pnpm docs:api execution-host`; output is in `.generated/api/execution-host/` and is not committed.

## Boundaries and invariants

The implementation supports local Linux and macOS. It imports the engine and runtime contracts without importing Pi, Codex, Claude Code, or a provider SDK. A trusted CLI composition root supplies a checked-in runtime-host command; runtime descriptors select model-facing behavior, while the shared supervisor owns OS lifecycle.

Private run records use fixed segments under `PrivatePathRoot`, modes `0700`/`0600`, byte limits before parsing, canonical exact schemas, and a control-record digest bound into stable manifest identity. The random 256-bit capability and Unix-socket endpoint remain private. Socket paths use the fixed current-user root below `/tmp/anastom-<uid>` and stay below 100 UTF-8 bytes. Launch input travels through an inherited pipe and is never persisted by this package.

The supervisor keeps one request active and queues at most eight, accepts one exact length-prefixed frame per connection, compares capabilities in constant time after length validation, retains at most 256 public observations with log-drop accounting, and caps terminal records at 4 MiB. Coordinator-pipe loss triggers cleanup without waiting for lease expiry. An absent supervisor in `starting` or `active`, an invalid record, or unconfirmed cleanup produces `unknown`; fencing or a PID alone never proves absence.

This is process ownership infrastructure, not the M3 recovery coordinator. The current CLI does not route Task execution through it yet. Provider-session adoption, remote workers, Windows named pipes, force takeover, and distributed scheduling remain outside M3.

## Development

Run from the repository root:

```sh
pnpm test packages/execution-host
pnpm typecheck
pnpm lint
pnpm docs:api execution-host
```

The checked-in fixture runtime host makes no provider call and reads no authentication store. Its process tests cover Pi-shaped, Codex-shaped, Claude-Code-shaped, and command ownership through the same supervisor, including success, cancellation, coordinator `SIGKILL`, active and starting supervisor loss, tampered authority, framing, and observation pressure.

Follow [engineering standards](../../docs/ENGINEERING.md) and [contribution expectations](../../CONTRIBUTING.md). Update this README when package behavior or its API changes. Add a Changeset for code or contract changes. License: [AGPL-3.0-only](../../LICENSE).
