# ADR 0014: Codex managed-policy preflight

Status: Accepted by the owner on 2026-09-15 before the M2 live Codex demonstration.

## Problem

The accepted bounded Codex profile suppresses ambient user/project discovery, but managed policy is a separate authority. The pinned `codex exec` loads local, MDM, and eligible ChatGPT cloud configuration after authentication. A managed requirement such as `additional_developer_instructions` can add model-visible text without appearing in the CLI's normalized JSONL history. Native exit zero and a valid final report therefore cannot certify Anastom's explicit-context boundary.

An exact-release, synthetic business-plan fixture served a cloud requirement with `ANASTOM_MANAGED_SENTINEL`. The profile sent one schema-constrained Responses request containing that sentinel and returned a valid report with exit zero. This is a reproducible failure of the earlier assumption that native success implied bounded prompt contents. No owner credential or real provider call was involved.

## Decision

Before starting each `codex exec`, start a short-lived, independently owned `codex app-server --stdio --strict-config` process with the same fresh `CODEX_HOME`, original-file auth symlink, workspace cwd, and adapter-owned `-c` profile. Use only the native `initialize`, `configRequirements/read`, and `config/read` requests with `includeLayers: true`. These read configuration; they do not create a model thread or call a model. The app-server process is a policy diagnostic, while the accepted model execution remains one fresh owned `codex exec --json` group per attempt.

Reject any nonempty managed requirements, any MDM/enterprise/legacy managed layer, or a nonempty system configuration layer as `policy-violation`. This is intentionally conservative: the current profile cannot prove that even an apparently compatible managed policy leaves all prompt, discovery, tool, and authentication behavior unchanged. A missing, malformed, timed-out, or failed policy read is `runtime-unavailable`. Never fall back to a guessed configuration or start the model after either outcome. Keep JSONL framing and output bounded, discard native stderr and configuration bodies from durable evidence, stop the diagnostic group before spawning the execution group, and remove the temporary profile on rejection.

The normal auth file is linked into the fresh profile, never read or copied by Anastom. Codex may refresh that original file through its own file-backed store. The policy diagnostic can make a non-model cloud-configuration request for eligible authenticated accounts. It is not a `capabilities()` probe: that generic method has no workspace and must stay model/session-free. This preflight occurs after the engine has selected a filesystem attempt but before its Codex model call. M3 recovery, automatic routing, other providers, and a generalized policy API remain outside M2.

## Evidence and limits

The exact `rust-v0.154.0` source at commit `6b9826e3aa83b1a5947db50f4332cb9c65f1b340` shows the `codex exec` cloud loader in `codex-rs/exec/src/lib.rs`; cloud eligibility, caching, and retries in `codex-rs/cloud-config/src/service.rs`; local/MDM/enterprise layer sources in `codex-rs/config/src/loader/mod.rs`; and the read-only app-server protocol and processor in `codex-rs/app-server-protocol/src/protocol/common.rs`, `codex-rs/app-server-protocol/src/protocol/v2/config.rs`, and `codex-rs/app-server/src/request_processors/config_processor.rs`. `debug prompt-input` uses a different load path and creates an ephemeral debug thread, so it is only offline discovery evidence, not this gate.

The opt-in [offline probe](../../scripts/probe-codex-feasibility.ts) modes `managed-conflict`, `managed-config`, and `managed-unavailable` use a local provider/config endpoint and synthetic ChatGPT identities. The managed-requirement case exposes the sentinel through `configRequirements/read` before the later synthetic model request succeeds. The production policy gate rejects that same exact native profile before any model request. The managed-config case exposes an `enterpriseManaged` layer without any model request, and the production gate rejects it too. Five synthetic cloud 503 replies make the strict app-server exit before complete evidence; the gate rejects that case. The checked-in process double additionally proves that managed requirements/configuration and unavailable inspection prevent the `codex exec` double from starting and remove its temporary profile.

The upstream signed cache is scoped to the authenticated account and valid for one hour. The diagnostic and execution share the fresh profile; the synthetic conflict made one cloud bundle request and the later `codex exec` consumed that cached bundle. An administrator or filesystem actor could still change policy between separate process starts. As with other preflight checks, this is a bounded startup snapshot, not a guarantee against concurrent external mutation. A changed executable pin or policy protocol requires renewed evidence and review. A model-visible conflict that cannot be observed through this interface remains a live gate blocker.

## Review boundary

The owner accepted this refinement before the live Codex run, per the M2 build brief's feasibility-gate rule. The paired Pi/Codex demonstration still requires the same normal-auth, model-free inspection on the owner's selected setup and all other offline gates to pass.
