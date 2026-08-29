import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

interface UpstreamLock {
  version: string;
  protocol: { openapiSha256: string; asyncapiSha256: string };
}

const lock = JSON.parse(
  await readFile(
    new URL("../../../upstream.lock.json", import.meta.url),
    "utf8",
  ),
) as UpstreamLock;
const baseUrl = process.env.KIMI_SERVER_URL ?? "http://127.0.0.1:58627";
const token = process.env.KIMI_SERVER_TOKEN;
if (!token) throw new Error("KIMI_SERVER_TOKEN is required");

async function hashDocument(path: string): Promise<string> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return createHash("sha256")
    .update(Buffer.from(await response.arrayBuffer()))
    .digest("hex");
}

const [openapi, asyncapi, metaResponse] = await Promise.all([
  hashDocument("/openapi.json"),
  hashDocument("/asyncapi.json"),
  fetch(`${baseUrl}/api/v1/meta`, {
    headers: { authorization: `Bearer ${token}` },
  }),
]);
const meta = (await metaResponse.json()) as {
  data?: { server_version?: string };
};
const errors: string[] = [];
if (openapi !== lock.protocol.openapiSha256)
  errors.push(`OpenAPI mismatch: ${openapi}`);
if (asyncapi !== lock.protocol.asyncapiSha256)
  errors.push(`AsyncAPI mismatch: ${asyncapi}`);
if (meta.data?.server_version !== lock.version) {
  errors.push(`Version mismatch: ${meta.data?.server_version ?? "unknown"}`);
}
if (errors.length) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
console.log(`Kimi ${lock.version} protocol matches the pinned contract`);
