# Security Policy

## Supported versions

Before the first stable release, security fixes are made on the `main` branch. Tagged support windows will be documented here when releases begin.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting at:

<https://github.com/gsornsen/anastom/security/advisories/new>

If private reporting is unavailable, contact the repository owner using the contact information on the [maintainer's GitHub profile](https://github.com/gsornsen).

Include the affected revision, impact, reproduction steps or proof of concept, and any suggested mitigation. Remove credentials, personal data, and unrelated sensitive information.

The project will acknowledge a report as soon as practical, assess scope and severity, coordinate a fix, and credit the reporter if they wish. Please allow time for a release before public disclosure.

## Scope notes

Anastom orchestrates tools that may execute code and access workspaces. Reports involving permission enforcement, workspace isolation, secret exposure, untrusted workflow input, event integrity, or adapter boundary escapes are especially relevant.

Security hardening suggestions that do not describe an exploitable vulnerability may be filed as ordinary issues.
