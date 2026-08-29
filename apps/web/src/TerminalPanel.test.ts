import { describe, expect, it } from "vitest";
import {
  defaultShellForPlatform,
  effectiveShellForPlatform,
} from "./TerminalPanel.js";

describe("terminal shell selection", () => {
  it("uses protocol-safe defaults", () => {
    expect(defaultShellForPlatform("windows")).toBe("powershell");
    expect(defaultShellForPlatform("linux")).toBe("shell");
  });

  it("replaces the stale Linux shell when switching to Windows", () => {
    expect(effectiveShellForPlatform("windows", "shell")).toBe("powershell");
  });

  it("keeps an explicit Windows CMD selection", () => {
    expect(effectiveShellForPlatform("windows", "cmd")).toBe("cmd");
  });
});
