# SSHDrop project workflow

- Use descriptive branches such as `feat/remote-editor` or `fix/transfer-cancellation`. Do not use `codex` in branch names.
- Keep changes focused. Add meaningful regression tests for new behavior and bug fixes, including failure paths. Preserve existing tests.
- Run `npm run check` before committing; it includes core coverage thresholds. Run `npm run test:e2e` for desktop integration changes.
- Keep README, CHANGELOG, and the roadmap accurate. Do not describe planned features as implemented.
- `package.json` is the application version source. Use `npm run version:bump -- X.Y.Z` at release boundaries, not after every commit. Keep the lockfile and changelog consistent.
- Keep renderer sandboxing and context isolation enabled. Validate IPC payloads and senders. Never expose generic filesystem, shell, or IPC access to the renderer.
- Never commit secrets, user profiles, private keys, or signing material. Never log passwords, passphrases, or terminal contents.
- Commit coherent verified changes. Do not publish releases, push, or change repository settings unless authorized.
