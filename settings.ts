import Decimal from "decimal.js";
import rawSpecs from "./legacy_settings_specs.json";
import { ENV_PATH, readEnvValues } from "./dexter_config";

export interface LegacySettingSpec {
  key: string;
  default: string;
  kind: "int" | "decimal" | "bool" | "choice";
  label: string;
  detail: string;
  section: string;
  options?: readonly string[];
}

export const LEGACY_SETTINGS_SPECS = rawSpecs as Record<string, LegacySettingSpec>;

function rawSettingValues(): Record<string, string> {
  const envValues = readEnvValues(ENV_PATH);
  const values: Record<string, string> = {};
  for (const [key, spec] of Object.entries(LEGACY_SETTINGS_SPECS)) {
    let raw = process.env[key];
    if (raw === undefined) raw = envValues[key] ?? spec.default;
    values[key] = String(raw).trim() || spec.default;
  }
  return values;
}

function parseSetting(spec: LegacySettingSpec, raw: string): unknown {
  if (spec.kind === "int") return parseInt(raw, 10);
  if (spec.kind === "bool") {
    const v = raw.trim().toLowerCase();
    if (!["1", "true", "yes", "on", "0", "false", "no", "off"].includes(v)) {
      throw new Error(`${spec.key} must be a boolean value`);
    }
    return ["1", "true", "yes", "on"].includes(v);
  }
  if (spec.kind === "choice") {
    const v = raw.trim().toLowerCase();
    if (spec.options && !spec.options.map((x) => x.toLowerCase()).includes(v)) {
      throw new Error(`${spec.key} must be one of: ${spec.options.join(", ")}`);
    }
    return v;
  }
  if (spec.kind === "decimal") {
    try {
      return new Decimal(raw);
    } catch {
      throw new Error(`${spec.key} must be a decimal value`);
    }
  }
  return raw;
}

export function loadLegacySettings(): Record<string, unknown> {
  const rawValues = rawSettingValues();
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(LEGACY_SETTINGS_SPECS)) {
    out[key] = parseSetting(spec, rawValues[key]!);
  }
  return out;
}

const _loaded = loadLegacySettings();

export const TOTAL_SWAPS_ABOVE_2_MINTS = _loaded.TOTAL_SWAPS_ABOVE_2_MINTS as number;
export const TOTAL_SWAPS_1_MINT = _loaded.TOTAL_SWAPS_1_MINT as number;
export const PRICE_STEP_UNITS = _loaded.PRICE_STEP_UNITS as Decimal;
export const SLIPPAGE_AMOUNT = _loaded.SLIPPAGE_AMOUNT as Decimal;
export const USE_MEV = _loaded.USE_MEV as boolean;
export const MEV_PROVIDER = _loaded.MEV_PROVIDER as string;
export const MEV_TIP = _loaded.MEV_TIP as Decimal;
