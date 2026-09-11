# Community Stewardship

## Purpose

Anastom should be useful in homes, universities, nonprofits, consultancies, and businesses without requiring permission or payment. Organizations may use it to build software, operate their own systems, sell unrelated products, and provide expertise around it.

The project resists enclosure: a party selling Anastom's own capabilities should not be able to capture the project's identity or governance or keep covered modifications from users, leaving the community unable to inspect or continue the work.

This document records the project's policy commitments and threat model. The license controls legal permission to use the software; [GOVERNANCE.md](GOVERNANCE.md) controls project decisions.

## Uses the project welcomes

- personal, academic, nonprofit, government, and commercial use;
- internal production use, including operation of business systems;
- using Anastom to develop proprietary software;
- consulting, integration, training, support, books, and courses;
- modification, research, benchmarking, and redistribution under the project license;
- independent forks that use distinct branding; and
- paid or free hosted services that satisfy the network-source obligations of the project license.

Profit by itself is not extraction. The concern is retaining the value produced by the community while denying users the source, freedom, provenance, or project identity that made that value possible.

## Extraction risks and responses

| Risk | Project response | Limit of the response |
| --- | --- | --- |
| A thin API, dashboard, or managed service sells Anastom's primary functionality while its service code stays private | Keep the engine and official service components under AGPL network copyleft; keep essential hosted functionality in the covered program | AGPL may cover modifications to Anastom without reaching a separate independent wrapper |
| A closed fork or embedded distribution ships community fixes without source | Use strong copyleft for the covered program, preserve notices, and publish reproducible source releases | Private internal changes remain private; that is an accepted use |
| Proprietary plugins become the only practical way to use an otherwise open core | Keep essential orchestration contracts and reference implementations in the reciprocal core; review extension boundaries before declaring a stable plugin API | Copyleft reach across a plugin boundary is fact-specific, and an overbroad boundary would deter legitimate integrations |
| A vendor presents a fork, hosted service, package, event, or certification as official Anastom | Maintain a trademark policy, reserve official package and domain names, and require forks to use distinct branding | Trademark protects source identity, not compatible implementations or honest comparative references |
| A sponsor or employer buys roadmap or maintainer control | Grant authority to individuals for sustained project work, require affiliation and conflict disclosure, and give funding no automatic governance rights | Influence through useful work and persuasion is legitimate and cannot be reduced to a formula |
| A large adopter externalizes its integration work, regression testing, or customer support onto unpaid maintainers | Keep community support best-effort, require reproducible public evidence, prioritize work by project value, and welcome vendors that fund or staff sustained maintenance | Every user may ask for help; governance must distinguish useful reports from an implied service obligation |
| A vendor contributes an adapter that makes a proprietary dependency or hosted API the practical center of the project | Keep vendor adapters optional, require clear dependency terms and operational boundaries, and maintain vendor-neutral contracts plus a runnable reference path | Supporting commercial services is legitimate when users retain a meaningful choice |
| A project steward accepts community code and later places it in a private edition or grants secret proprietary exceptions | Start with DCO provenance and inbound-equals-outbound licensing; adopt no CLA, copyright assignment, or commercial exception program without public review | A future exception program requires explicit rights from affected contributors and a governance policy before it can operate |
| A company acquires the steward, changes future licensing, or abandons the public project | Keep released grants irrevocable, avoid concentrated contributor copyrights, publish decisions, and move project assets to an independent entity when the community can sustain one | Copyright owners can choose terms for new work they own; the community's durable remedy is its right to continue released code and use distinct branding |
| A patent holder contributes code and later asserts patents against users | Select a license with an express patent grant and retaliation terms; require contributors to have the right to submit their work | No license can grant patent rights that a contributor does not control |
| Official packages or releases are replaced, typosquatted, or built from unreviewed code | Reserve namespaces, require protected release workflows, use least-privilege automation, publish provenance and an SBOM as distribution matures, and keep more than one release administrator | These controls establish provenance; they do not make every dependency trustworthy |
| Telemetry, hosted logs, workflow artifacts, or user code become a separate extraction business | Keep telemetry opt-in, disclose every transmitted field and recipient, minimize retention, provide export and deletion, and never sell project or user data | The software license alone does not govern every operator's handling of data |
| A vendor captures an open protocol through incompatible extensions or misleading compatibility claims | Keep the Workflow IR and runtime contracts inspectable, use public conformance tests, and reserve any official compatibility mark for implementations that pass published criteria | Copyright generally cannot prevent independent reimplementation of public behavior, and vendor neutrality depends on permitting it |
| Community knowledge is copied into a competing implementation, model, or internal playbook | Preserve attribution and license notices where copyright applies; build durable public specifications, community trust, and release provenance | General ideas, independently written implementations, internal learning, and many training questions cannot be reliably controlled without restrictions that would also harm research and legitimate reuse |
| A business profits from support, training, integration, or an unrelated product and sends no patch upstream | Permit it | These activities spread skill and adoption without enclosing Anastom's primary functionality; mandatory payment or upstream acceptance would burden good community participants |

## Licensing decision

Anastom uses unmodified `AGPL-3.0-only`. It is an OSI-approved open-source license that permits commercial and internal use while keeping the covered program and its modifications under reciprocal terms. An operator of a modified network-interactive version must offer its corresponding source to remote users.

AGPL does not plainly reach every independent thin wrapper or surrounding service component. SSPL was considered because it directly requires source for a broader service stack, but it is not OSI-approved and could burden good-faith community hosts and adopters. Hosted-service and non-compete licenses were rejected because they can prohibit even a community service willing to publish its implementation.

The launch policy is:

1. license the repository, including the core, engine, CLI, and official runtime implementations, under unmodified `AGPL-3.0-only` unless a file clearly states otherwise;
2. use DCO 1.1 sign-off, with contributors retaining copyright;
3. offer no closed-source commercial exceptions and require no CLA at launch;
4. evaluate client SDKs, wire protocols, schemas, examples, and documentation separately before they become stable public integration surfaces;
5. keep official hosted functionality in covered components rather than designing a turnkey proprietary-wrapper seam; and
6. describe the residual independent-wrapper boundary candidly.

Any future paid exception should be proposed publicly with objective eligibility, transparent aggregate reporting, a stated community reinvestment policy, and the contributor rights required to grant it.

## Controls that do not belong in the license

The project will keep the following concerns in governance and operating policy instead of inventing license clauses:

- maintainer selection, conflicts, sponsor influence, and decision records;
- truthful use of the Anastom name and official status;
- security disclosure and release provenance;
- privacy, telemetry, retention, and user-data portability;
- contribution review, credit, and authorship; and
- the criteria for moving trademarks, package namespaces, funds, and infrastructure to an independent stewardship entity.

Keeping these controls separate lets each mechanism address the conduct it can actually govern and avoids a bespoke license that is difficult for contributors and adopters to interpret.
