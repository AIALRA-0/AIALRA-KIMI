export function transcriptRetryDelay(
  attempt: number,
  random = Math.random,
): number {
  const ceiling = Math.min(500 * 2 ** Math.max(0, attempt), 15_000);
  return Math.round(ceiling * (0.65 + random() * 0.35));
}

/**
 * Browser relay handshakes are deliberately more eager than transcript reads
 * because an agent can become ready a few hundred milliseconds after the
 * control plane reports it online
 */
export function relayRetryDelay(attempt: number, random = Math.random): number {
  const ceiling = Math.min(250 * 2 ** Math.max(0, attempt), 15_000);
  return Math.round(ceiling * (0.75 + random() * 0.25));
}
