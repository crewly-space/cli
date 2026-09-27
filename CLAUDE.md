# Crewly CLI instructions

GitHub organization: crewly-space. One of four repositories:
`server`, `app`, `cli` (this), `cloud`.

`src/protocol` is a **vendored copy owned by the server repo**. Do not edit it
here — change it in the server repo, then `npm run vendor:sync` and commit.
CI runs `vendor:check`.

This is the most independent of the four repositories: exactly one file
(`src/device-operations.ts`) imports the protocol. Keep it that way. If the CLI
starts needing broad protocol access, that is a signal the boundary moved.

The CLI installs the server and app as release artifacts from their own
repositories. It never builds them from source.

Runtime is Bun, not Node. Imports carry explicit `.ts` extensions.

## Releasing

The CLI authenticates server releases: `src/server-install.ts` verifies
`checksums.txt.sig` against the embedded `RELEASE_PUBLIC_KEY` (overridable via
`CREWLY_RELEASE_PUBLIC_KEY`) before trusting any checksum. Before cutting a
CLI release:

- `RELEASE_PUBLIC_KEY` must be non-empty and match the key the server's
  release workflow signs with (its "Sign the checksums" step logs it).
- The latest server release must publish `checksums.txt.sig`. If it does not,
  a CLI release cannot install the server. Fix the server release first.
- Never weaken or skip the signature check to unblock an install. Never
  generate or handle the private key in a session; it is the server repo's
  `RELEASE_SIGNING_KEY` secret.
