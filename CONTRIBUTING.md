# Contributing

Thanks for looking. This is a small project kept by one person.

Issues are welcome. Pull requests are welcome for small fixes; for anything bigger, open an issue first.

## Before you open an issue

- Use invented data only. Never paste a real client name, a real report link, a secret, an ingest secret, a Cloudflare token or a log line
  that holds one. Replace your hostname with `audit.example.com`.
- Run `scripts/webobs-doctor.sh` on the server if a publish or a link is refused. It prints no secret.
- For a security problem, do not open a public issue. Follow `SECURITY.md`.

## If pull requests are welcome

- Node 22 or newer. `npm install`, then `npm run typecheck` and `npm test` must pass.
- A change in behavior comes with a test.
- No new dependency without a reason in the pull request.
- No analytics, no tracking and no request to a third party from the visitor's browser.
- Plain wording in code, docs and messages. No dashes used as punctuation.
- The globe in `vendor/web-obs` is copied from web-obs. Changes to it belong upstream; see `UPSTREAM.md`.
- Keep real client data, client names and secrets out of the repository, including tests and fixtures. `npm run check:client-data` needs a local list of
  client names that you keep outside the repository; it is the maintainer's check and optional for contributors.

By contributing you agree that your work is released under the MIT license of this repository.
