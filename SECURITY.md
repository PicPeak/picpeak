# Security Policy

## Scope

This policy covers the PicPeak backend, frontend, all-in-one (AIO) image, optional
ML component, and the Docker images published by the PicPeak project. Other
PicPeak repositories define their own supported versions and release channels.

## Supported Versions

Security support follows the current release channels:

| Version or channel | Security support |
| --- | --- |
| Latest stable release from `stable` | Supported; security fixes are published through this channel |
| Latest beta release from `main` | Supported; security fixes are published through this channel |
| Superseded stable or beta releases | Upgrade to the latest release in the same channel; older releases are not maintained separately |
| 3.46.x stable line | End of life. It was superseded by stable 3.132.1; the last release is v3.46.13. Upgrade to the latest stable release |
| 2.x and earlier | No longer supported |

See the [latest stable release](https://github.com/PicPeak/picpeak/releases/latest)
and [all releases, including betas](https://github.com/PicPeak/picpeak/releases).
Version numbers differ between channels; each channel receives its own updates.

### Security fixes and bug backports

**Security fixes are always released on both `stable` and `main`.** A fix that
lands on one branch must also reach the other branch and be published through
both release channels. Security updates do not wait for the next full
`main`-to-`stable` promotion.

Regular bug fixes are also generally backported automatically to `stable`.
Backports remain focused on the fix, without pulling in unrelated features.
Maintainers resolve conflicts or handle a backport manually when necessary.

The [release process](RELEASING.md) describes backports, forward-ports and
publication. Operators must apply the published updates to their installations.

## Reporting a Vulnerability

**Do not report vulnerabilities in public issues, discussions or pull requests.**

Report privately through:

- [GitHub Private Vulnerability Reporting](https://github.com/PicPeak/picpeak/security/advisories/new) (preferred).
- Email **info@picpeak.app** if you cannot use GitHub's private reporting form.

Include the affected component, version or image tag, deployment method,
reproduction steps, expected impact and any suggested fix. Share only the
information needed to reproduce the problem; remove credentials and personal
data from logs or examples.

We aim to acknowledge reports within 48 hours. This is a response target, not a
guaranteed service level or a promised resolution time. We will provide progress
updates and coordinate disclosure with the reporter. Reporter credit is optional;
tell us if you prefer to remain anonymous.

## Deployment Security

Security depends on both the software and its configuration. Operators should:

- Use HTTPS and configure the reverse proxy and trusted proxy settings correctly.
- Use strong credentials and keep deployment secrets private.
- Apply updates for the chosen release channel and restrict unnecessary network access.
- Keep backups and verify that they can be restored.

See the deployment guides for [HTTPS](https://docs.picpeak.app/deployment/ssl-certificates),
[reverse proxies](https://docs.picpeak.app/deployment/reverse-proxy),
[security settings](https://docs.picpeak.app/guides/admin-settings/security)
and [backup and restore](https://docs.picpeak.app/guides/backup-restore).

## Vulnerability Disclosure

We coordinate disclosure with the reporter while preparing fixes. Security fixes
are published through both supported channels. Advisories and release notes
identify affected versions, the fixed version in each channel, the impact and
any required mitigation or upgrade steps. Reporter credit is included with
permission.

For ordinary bugs and support requests, use
[GitHub Issues](https://github.com/PicPeak/picpeak/issues) or
[GitHub Discussions](https://github.com/PicPeak/picpeak/discussions).
