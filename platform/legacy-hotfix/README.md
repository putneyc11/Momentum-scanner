# Separate settings-credential hotfix

The included patch was committed locally as `009f6ca` on `codex/scanner-settings-secret-hotfix`, based on scanner commit `3812de9`. It modifies only the canonical server template, its two active generated copies, the server-only build option and isolated security tests.

It removes credentials from settings load/save/GET/POST using a strict preference allowlist, scrubs old credential fields and returns no-store responses and generic errors. Environment-owned push storage also removes unnecessary saved keys. Seven isolated no-network tests pass. Broker credentials still belong in Render's environment; key rotation is still required.

The patch does not redesign every legacy authentication or proxy boundary. Public preference writes and the old client-owned push mode remain legacy risks. The new platform replaces those patterns with authenticated APIs and server-only broker credentials.

**Not pushed or deployed.** The safety review blocked publishing source to GitHub without explicit destination approval. No alternative publishing mechanism was used.

For a developer reviewing a separate clean checkout of the same base, apply the patch with `git apply --check` first, then apply it normally and run `node --test tests/test-settings-security.js`. Do not overwrite unrelated local edits. The existing working checkout already has this commit on its dedicated branch; it does not need the patch applied again.

After the user approves publishing to `putneyc11/Momentum-scanner`, open a separate review for this hotfix, deploy it deliberately, and verify only the sanitized response keys—never log or download credential values from the old live endpoint.
