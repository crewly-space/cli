# OpenCrew CLI

The `opencrew` command: installs, updates, and manages an OpenCrew server and
app on a machine, and runs the local device daemon that bridges on-device model
providers to a server.

```text
src/
  protocol/   vendored from opencrew-server  (do not edit here)
  provider/   local model providers
  service/    OS service installation
  daemon.ts supervisor.ts pairing.ts workspace.ts ...
```

## Develop

Requires Bun 1.4+.

```sh
bun install
bun test          # 74 tests
bun run dev
npm run build     # native binary
```

## Vendored code

```sh
npm run vendor:check    # CI: fails if the protocol copy drifted
npm run vendor:sync     # refresh from ../opencrew-server, then commit
```

Only `src/device-operations.ts` touches the protocol; the rest of the CLI is
independent of the server's wire format.
