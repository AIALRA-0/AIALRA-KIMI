import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

function productionEnv(): NodeJS.ProcessEnv {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PUBLIC_ORIGIN: "https://kimi.example.invalid",
    DATABASE_KEY: randomBytes(32).toString("base64url"),
    SESSION_KEY: randomBytes(32).toString("base64url"),
    GRANT_SIGNING_PRIVATE_KEY: privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
    OIDC_ISSUER: "https://auth.example.invalid/application/o/main/",
    OIDC_CLIENT_ID: "main-client",
    OIDC_CLIENT_SECRET: "main-secret",
    OIDC_REDIRECT_URI: "https://kimi.example.invalid/auth/callback",
  };
}

describe("production identity configuration", () => {
  it("rejects production without a dedicated elevation client", () => {
    expect(() => loadConfig(productionEnv())).toThrow(
      "dedicated elevation OIDC client",
    );
  });

  it("accepts a complete dedicated elevation client", () => {
    const config = loadConfig({
      ...productionEnv(),
      OIDC_ELEVATION_CLIENT_ID: "elevation-client",
      OIDC_ELEVATION_CLIENT_SECRET: "elevation-secret",
      OIDC_ELEVATION_REDIRECT_URI:
        "https://kimi.example.invalid/auth/elevate/callback",
    });
    expect(config.elevationOidc?.clientId).toBe("elevation-client");
  });

  it("rejects an elevation client without any issuer", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        OIDC_ELEVATION_CLIENT_ID: "elevation-client",
        OIDC_ELEVATION_CLIENT_SECRET: "elevation-secret",
        OIDC_ELEVATION_REDIRECT_URI:
          "https://kimi.example.invalid/auth/elevate/callback",
      }),
    ).toThrow("requires OIDC_ELEVATION_ISSUER or OIDC_ISSUER");
  });
});
