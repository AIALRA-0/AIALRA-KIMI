import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const matrix = JSON.parse(
  await readFile(new URL("docs/upstream-feature-matrix.json", root), "utf8"),
);
const lock = JSON.parse(
  await readFile(new URL("upstream.lock.json", root), "utf8"),
);
const operationsSource = await readFile(
  new URL("packages/protocol/src/operations.ts", root),
  "utf8",
);
const knownOperations = new Set(
  [...operationsSource.matchAll(/^\s*"([a-z][a-z0-9.]+)",?$/gm)].map(
    (match) => match[1],
  ),
);

const allowedStatuses = new Set(["native", "secured", "substituted"]);
const ids = new Set();

if (matrix.upstreamVersion !== lock.version) {
  throw new Error(
    `feature matrix targets ${matrix.upstreamVersion}, but upstream.lock.json targets ${lock.version}`,
  );
}
if (!Array.isArray(matrix.features) || matrix.features.length === 0) {
  throw new Error("feature matrix must contain at least one feature");
}

for (const [index, feature] of matrix.features.entries()) {
  const prefix = `features[${index}]`;
  if (typeof feature.id !== "string" || feature.id.length === 0) {
    throw new Error(`${prefix}.id is required`);
  }
  if (ids.has(feature.id)) {
    throw new Error(`duplicate feature id: ${feature.id}`);
  }
  ids.add(feature.id);
  if (!allowedStatuses.has(feature.status)) {
    throw new Error(`${feature.id} has invalid status: ${feature.status}`);
  }
  if (!Array.isArray(feature.operations) || feature.operations.length === 0) {
    throw new Error(
      `${feature.id} must name at least one implementation operation`,
    );
  }
  for (const operation of feature.operations) {
    if (!knownOperations.has(operation)) {
      throw new Error(`${feature.id} names unknown operation: ${operation}`);
    }
  }
  if (typeof feature.evidence !== "string" || feature.evidence.length === 0) {
    throw new Error(`${feature.id} must include evidence`);
  }
  if (
    feature.status !== "native" &&
    (typeof feature.securityRationale !== "string" ||
      feature.securityRationale.length === 0)
  ) {
    throw new Error(
      `${feature.id} must explain its secured or substituted behavior`,
    );
  }
}

console.log(
  `Kimi ${matrix.upstreamVersion} feature matrix covers ${matrix.features.length} capabilities`,
);
