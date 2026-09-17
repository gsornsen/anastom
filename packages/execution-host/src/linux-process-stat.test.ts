import { describe, expect, it } from "vitest";

import { parseLinuxProcessStat } from "./linux-process-stat.js";

function processStat(processGroupId: string, command = "node (worker)"): string {
  const fields = ["S", "1", processGroupId, ...Array.from({ length: 16 }, () => "0"), "98765"];
  return `42 (${command}) ${fields.join(" ")}`;
}

describe("Linux process stat parsing", () => {
  it("uses the final command delimiter and preserves exact process identity fields", () => {
    expect(parseLinuxProcessStat(processStat("41"))).toEqual({
      state: "S",
      startToken: "98765",
      processGroupId: 41,
    });
  });

  it("keeps public identity usable when process-group evidence is not yet positive", () => {
    expect(parseLinuxProcessStat(processStat("0"))).toEqual({
      state: "S",
      startToken: "98765",
    });
  });

  it("rejects input without the state and start token", () => {
    expect(() => parseLinuxProcessStat("42 (node) S 1 1")).toThrow(
      "Linux process identity is malformed",
    );
  });
});
