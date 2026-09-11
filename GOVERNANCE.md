# Project Governance

## Purpose

Anastom is maintained as a transparent, evidence-driven engineering project. Governance exists to preserve the control-plane principles in the project vision while allowing the implementation and contributor community to evolve them through experience.

## Current model

The project begins with a maintainer-led model. Maintainers set release scope, merge changes, manage security reports, and make final decisions when consensus is not available. Decisions should be explained through issues, pull requests, design documents, or architecture decision records rather than private context.

Maintainer authority belongs to an individual, not to that person's employer or sponsor. Funding, employment, customer status, or the volume of an organization's contributions grants no automatic decision rights.

Before a second maintainer is appointed, this document must be amended through public review to define nomination, decision, inactivity, and removal processes. The amendment must also prevent any one outside organization from controlling a majority of maintainer votes when the size and diversity of the contributor community make that practical.

## Decision process

Routine fixes are decided in pull-request review. Changes to the Workflow IR, runtime contract, event semantics, security model, persistence model, or licensing require a public design proposal and an explicit maintainer decision.

Decisions prioritize:

1. deterministic control-plane ownership;
2. evidence-backed correctness and recoverability;
3. vendor and harness neutrality;
4. inspectable, evolvable public contracts;
5. contributor and user impact;
6. implementation and operational cost.

Material disagreement should be recorded with the alternatives and evidence considered. Reversing a prior decision is welcome when new evidence warrants it.

## Conflicts and affiliations

Maintainers disclose employment, board, investment, and substantial customer relationships when they could reasonably affect a project decision. A maintainer with a direct financial interest in a commercial exception, vendor selection, enforcement action, or competing product recuses from the final decision when another maintainer can decide it.

Contributors may advocate for their own or their employer's needs. Reviews judge proposals by public project criteria, and significant decisions must be reproducible from public evidence rather than private sponsor or customer commitments.

## Community assets and commercial terms

The public core, its issue tracker, project roadmap, package namespaces, release credentials, trademarks, and community funds are held for the continuity of the project. Access to sensitive credentials must be limited, auditable, and shared with another trusted administrator once the maintainer group can support that safely.

Anastom begins with DCO sign-off and inbound-equals-outbound licensing under `AGPL-3.0-only`. Contributors retain their copyright. The project will not introduce a contributor license agreement, copyright assignment, private edition based on community contributions, or closed-source commercial license exception without a public proposal that explains:

- why the change is necessary;
- which contributor rights it requires;
- how existing contributions will be treated;
- how terms will be applied consistently; and
- how resulting revenue or other benefit will support the public project.

No governance change can revoke rights already granted in a released version. If the project develops a durable multi-maintainer community, material funding, or valuable shared marks and infrastructure, maintainers should evaluate transfer of those assets to an independent stewardship entity whose charter preserves these commitments.

See [COMMUNITY_STEWARDSHIP.md](COMMUNITY_STEWARDSHIP.md) for the failure modes these rules address.

## Releases and compatibility

Releases should have a documented scope, passing required checks, and release notes. Breaking public contract changes require migration guidance once compatibility guarantees are declared. Already released versions remain available under the license terms shipped with those versions.

## Security

Security reports are handled privately under [SECURITY.md](SECURITY.md). Maintainers may temporarily limit disclosure while a fix and coordinated release are prepared.

## Amendments

Governance changes use the same public proposal and review process as other foundational changes. An amendment must identify any effect on contributor rights, maintainer power, commercial terms, or community assets rather than hiding those effects in a routine documentation change.
