const DEFAULT_EFFORTS = ["low", "high", "max"];

export function supportedEfforts(
  value: string | string[] | null | undefined,
): string[] {
  const efforts = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\s+/u)
      : [];
  const normalized = efforts.filter(
    (effort): effort is string =>
      typeof effort === "string" && effort.trim().length > 0,
  );
  return normalized.length > 0 ? normalized : DEFAULT_EFFORTS;
}
