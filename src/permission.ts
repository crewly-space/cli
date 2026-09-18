import type { Permission, Workspace } from "./state.ts";

const declared = new Set([
  "workspace.read",
  "workspace.write",
  "shell.run",
  "network.access",
  "git.commit",
  "git.push",
  "mcp.use",
]);

export interface Decision {
  capability: string;
  policy: Permission;
  needsAsk: boolean;
}

export function evaluate(workspace: Workspace, capability: string): Decision {
  if (!declared.has(capability)) throw new Error(`undeclared capability "${capability}"`);
  const policy = workspace.permissions?.[capability] ?? "deny";
  if (policy !== "allow" && policy !== "ask" && policy !== "deny") {
    throw new Error(`invalid policy "${policy}"`);
  }
  return { capability, policy, needsAsk: policy === "ask" };
}
