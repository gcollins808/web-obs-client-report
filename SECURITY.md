# Security policy

## Reporting a problem

Please report a security problem privately, not in a public issue.

Use GitHub private vulnerability reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Only
the maintainer can see the report.

Please include what you found, the version (the image tag or `package.json` version), the steps to reproduce it, and what you think the
effect is. Do not include real client data, real tokens or real secrets; use synthetic data.

This is a beta maintained by one person. There is no guaranteed response time, and no bug bounty.

## Supported versions

Only the newest release is supported. See `docs/RELEASE-NOTES.md`.

## What is in scope

The report viewer, the report server (`apps/server`), the optional HTTPS ingest service, the cleanup tool and the example stacks in
`deploy/`. The threat model and its limits are in `docs/INGEST-SECURITY.md` and the "Security model in plain words" section of the
README. The vendored globe under `vendor/web-obs` comes from web-obs; problems in the upstream code are best reported to that project too.

## Known limits

Links are bearer secrets until they expire or are revoked, reports are plain JSON on disk, and there has been no third-party penetration
test. These are listed in the README.
