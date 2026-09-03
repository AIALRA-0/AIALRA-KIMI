import type { HostDescriptor } from "@aialra-kimi/protocol";

export function kimiErrorText(value: string): string {
  if (/40111|No token for ['\"]kimi-code['\"]/i.test(value)) {
    return "这台主机尚未登录 Kimi Code，请先完成账号授权";
  }
  return value;
}

export function isKimiAuthenticationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /40111|No token for ['\"]kimi-code['\"]/i.test(error.message)
  );
}

export function isHostChannelReady(
  host: HostDescriptor | undefined,
  hasChannel: boolean,
  demo: boolean,
): boolean {
  return Boolean(
    demo ||
      (host?.state === "online" &&
        host.loginState === "authenticated" &&
        hasChannel),
  );
}

export function canSendPrompt(
  host: HostDescriptor | undefined,
  hasSession: boolean,
  hasChannel: boolean,
  demo: boolean,
  sending: boolean,
  hasContent: boolean,
): boolean {
  return Boolean(
    hasContent &&
      hasSession &&
      !sending &&
      isHostChannelReady(host, hasChannel, demo),
  );
}

export function sameHosts(
  left: HostDescriptor[],
  right: HostDescriptor[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((host, index) => {
    const next = right[index];
    return (
      next !== undefined &&
      host.hostId === next.hostId &&
      host.displayName === next.displayName &&
      host.mode === next.mode &&
      host.state === next.state &&
      host.platform === next.platform &&
      host.agentVersion === next.agentVersion &&
      host.kimiVersion === next.kimiVersion &&
      host.loginState === next.loginState &&
      host.lastSeenAt === next.lastSeenAt &&
      host.capabilities.length === next.capabilities.length &&
      host.capabilities.every(
        (capability, capabilityIndex) =>
          capability === next.capabilities[capabilityIndex],
      )
    );
  });
}
