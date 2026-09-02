import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const lockPath = join(repositoryRoot, "upstream.lock.json");
const requestedVersion = process.argv[2];
const version =
  requestedVersion ??
  execFileSync("npm", ["view", "@moonshot-ai/kimi-code", "version"], {
    encoding: "utf8",
  }).trim();
const tag = `@moonshot-ai/kimi-code@${version}`;
const releaseResponse = await fetch(
  `https://api.github.com/repos/MoonshotAI/kimi-code/releases/tags/${encodeURIComponent(tag)}`,
  { headers: { accept: "application/vnd.github+json" } },
);
if (!releaseResponse.ok) {
  throw new Error(
    `GitHub release lookup returned HTTP ${releaseResponse.status}`,
  );
}
const release = await releaseResponse.json();
const assets = new Map(
  release.assets.map((asset) => [asset.name, asset.browser_download_url]),
);
const manifestUrl = assets.get("manifest.json");
if (!manifestUrl) throw new Error("The Kimi release omitted manifest.json");
const manifestResponse = await fetch(manifestUrl);
if (!manifestResponse.ok) {
  throw new Error(`Kimi manifest returned HTTP ${manifestResponse.status}`);
}
const manifest = await manifestResponse.json();
if (manifest.version !== version || manifest.tag !== tag) {
  throw new Error(
    "Kimi manifest identity does not match the requested release",
  );
}

const commitLines = execFileSync(
  "git",
  [
    "ls-remote",
    "https://github.com/MoonshotAI/kimi-code.git",
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ],
  { encoding: "utf8" },
)
  .trim()
  .split(/\r?\n/u);
const commit =
  commitLines.find((line) => line.endsWith("^{}"))?.split(/\s+/u)[0] ??
  commitLines[0]?.split(/\s+/u)[0];
if (!commit || !/^[0-9a-f]{40}$/u.test(commit)) {
  throw new Error("Unable to resolve the Kimi release commit");
}

const temporary = await mkdtemp(join(tmpdir(), "aialra-kimi-upstream-"));
const platformKey = process.platform === "win32" ? "win32-x64" : "linux-x64";
const platformAsset = manifest.platforms[platformKey];
if (!platformAsset) throw new Error(`The Kimi release omitted ${platformKey}`);
const platformAssetUrl = assets.get(platformAsset.filename);
if (!platformAssetUrl)
  throw new Error(`The Kimi release omitted ${platformKey}`);
const archive = join(temporary, platformAsset.filename);
const archiveResponse = await fetch(platformAssetUrl);
if (!archiveResponse.ok) {
  throw new Error(
    `Kimi ${platformKey} asset returned HTTP ${archiveResponse.status}`,
  );
}
const archiveBytes = Buffer.from(await archiveResponse.arrayBuffer());
const archiveHash = createHash("sha256").update(archiveBytes).digest("hex");
if (archiveHash !== platformAsset.checksum) {
  throw new Error(
    `Kimi ${platformKey} asset did not match the release manifest checksum`,
  );
}
await writeFile(archive, archiveBytes, { mode: 0o600 });
const extracted = join(temporary, "extracted");
await mkdir(extracted);
if (process.platform === "win32") {
  execFileSync("tar", ["-xf", archive, "-C", extracted]);
} else {
  execFileSync("unzip", ["-q", archive, "-d", extracted]);
}

async function findKimi(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findKimi(path);
      if (nested) return nested;
    } else if (entry.name === "kimi" || entry.name === "kimi.exe") {
      return path;
    }
  }
  return null;
}

const executable = await findKimi(extracted);
if (!executable)
  throw new Error(`The Kimi ${platformKey} asset omitted the executable`);
if (process.platform !== "win32") execFileSync("chmod", ["0700", executable]);
const kimiHome = join(temporary, "home");
const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const selected = typeof address === "object" && address ? address.port : 0;
    server.close((error) => (error ? reject(error) : resolvePort(selected)));
  });
});
const child = spawn(
  executable,
  [
    "web",
    "--no-open",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--log-level",
    "warn",
  ],
  {
    env: { ...process.env, KIMI_CODE_HOME: kimiHome },
    stdio: "ignore",
  },
);

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const token = (
        await readFile(join(kimiHome, "server.token"), "utf8")
      ).trim();
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/healthz`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) return token;
    } catch {
      // The server and token file become ready together during the bounded wait.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(
    "The candidate Kimi server did not become ready in 30 seconds",
  );
}

async function contractHash(path, token) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return createHash("sha256")
    .update(Buffer.from(await response.arrayBuffer()))
    .digest("hex");
}

let openapiSha256;
let asyncapiSha256;
try {
  const token = await waitForServer();
  [openapiSha256, asyncapiSha256] = await Promise.all([
    contractHash("/openapi.json", token),
    contractHash("/asyncapi.json", token),
  ]);
} finally {
  child.kill("SIGTERM");
}

const current = JSON.parse(await readFile(lockPath, "utf8"));
const updated = {
  ...current,
  version,
  tag,
  commit,
  releaseAssets: {
    "linux-arm64": manifest.platforms["linux-arm64"].checksum,
    "linux-x64": manifest.platforms["linux-x64"].checksum,
    "win32-arm64": manifest.platforms["win32-arm64"].checksum,
    "win32-x64": manifest.platforms["win32-x64"].checksum,
  },
  protocol: {
    openapiSha256,
    asyncapiSha256,
    status: "experimental",
  },
};
const currentRelease = { ...current };
const updatedRelease = { ...updated };
delete currentRelease.capturedAt;
delete updatedRelease.capturedAt;
if (JSON.stringify(currentRelease) === JSON.stringify(updatedRelease)) {
  console.log(`Kimi ${version} remains the pinned upstream release`);
} else {
  updated.capturedAt = new Date().toISOString();
  await writeFile(lockPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  console.log(`Updated upstream.lock.json to Kimi ${version} at ${commit}`);
}
