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

## Guided setup

`crewly init` walks through the same steps as the web app's setup, in the
same words: run a server (or connect this device to one), create the owner
or sign in as one, choose how agents get models -- **Crewly Gateway** through
your Crewly account (it links the server for you), a provider's **API key**,
or a **subscription on this device** -- then a default model, and it checks
that the model actually answers before finishing. The default model becomes
the first agent's, Assistant, when the server has no agents yet.

Unattended: `crewly init --yes --email you@example.com --provider openai
--model gpt-4o-mini` with `CREWLY_ADMIN_PASSWORD` and
`CREWLY_PROVIDER_API_KEY` set. `--provider` takes `crewly-gateway`,
`anthropic`, `openai`, `openrouter`, `deepseek`, `openai-compatible` (with
`--base-url`), `claude-subscription`, `ollama` or `later`.

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
2. next to the `crewly` executable (the layout older installers produced)
3. `<config dir>/crewly/server-bin/`, where the CLI keeps a copy it downloaded

The installer ships only the CLI, so a device that just connects to a server
never carries one. If neither an override nor a copy exists, the CLI downloads
the server release for this platform, verifies it against the release's
`checksums.txt`, and unpacks it into `server-bin/` when `init`, `up` or
`server start` first needs it. That is also what happens under `bun run dev`,
where the executable is Bun itself. `CREWLY_VERSION` pins a release tag and
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
