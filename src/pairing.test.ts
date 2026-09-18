import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { websocketUrl, signaturePayload } from "./daemon.ts";
import type { Identity } from "./identity.ts";
import { pairDevice } from "./pairing.ts";
import * as state from "./state.ts";

let temporaryHome = "";
afterEach(async () => {
  delete process.env.OPENCREW_HOME;
  if (temporaryHome) await rm(temporaryHome, { recursive: true, force: true });
  temporaryHome = "";
});

test("pairs with an authenticated approval and persists the result", async () => {
  temporaryHome = await mkdtemp(join(tmpdir(), "opencrew-pairing-"));
  process.env.OPENCREW_HOME = temporaryHome;
  let approved = false;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/devices/pairings") return Response.json({
        pairingId: "pair-1", pollToken: "poll-token", userCode: "A1B2C3D4",
        verificationUrl: `${url.origin}/?pair=A1B2C3D4`, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }, { status: 201 });
      if (url.pathname.endsWith("/approve")) {
        expect(request.headers.get("authorization")).toBe("Bearer owner-token");
        approved = true;
        return Response.json({ status: "approved", deviceId: "dev_0123456789abcdef0123" });
      }
      if (url.pathname.endsWith("/claim")) {
        return Response.json({ status: approved ? "approved" : "pending", deviceId: "dev_0123456789abcdef0123" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    const config = await state.load();
    config.serverUrl = server.url.toString().replace(/\/$/, "");
    config.deviceId = "dev_0123456789abcdef0123";
    config.deviceName = "Test device";
    const identity: Identity = {
      deviceId: config.deviceId,
      publicKey: new Uint8Array(32),
      publicKeyString: () => "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      sign: () => "signature",
    };
    expect(await pairDevice(config, identity, { approvalToken: "owner-token", noOpen: true, pollIntervalMs: 1 })).toBe(true);
    expect((await state.load()).paired).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("builds a credential-free websocket URL and canonical signature payload", () => {
  expect(websocketUrl("https://crew.example.test/base?token=secret")).toBe("wss://crew.example.test/api/v1/agentd/connect");
  expect(new TextDecoder().decode(signaturePayload("dev_1", "2026-01-01T00:00:00.000Z", "nonce")))
    .toBe("dev_1\n2026-01-01T00:00:00.000Z\nnonce");
});
