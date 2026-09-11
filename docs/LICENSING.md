# Licensing Direction

## Goal

Anastom's intended community license should permit:

- personal, academic, nonprofit, and commercial use;
- internal use in production business systems;
- modification and redistribution;
- using Anastom as a tool to build proprietary software.

The license should keep Anastom itself and covered modifications available to the people who receive or interact with them, including over a network. The project also wants to discourage an organization from putting a thin proprietary service around Anastom and returning nothing to the community. AGPL does not guarantee that an independent wrapper will be covered, and the project accepts that residual risk in exchange for OSI-approved open-source terms.

The project does not treat all uncompensated commercial activity as harmful. Consulting, support, training, internal use, and products whose primary value is distinct from Anastom remain welcome. [COMMUNITY_STEWARDSHIP.md](../COMMUNITY_STEWARDSHIP.md) records the broader extraction threat model and the protections that belong outside copyright licensing.

## What “contribute back” can mean

A public software license cannot make an upstream maintainer accept a pull request, and requiring contributions to one particular repository creates governance and practical problems. AGPL instead requires covered source to remain available under its terms when its distribution or network-use conditions apply. The operator and community can then decide whether to submit, review, or independently use those changes.

## Options

### GNU Affero General Public License 3.0

AGPL-3.0 is an OSI-approved open-source license. When users interact over a network with a modified AGPL program, the operator must offer those users the corresponding source for that modified program.

This is the most interoperable and community-recognized choice. Its boundary is narrower than the stated goal: an unmodified Anastom process behind a separate proprietary wrapper may not make that wrapper part of the AGPL-covered work. Whether two components form one derivative work is fact-specific.

### Cryptographic Autonomy License 1.0

CAL-1.0 is an OSI-approved reciprocal license designed around software delivered or perceived through a network. It requires recipients to receive source for the covered work and modifications, preserves access to their user data, includes a patent grant and retaliation provision, and prohibits technical or contractual measures that prevent recipients from using an independent copy.

Those user-autonomy protections fit Anastom's durable-artifact design. CAL still defines its source obligation around the work and modified works; it does not plainly require source for every independent program used to wrap the work into a service. It is also much less familiar to adopters than AGPL.

### Server Side Public License 1.0

SSPL-1.0 is based on GPLv3 and replaces its network provision with terms that directly address software offered as a service. An operator making the program's functionality available to third parties as a service must provide the source for the service stack needed to run that service, including management software, interfaces, APIs, automation, monitoring, backup, storage, and hosting software.

This most closely matches the anti-wrapper goal. It permits internal business use and does not force an organization to publish unrelated software merely because Anastom helped develop it. SSPL is source-available and is not an OSI-approved open-source license. Its broad service-source obligation can reduce adoption and compatibility with projects or organizations that accept only OSI-approved licenses.

### Hosted-service prohibition

Licenses such as Elastic License 2.0 prohibit providing substantial functionality as a hosted or managed service. PolyForm Shield prohibits competing products and services. These are simpler when the desired remedy is a paid commercial license, but they provide no community-source path for a service operator that wants to comply through reciprocity.

## Decision

Anastom is licensed under **GNU Affero General Public License version 3 only**, identified by the SPDX expression `AGPL-3.0-only`.

The decision favors recognized open-source terms, community-hosted services, broad commercial use, and strong copyleft for the covered program. It knowingly accepts that an unmodified Anastom process behind a separate, independently implemented wrapper may not require publication of that wrapper. Whether multiple components form one combined or derivative work is fact-specific.

Do not create a modified AGPL or a bespoke “contribute back” clause without specialist legal review. Standard text gives contributors and users a shared body of interpretation and avoids accidental contradictions.

`AGPL-3.0-only` is intentional. Recipients may not automatically substitute a future version of the license. A change to `AGPL-3.0-or-later` or another license requires the public governance process and rights from the applicable copyright holders.

### Expected behavior under AGPL-3.0-only

| Activity | Intended result |
| --- | --- |
| A company runs Anastom for its own engineers or internal systems | Permitted without publishing private internal code |
| Anastom generates code for a proprietary product | The generated product is not covered merely because Anastom was used as a tool |
| An unrelated SaaS product uses Anastom internally | Permitted without licensing that unrelated product merely because Anastom is used as a tool |
| A consultant installs or operates Anastom inside a client's environment | Permitted, subject to ordinary distribution obligations when copies are conveyed |
| A vendor distributes a modified Anastom binary or appliance | Covered source and license notices must accompany the distribution as the license requires |
| An operator runs a modified network-interactive Anastom | Remote users must receive a prominent opportunity to obtain the corresponding source of that modified version at no charge |
| An operator runs unmodified Anastom behind a separate proprietary service | Anastom remains under AGPL, but the independent service may remain outside its scope; this is the accepted wrapper gap |
| A community group hosts Anastom for others | Permitted; the same network-source rules apply when it operates a modified version |
| A company independently implements the public Workflow IR without copying protected code | Generally outside Anastom's copyright license; compatibility and branding are governed separately |

This table states project intent and is not a substitute for the license text. Ambiguous boundaries should be resolved before integrations depend on them.

## Package and interface boundaries

Do not split the M0 repository across permissive and reciprocal code licenses merely to make adoption look easier. A permissive client or schema can be useful later, but it can also become the exact shim through which a closed service captures the core. Before assigning a different license to an SDK, adapter API, protocol, schema, example, or conformance suite, document:

- the integration activity the exception enables;
- why the existing license blocks a good-faith use;
- whether the boundary lets a hosted clone avoid service reciprocity;
- which implementation remains independently useful to the community; and
- how compatibility can be described without implying official status.

The first release should use one license across code and code-like examples unless a reviewed decision establishes a safer boundary.

## Contributor rights

Inbound contributions can use the same license as the project together with DCO sign-off while Anastom remains under that one license. Contributors retain copyright, and inbound terms equal outbound terms.

The launch policy offers no proprietary license exceptions and requires no contributor license agreement or copyright assignment. This reduces the risk that one steward can privately relicense community work. If the project later considers paid exceptions, DCO alone is insufficient: it would need explicit rights from every affected contributor, public governance review, and terms that explain how the public project benefits.

Already published versions remain available under the terms shipped with them. Contributor terms must be reviewed before any change that would require rights beyond `AGPL-3.0-only` and DCO sign-off.
