import { describe, expect, test } from "bun:test";
import { formatPrompt } from "./claude-subscription.ts";

describe("formatPrompt", () => {
  test("preserves conversation roles", () => {
    const got = formatPrompt([
      { role: "user", content: "Plan the launch" },
      { role: "assistant", content: "What is the date?" },
      { role: "user", content: "Tuesday" },
    ]);
    for (const want of ["USER:\nPlan the launch", "ASSISTANT:\nWhat is the date?", "USER:\nTuesday"]) {
      expect(got).toContain(want);
    }
  });

  test("defaults a blank role to USER and ends on the assistant turn", () => {
    expect(formatPrompt([{ role: "  ", content: "hi" }])).toBe("USER:\nhi\n\nASSISTANT:\n");
  });
});
