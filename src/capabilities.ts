import * as detect from "./detect.ts";
import type * as state from "./state.ts";

/**
 * What this device tells the server it can do: the providers it has enabled,
 * its workspaces, and the runtimes it found installed. Sent with every
 * heartbeat, and in reply to an operation that changes it, so the server
 * does not have to wait for the next heartbeat to see the change.
 */
export function deviceCapabilities(config: state.Config): Record<string, unknown> {
  return {
    providers: config.providers.map(({ id, kind, label, localOnly }) => ({ id, kind, label, localOnly })),
    workspaces: config.workspaces.map(({ id, name }) => ({ id, name })),
    runtimes: detect.all().filter((runtime) => runtime.installed).map(({ id, name, authenticated: ready }) => ({ id, name, authenticated: ready })),
  };
}
