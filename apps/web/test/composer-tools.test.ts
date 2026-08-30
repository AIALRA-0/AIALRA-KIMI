import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMMANDS,
  filterCommands,
  mergeCommands,
} from "../src/CommandMenu.js";
import {
  insertFileMention,
  matchingFiles,
  mentionQuery,
} from "../src/FileMentionMenu.js";
import { supportedEfforts } from "../src/model-options.js";

describe("composer command and file completion", () => {
  it("keeps the fixed command baseline when dynamic discovery is unavailable", () => {
    const merged = mergeCommands([], []);
    expect(merged).toEqual(BUILTIN_COMMANDS);
    expect(merged.map((command) => command.name)).toContain("compact");
  });

  it("filters official slash commands without treating backslash as a command", () => {
    const commands = [
      { name: "compact", kind: "agent" as const, description: "压缩" },
      { name: "copy", kind: "browser" as const, description: "复制" },
    ];
    expect(filterCommands(commands, "/comp").map((item) => item.name)).toEqual([
      "compact",
    ]);
    expect(filterCommands(commands, "\\comp")).toEqual([]);
  });

  it("finds and inserts a workspace file mention", () => {
    const files = [
      { path: "src/main.ts", name: "main.ts", kind: "file" as const },
      { path: "docs", name: "docs", kind: "directory" as const },
    ];
    expect(mentionQuery("请检查 @mai")).toBe("mai");
    expect(matchingFiles(files, "请检查 @mai")).toEqual([files[0]]);
    expect(insertFileMention("请检查 @mai", "src/main.ts")).toBe(
      "请检查 @src/main.ts ",
    );
  });

  it("accepts both upstream thinking effort shapes", () => {
    expect(supportedEfforts(["low", "high", "max"])).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(supportedEfforts("low high max")).toEqual(["low", "high", "max"]);
    expect(supportedEfforts(undefined)).toEqual(["low", "high", "max"]);
  });
});
