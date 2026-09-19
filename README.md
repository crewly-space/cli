# Crewly CLI

The `crewly` command: installs, updates, and manages an Crewly server and
app on a machine, and runs the local device daemon that bridges on-device model
providers to a server.

```text
src/
  protocol/   vendored from crewly-server  (do not edit here)
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

## Running a server from source

`crewly init`, `up` and `server start` need `crewly-server` (and, for
server + app mode, the `web/` folder). The CLI looks for them in this order:

1. `CREWLY_SERVER_BIN` / `CREWLY_WEB_DIR`, if set
2. next to the `crewly` executable (the layout the installer produces)
3. `<config dir>/crewly/server-bin/`, where the CLI keeps a copy it downloaded

If neither an override nor a copy exists, the CLI downloads the server release
for this platform, verifies it against the release's `checksums.txt`, and
unpacks it into `server-bin/`. That is what happens under `bun run dev`, where
the executable is Bun itself. `CREWLY_VERSION` pins a release tag and
`CREWLY_RELEASE_BASE_URL` points the download at a mirror.

An already downloaded server is not refreshed; delete `server-bin/` to fetch
the latest one again.

## Vendored code

```sh
npm run vendor:check    # CI: fails if the protocol copy drifted
npm run vendor:sync     # refresh from ../server, then commit
```

Only `src/device-operations.ts` touches the protocol; the rest of the CLI is
independent of the server's wire format.
