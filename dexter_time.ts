import Decimal from "decimal.js";
// @ts-ignore - module has no bundled typings in this repo setup
import { Big } from "sjs-biginteger";

const MIN_REASONABLE_UNIX_SECONDS = 946684800;
const MAX_FUTURE_SKEW_SECONDS = 86400;

function coerceNumericTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Decimal) {
    if (!value.isFinite()) return null;
    return value.toNumber();
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function coerceBigTimestamp(value: unknown): Big | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Decimal) {
    if (!value.isFinite()) return null;
    return new Big(value.toString());
  }
  if (typeof value === "bigint") return new Big(value.toString());
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return new Big(value.toString());
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    try {
      return new Big(text);
    } catch {
      return null;
    }
  }
  try {
    return new Big(String(value));
  } catch {
    return null;
  }
}

export function normalizeUnixTimestamp(
  value: unknown,
  options: { fallback?: number | null; now?: number | null } = {}
): number {
  let now = options.now ?? Date.now() / 1000;
  now = Number(now);
  let fallback = options.fallback ?? now;
  fallback = Math.floor(Number(fallback));

  let numeric = coerceBigTimestamp(value);
  if (numeric === null) return fallback;

  const magnitude = numeric.abs();
  if (magnitude.gte("1000000000000000000")) numeric = numeric.div("1000000000");
  else if (magnitude.gte("1000000000000000")) numeric = numeric.div("1000000");
  else if (magnitude.gte("1000000000000")) numeric = numeric.div("1000");

  const normalized = numeric.round(0, Big.roundDown);
  if (normalized.lt(String(MIN_REASONABLE_UNIX_SECONDS))) return fallback;
  if (normalized.gt(String(Math.floor(now) + MAX_FUTURE_SKEW_SECONDS))) return fallback;
  return Number(normalized.toString());
}

export function safeUtcDatetimeFromTimestamp(
  value: unknown,
  options: { fallback?: number | null; now?: number | null } = {}
): Date {
  const normalized = normalizeUnixTimestamp(value, options);
  return new Date(normalized * 1000);
}

export function normalizeEventPayloadTimestamp(
  payload: Record<string, unknown> | null | undefined,
  options: { fallback?: number | null; now?: number | null } = {}
): Record<string, unknown> | null | undefined {
  if (!payload || typeof payload !== "object") return payload;
  if (!("timestamp" in payload)) return payload;
  const normalized = normalizeUnixTimestamp(payload.timestamp, options);
  if (payload.timestamp === normalized) return payload;
  return { ...payload, timestamp: normalized };
}
