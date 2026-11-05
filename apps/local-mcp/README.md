# laplace-local

Command-line client for the [Laplace Runtime](../../docs/laplace-runtime.md). The CLI parses
arguments and presents results; connectors, credentials, approvals, and AI-client registrations
are owned by the runtime, so Desktop, the CLI, and every AI client share one connector process.

The runtime archive (`pnpm --filter @repo/local-mcp package`) installs `laplace-runtime` and the
compatibility name `laplace-local` into the stable per-user `bin` directory.

```
laplace-local status | start | stop | enable | disable | doctor
laplace-local login [--origin <url>] [--name <device name>]     # browser-approved linking
laplace-local logout
laplace-local install-client <claude-code|codex|claude-desktop> [--config <file>]
laplace-local serve [--client claude-code|codex|claude-desktop|other]
laplace-local import <file> --select <ids> [--confirm]
laplace-local import-legacy [--select <ids>] [--confirm]          # from ~/.laplace-local
laplace-local repair <id> | remove <id> [--confirm]
laplace-local browser catalog | setup <catalog-id> [--workspace <url>] | authenticate <id> | status | disconnect <id>
laplace-local approvals [list | open <request-id> | cancel <request-id>]
laplace-local updates status | check | enable | disable | defer | pin <id> | unpin <id> | apply [id] | enroll <id>
```

All commands accept `--profile hosted|local` (default `hosted`). Commands that change state ask for
confirmation in a terminal; pass `--confirm` after reviewing. `serve` keeps stdout for MCP frames.

Local connectors work without signing in to Laplace. `import-legacy` imports connectors from the
previous standalone CLI store disabled and leaves that store untouched; pairing and credentials
are not transferred. `approvals open` serves a request-scoped, CSRF-protected loopback page for
browser approvals when no Desktop window is available.
