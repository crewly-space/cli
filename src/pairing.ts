import * as detect from "./detect.ts";
import type { Identity } from "./identity.ts";
import * as server from "./server.ts";
import * as state from "./state.ts";

interface PairingCreated {
  pairingId: string;
  pollToken: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
}

interface PairOptions {
  approvalToken?: string;
  noOpen?: boolean;
  waitForApproval?: boolean;
  pollIntervalMs?: number;
}

export async function pairDevice(
  config: state.Config,
  identity: Identity,
  options: PairOptions = {},
): Promise<boolean> {
  const created = await request<PairingCreated>(config.serverUrl, "/api/v1/devices/pairings", {
    method: "POST",
    body: JSON.stringify({
      deviceId: identity.deviceId,
      deviceName: config.deviceName,
      publicKey: identity.publicKeyString(),
      platform: detect.platform(),
    }),
  });

  console.log(`\nPair this device with code ${created.userCode}`);
  console.log(`Open ${created.verificationUrl}`);

  if (options.approvalToken) {
    await request(config.serverUrl, `/api/v1/devices/pairings/code/${encodeURIComponent(created.userCode)}/approve`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.approvalToken}` },
    });
  } else if (!options.noOpen) {
    await server.openUrl(created.verificationUrl);
  }

  if (options.waitForApproval === false) {
    console.log("Complete approval in the app, then run 'crewly connect' again.");
    return false;
  }

  const deadline = new Date(created.expiresAt).getTime();
  process.stdout.write(options.approvalToken ? "Approving device" : "Waiting for approval in the app");
  while (Date.now() < deadline) {
    const claim = await request<{ status: "pending" | "approved"; deviceId?: string }>(
      config.serverUrl,
      `/api/v1/devices/pairings/${encodeURIComponent(created.pairingId)}/claim`,
      { method: "POST", body: JSON.stringify({ pollToken: created.pollToken }) },
    );
    if (claim.status === "approved") {
      if (claim.deviceId !== identity.deviceId) throw new Error("server approved a different device identity");
      config.paired = true;
      await state.save(config);
      console.log("\n✓ Device paired securely");
      return true;
    }
    process.stdout.write(".");
    await Bun.sleep(options.pollIntervalMs ?? 2_000);
  }
  console.log();
  throw new Error("pairing code expired; run 'crewly connect' to try again");
}

async function request<T = unknown>(baseUrl: string, path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${path} failed (HTTP ${response.status}): ${body.slice(0, 300)}`);
  }
  return response.json() as Promise<T>;
}
