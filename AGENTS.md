# OpenCrew CLI instructions

GitHub organization: opentribe-dev. One of four repositories:
`opencrew-server`, `opencrew-app`, `opencrew-cli` (this), `opencrew-cloud`.

`src/protocol` is a **vendored copy owned by opencrew-server**. Do not edit it
here — change it in the server repo, then `npm run vendor:sync` and commit.
CI runs `vendor:check`.

This is the most independent of the four repositories: exactly one file
(`src/device-operations.ts`) imports the protocol. Keep it that way. If the CLI
starts needing broad protocol access, that is a signal the boundary moved.

The CLI installs the server and app as release artifacts from their own
repositories. It never builds them from source.

Runtime is Bun, not Node. Imports carry explicit `.ts` extensions.
