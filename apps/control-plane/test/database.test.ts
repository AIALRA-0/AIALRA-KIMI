import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ControlPlaneDatabase } from "../src/database.js";

const databases: ControlPlaneDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createDatabase(): { database: ControlPlaneDatabase; path: string } {
  const path = join(
    mkdtempSync(join(tmpdir(), "aialra-kimi-db-")),
    "control.sqlite",
  );
  const database = new ControlPlaneDatabase(path, randomBytes(32));
  databases.push(database);
  return { database, path };
}

describe("control-plane database", () => {
  it("consumes pairing codes exactly once", () => {
    const { database } = createDatabase();
    database.storePairingCode(
      "ABCD-EFGH",
      "Desktop",
      "remote",
      new Date(Date.now() + 60_000),
    );
    expect(database.consumePairingCode("ABCD-EFGH")).toEqual({
      displayName: "Desktop",
      mode: "remote",
    });
    expect(database.consumePairingCode("ABCD-EFGH")).toBeNull();
  });

  it("encrypts cached titles and aliases at rest", () => {
    const { database, path } = createDatabase();
    database.registerHost({
      hostId: "host-alpha",
      displayName: "Desktop",
      mode: "remote",
      platform: "windows",
      publicKey: "public-key",
      agentVersion: "0.1.0",
    });
    database.replaceSessionCache("host-alpha", [
      {
        hostId: "host-alpha",
        upstreamSessionId: "session-one",
        title: "Sensitive title marker",
        workspaceAlias: "Private workspace marker",
        updatedAt: new Date().toISOString(),
        state: "idle",
      },
    ]);
    expect(database.getSessionCache("host-alpha")[0]?.title).toBe(
      "Sensitive title marker",
    );
    const bytes = readFileSync(path);
    expect(bytes.includes(Buffer.from("Sensitive title marker"))).toBe(false);
    expect(bytes.includes(Buffer.from("Private workspace marker"))).toBe(false);
  });

  it("rejects cross-host cache entries", () => {
    const { database } = createDatabase();
    database.registerHost({
      hostId: "host-alpha",
      displayName: "Desktop",
      mode: "remote",
      platform: "windows",
      publicKey: "public-key",
      agentVersion: "0.1.0",
    });
    expect(() =>
      database.replaceSessionCache("host-alpha", [
        {
          hostId: "host-bravo",
          upstreamSessionId: "session-one",
          title: "Title",
          workspaceAlias: "Workspace",
          updatedAt: new Date().toISOString(),
          state: "idle",
        },
      ]),
    ).toThrow("Cross-host");
  });

  it("revokes a host identity exactly once", () => {
    const { database } = createDatabase();
    database.registerHost({
      hostId: "host-alpha",
      displayName: "Desktop",
      mode: "remote",
      platform: "windows",
      publicKey: "public-key",
      agentVersion: "0.1.0",
    });

    expect(database.revokeHost("host-alpha")).toBe(true);
    expect(database.revokeHost("host-alpha")).toBe(false);
    expect(database.getHostIdentity("host-alpha")?.revoked).toBe(true);
    expect(database.listHosts()).toEqual([]);
  });

  it("does not restore stale online state after a process restart", () => {
    const { database } = createDatabase();
    for (const hostId of ["host-alpha", "host-bravo"]) {
      database.registerHost({
        hostId,
        displayName: hostId,
        mode: "remote",
        platform: "windows",
        publicKey: "public-key",
        agentVersion: "0.1.0",
      });
      database.updateHostStatus({
        hostId,
        state: "online",
        agentVersion: "0.1.0",
        kimiVersion: "0.39.1",
      });
    }
    database.revokeHost("host-bravo");
    database.markAllHostsOffline();
    expect(database.listHosts()).toEqual([
      expect.objectContaining({ hostId: "host-alpha", state: "offline" }),
    ]);
    expect(database.getHostIdentity("host-bravo")?.revoked).toBe(true);
  });

  it("keeps the new-session default separate from existing sessions", () => {
    const { database } = createDatabase();
    database.registerHost({
      hostId: "host-alpha",
      displayName: "Desktop",
      mode: "remote",
      platform: "windows",
      publicKey: "public-key",
      agentVersion: "0.1.0",
    });

    expect(database.getHostPreferences("host-alpha")).toEqual({
      defaultPermissionMode: "manual",
      pinnedSessionIds: [],
    });
    expect(
      database.setHostPreferences("host-alpha", "yolo", ["session-one"]),
    ).toBe(true);
    expect(database.getHostPreferences("host-alpha")).toEqual({
      defaultPermissionMode: "yolo",
      pinnedSessionIds: ["session-one"],
    });
    expect(database.setHostPreferences("host-alpha", "auto")).toBe(true);
    expect(database.getHostPreferences("host-alpha")).toEqual({
      defaultPermissionMode: "auto",
      pinnedSessionIds: ["session-one"],
    });
  });
});
