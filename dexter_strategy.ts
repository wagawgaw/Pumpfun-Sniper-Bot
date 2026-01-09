import * as fs from "fs";
import * as path from "path";
import rawProfiles from "./builtin_strategy_profiles.json";

export interface StrategyProfile {
  name: string;
  version: string;
  creator_weight: number;
  token_weight: number;
  buy_threshold: number;
  min_entry_score: number;
  min_trust_factor: number;
  max_failure_cluster_ratio: number;
  max_rug_ratio: number;
  min_liquidity_quality: number;
  creator_feature_weights: Record<string, number>;
  token_feature_weights: Record<string, number>;
  exit_drawdown_ratio: number;
  exit_drop_time_seconds: number;
  exit_stagnant_seconds: number;
  exit_low_price_stagnant_seconds: number;
  low_price_threshold: number;
}

export const BUILTIN_STRATEGY_PROFILES: Record<string, StrategyProfile> = Object.fromEntries(
  Object.entries(rawProfiles as Record<string, StrategyProfile>).map(([k, v]) => [k, v])
) as Record<string, StrategyProfile>;

export function getStrategyProfile(name?: string | null): StrategyProfile {
  const selected = (name ?? "balanced").trim().toLowerCase();
  if (!(selected in BUILTIN_STRATEGY_PROFILES)) {
    throw new Error(
      `Unknown strategy profile '${selected}'. Available profiles: ${Object.keys(BUILTIN_STRATEGY_PROFILES).sort().join(", ")}`
    );
  }
  return BUILTIN_STRATEGY_PROFILES[selected]!;
}

function clamp(value: number, lower = 0.0, upper = 1.0): number {
  return Math.max(lower, Math.min(upper, Number(value)));
}

function safeFloat(value: unknown, defaultValue = 0.0): number {
  if (value === null || value === undefined) return defaultValue;
  const result = Number(value);
  if (!Number.isFinite(result)) return defaultValue;
  return result;
}

function scoreWeighted(features: Record<string, number>, weights: Record<string, number>): number {
  let totalWeight = 0.0;
  let score = 0.0;
  for (const [key, weight] of Object.entries(weights)) {
    if (weight <= 0) continue;
    totalWeight += weight;
    score += clamp(features[key] ?? 0.0) * weight;
  }
  if (totalWeight <= 0) return 0.0;
  return score / totalWeight;
}

function topHolderShare(holders: Record<string, unknown> | null | undefined): number {
  const balances: number[] = [];
  for (const holder of Object.values(holders ?? {})) {
    const balance =
      typeof holder === "object" && holder !== null && "balance" in holder
        ? Number((holder as { balance?: unknown }).balance ?? 0)
        : 0;
    const balanceInt = Math.floor(balance);
    if (balanceInt > 0) balances.push(balanceInt);
  }
  if (!balances.length) return 0.0;
  const total = balances.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0.0;
  return Math.max(...balances) / total;
}

function creatorWalletActionScore(owner: string | null | undefined, holders: Record<string, unknown> | null | undefined): number {
  if (!owner) return 0.5;
  const holder = (holders ?? {})[owner];
  if (typeof holder !== "object" || holder === null) return 0.75;
  const balanceChanges = ((holder as { balance_changes?: unknown[] }).balance_changes ?? []) as unknown[];
  let buys = 0;
  let sells = 0;
  for (const item of balanceChanges) {
    const actionType = String((item as { type?: string } | null)?.type ?? "").toLowerCase();
    if (actionType === "buy") buys += 1;
    else if (actionType === "sell") sells += 1;
  }
  const total = buys + sells;
  if (total <= 0) return 0.75;
  return clamp((buys + 1) / (total + 2));
}

export function computeCreatorFeatures(entry: Record<string, unknown> | null | undefined): Record<string, number> {
  const e = { ...(entry ?? {}) };
  const trust_factor = clamp(safeFloat(e.trust_factor, 0.0));
  const median_launch_gap_seconds = safeFloat(e.median_launch_gap_seconds, 900.0);
  const launch_cadence_quality = clamp(median_launch_gap_seconds / 3600.0);
  const failure_cluster_ratio = clamp(safeFloat(e.failure_cluster_ratio, 0.0));
  const rug_ratio = clamp(safeFloat(e.rug_ratio, 0.0));
  const migration_ratio = clamp(safeFloat(e.migration_ratio, 0.0));
  const wallet_reuse_ratio = clamp(safeFloat(e.wallet_reuse_ratio, 0.0));
  const performance_score = safeFloat(e.performance_score, 0.0);
  const performance_quality = clamp(Math.log10(performance_score + 1.0) / 6.0);
  return {
    trust_factor,
    launch_cadence_quality,
    failure_cluster_quality: 1.0 - failure_cluster_ratio,
    failure_cluster_ratio,
    rug_pattern_quality: 1.0 - rug_ratio,
    rug_ratio,
    migration_quality: 1.0 - migration_ratio,
    migration_ratio,
    wallet_reuse_quality: 1.0 - wallet_reuse_ratio,
    wallet_reuse_ratio,
    performance_quality,
  };
}

export function computeTokenFeatures(
  mint_state: Record<string, unknown> | null | undefined,
  owner?: string | null
): Record<string, number> {
  const ms = { ...(mint_state ?? {}) };
  const tx_counts = (ms.tx_counts ?? {}) as Record<string, unknown>;
  const holders = (ms.holders ?? {}) as Record<string, unknown>;
  const buys = Math.max(0, Math.floor(Number(tx_counts.buys ?? 0)));
  const sells = Math.max(0, Math.floor(Number(tx_counts.sells ?? 0)));
  const swaps = Math.max(0, Math.floor(Number(tx_counts.swaps ?? buys + sells)));
  const totalSideCount = buys + sells;
  const buy_sell_imbalance = clamp((buys + 1) / (totalSideCount + 2));
  const holder_concentration_quality = 1.0 - clamp(topHolderShare(holders));
  const velocity_quality = clamp(swaps / 25.0);
  const current_price = safeFloat(ms.price ?? ms.current_price, 0.0);
  const open_price = safeFloat(ms.open_price, current_price);
  const peak_price = safeFloat(ms.high_price, current_price);
  let decay_quality = 0.5;
  if (peak_price > 0) decay_quality = clamp(current_price / peak_price);
  else if (open_price > 0) decay_quality = clamp(current_price / open_price);
  const liquidity = safeFloat(ms.liquidity, 0.0);
  const market_cap = safeFloat(ms.mc ?? ms.market_cap, 0.0);
  const liquidity_quality =
    market_cap > 0 ? clamp((liquidity / market_cap) * 4.0) : 0.0;
  const creator_wallet_action_quality = creatorWalletActionScore(owner ?? null, holders);
  return {
    buy_sell_imbalance,
    holder_concentration_quality,
    velocity_quality,
    decay_quality,
    liquidity_quality,
    creator_wallet_action_quality,
  };
}

export interface EntryStrategyEvaluation {
  profile_name: string;
  profile_version: string;
  should_buy: boolean;
  trust_level: number;
  creator_score: number;
  token_score: number;
  total_score: number;
  creator_features: Record<string, number>;
  token_features: Record<string, number>;
  thresholds: Record<string, number>;
  blocking_reasons: string[];
}

export function entryEvaluationToDict(e: EntryStrategyEvaluation): Record<string, unknown> {
  return {
    profile_name: e.profile_name,
    profile_version: e.profile_version,
    should_buy: e.should_buy,
    trust_level: e.trust_level,
    creator_score: e.creator_score,
    token_score: e.token_score,
    total_score: e.total_score,
    creator_features: e.creator_features,
    token_features: e.token_features,
    thresholds: e.thresholds,
    blocking_reasons: [...e.blocking_reasons],
  };
}

export function evaluateEntry(
  profile: StrategyProfile,
  creator_entry: Record<string, unknown> | null | undefined,
  token_state: Record<string, unknown> | null | undefined,
  options: { owner?: string | null; current_exposure?: number; wallet_address?: string | null } = {}
): EntryStrategyEvaluation {
  const { owner = null, current_exposure = 0 } = options;
  const creator_features = computeCreatorFeatures(creator_entry);
  const token_features = computeTokenFeatures(token_state, owner);
  const creator_score = scoreWeighted(creator_features, profile.creator_feature_weights);
  const token_score = scoreWeighted(token_features, profile.token_feature_weights);
  const total_score = clamp(creator_score * profile.creator_weight + token_score * profile.token_weight);
  const reasons: string[] = [];
  let passed = true;

  if (creator_features.trust_factor < profile.min_trust_factor) {
    passed = false;
    reasons.push("trust_factor_below_threshold");
  }
  if (creator_features.failure_cluster_ratio > profile.max_failure_cluster_ratio) {
    passed = false;
    reasons.push("failure_cluster_too_high");
  }
  if (creator_features.rug_ratio > profile.max_rug_ratio) {
    passed = false;
    reasons.push("rug_ratio_too_high");
  }
  if (token_features.liquidity_quality < profile.min_liquidity_quality) {
    passed = false;
    reasons.push("liquidity_too_thin");
  }
  if (total_score < profile.min_entry_score) {
    passed = false;
    reasons.push("total_score_below_threshold");
  }
  if (current_exposure > 0) {
    passed = false;
    reasons.push("creator_already_has_open_exposure");
  }

  let trust_level = 0;
  if (passed && total_score >= Math.max(profile.min_entry_score + 0.12, 0.75)) trust_level = 2;
  else if (passed) trust_level = 1;

  if (passed && reasons.length === 0) reasons.push("entry_profile_passed");

  return {
    profile_name: profile.name,
    profile_version: profile.version,
    should_buy: passed,
    trust_level,
    creator_score: Math.round(creator_score * 1e6) / 1e6,
    token_score: Math.round(token_score * 1e6) / 1e6,
    total_score: Math.round(total_score * 1e6) / 1e6,
    creator_features,
    token_features,
    thresholds: {
      buy_threshold: profile.buy_threshold,
      min_entry_score: profile.min_entry_score,
      min_trust_factor: profile.min_trust_factor,
      max_failure_cluster_ratio: profile.max_failure_cluster_ratio,
      max_rug_ratio: profile.max_rug_ratio,
      min_liquidity_quality: profile.min_liquidity_quality,
    },
    blocking_reasons: passed ? [] : reasons.filter((r) => r !== "entry_profile_passed"),
  };
}

export function evaluateExit(
  profile: StrategyProfile,
  options: {
    position?: Record<string, unknown> | null;
    mint_state?: Record<string, unknown> | null;
    context?: Record<string, unknown> | null;
  }
): Record<string, unknown> {
  const position = { ...(options.position ?? {}) };
  const mint_state = { ...(options.mint_state ?? {}) };
  const context = { ...(options.context ?? {}) };

  const price = safeFloat(mint_state.price ?? mint_state.current_price, 0.0);
  const peak_price = safeFloat(mint_state.high_price, price);
  let drawdown_ratio = 0.0;
  if (peak_price > 0 && price >= 0) drawdown_ratio = clamp(1.0 - price / peak_price);

  const self_peak_change = safeFloat(context.self_peak_change, 0.0);
  const target_pct = safeFloat(context.target_pct, 0.0);
  const time_since_last_buy = safeFloat(context.time_since_last_buy, 0.0);
  const time_since_last_change = safeFloat(context.time_since_last_change, 0.0);
  const malicious = Boolean(context.malicious);
  const is_drop_time = Boolean(context.is_drop_time);
  const forced_reason = context.forced_reason;

  let should_exit = false;
  let reason = "hold";
  const explanations: string[] = [];

  if (forced_reason) {
    should_exit = true;
    reason = String(forced_reason);
    explanations.push("operator_command");
  } else if (malicious || drawdown_ratio >= profile.exit_drawdown_ratio) {
    should_exit = true;
    reason = "malicious";
    explanations.push("drawdown_or_malicious_pattern");
  } else if (is_drop_time || time_since_last_buy >= profile.exit_drop_time_seconds) {
    should_exit = true;
    reason = "drop-time";
    explanations.push("buy_flow_stalled");
  } else if (self_peak_change >= target_pct && target_pct > 0) {
    should_exit = true;
    reason = "target_hit";
    explanations.push("profit_target_reached");
  } else if (time_since_last_change >= profile.exit_stagnant_seconds) {
    should_exit = true;
    reason = "stagnant";
    explanations.push("price_stagnated");
  } else if (
    price <= profile.low_price_threshold &&
    time_since_last_change >= profile.exit_low_price_stagnant_seconds
  ) {
    should_exit = true;
    reason = "low-price-stagnant";
    explanations.push("low_price_and_stagnant");
  }

  return {
    profile: { name: profile.name, version: profile.version },
    should_exit: should_exit,
    reason,
    explanations: explanations.length ? explanations : ["hold"],
    breakdown: {
      drawdown_ratio: Math.round(drawdown_ratio * 1e6) / 1e6,
      self_peak_change: Math.round(self_peak_change * 1e6) / 1e6,
      target_pct: Math.round(target_pct * 1e6) / 1e6,
      time_since_last_buy: Math.round(time_since_last_buy * 1000) / 1000,
      time_since_last_change: Math.round(time_since_last_change * 1000) / 1000,
      low_price_threshold: profile.low_price_threshold,
      exit_drawdown_ratio: profile.exit_drawdown_ratio,
    },
    position_context: {
      token_balance: Math.floor(Number(position.token_balance ?? 0)),
      buy_price: position.buy_price,
    },
  };
}

export function explainSell(options: {
  profile: StrategyProfile;
  token_state?: Record<string, unknown> | null;
  position?: Record<string, unknown> | null;
  context?: Record<string, unknown> | null;
  reason?: string | null;
  buy_price?: unknown;
  current_price?: unknown;
}): Record<string, unknown> {
  const merged_position = { ...(options.position ?? {}) };
  if (options.buy_price !== undefined && options.buy_price !== "") {
    merged_position.buy_price = String(options.buy_price);
  }
  const merged_state = { ...(options.token_state ?? {}) };
  if (
    options.current_price !== undefined &&
    options.current_price !== "" &&
    merged_state.price === undefined
  ) {
    merged_state.price = options.current_price;
  }
  const explanation = evaluateExit(options.profile, {
    position: merged_position,
    mint_state: merged_state,
    context: options.context,
  });
  if (options.reason) {
    (explanation as { requested_reason?: string }).requested_reason = String(options.reason);
  }
  return explanation;
}

export function serializeStrategyProfile(profile: StrategyProfile): Record<string, unknown> {
  return { ...profile };
}

function historicalCreatorEntry(records: Record<string, unknown>[]): Record<string, unknown> {
  if (!records.length) {
    return {
      trust_factor: 0.0,
      failure_cluster_ratio: 0.0,
      rug_ratio: 0.0,
      migration_ratio: 0.0,
      wallet_reuse_ratio: 0.0,
      median_launch_gap_seconds: 0.0,
      performance_score: 0.0,
    };
  }
  let success_count = 0;
  let longest_failure_run = 0;
  let current_failure_run = 0;
  let rug_count = 0;
  let migration_count = 0;
  const launch_times: number[] = [];
  const peak_market_caps: number[] = [];
  const success_ratios: number[] = [];
  for (const record of records) {
    if (record.successful) {
      current_failure_run = 0;
      success_count += 1;
      if (safeFloat(record.success_ratio, 0) > 0) success_ratios.push(safeFloat(record.success_ratio, 0.0));
    } else {
      current_failure_run += 1;
      longest_failure_run = Math.max(longest_failure_run, current_failure_run);
    }
    if (record.is_rug) rug_count += 1;
    if (record.migrated) migration_count += 1;
    const creation_time = safeFloat(record.creation_time, 0.0);
    if (creation_time > 0) launch_times.push(creation_time);
    peak_market_caps.push(safeFloat(record.peak_market_cap, 0.0));
  }
  const sortedTimes = [...launch_times].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sortedTimes.length; i++) {
    if (sortedTimes[i]! > sortedTimes[i - 1]!) gaps.push(sortedTimes[i]! - sortedTimes[i - 1]!);
  }
  const median_gap = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]! : 0.0;
  let performance_score = 0.0;
  if (peak_market_caps.length) {
    performance_score = peak_market_caps.reduce((a, b) => a + b, 0) / peak_market_caps.length;
    if (success_ratios.length) {
      performance_score *= success_ratios.reduce((a, b) => a + b, 0) / success_ratios.length;
    }
  }
  return {
    trust_factor: success_count / records.length,
    failure_cluster_ratio: longest_failure_run / records.length,
    rug_ratio: rug_count / records.length,
    migration_ratio: migration_count / records.length,
    wallet_reuse_ratio: clamp((records.length - 1) / 10.0),
    median_launch_gap_seconds: median_gap,
    performance_score,
  };
}

export function summarizeHistoricalRecord(record: Record<string, unknown>): Record<string, unknown> {
  const price_history = (record.price_history ?? {}) as Record<string, unknown>;
  const tx_counts = (record.tx_counts ?? {}) as Record<string, unknown>;
  const final_ohlc = (record.final_ohlc ?? {}) as Record<string, unknown>;
  const open_price = safeFloat(final_ohlc.open, 0.0);
  const high_price = safeFloat(final_ohlc.high, open_price);
  const current_price = safeFloat(final_ohlc.close, open_price);
  const peak_market_cap = safeFloat(record.peak_market_cap, 0.0);
  const final_market_cap = safeFloat(record.final_market_cap, 0.0);
  let success_ratio = 0.0;
  if (open_price > 0 && high_price > 0) success_ratio = ((high_price - open_price) / open_price) * 100.0;
  const is_rug = peak_market_cap > 0 && final_market_cap <= peak_market_cap * 0.2;
  return {
    mint_id: record.mint_id,
    owner: record.owner,
    creation_time: record.creation_time,
    peak_market_cap,
    successful: Boolean(record.successful),
    success_ratio,
    is_rug,
    migrated: Boolean(record.migrated),
    mint_state: {
      price_history,
      tx_counts,
      price: current_price,
      current_price,
      open_price,
      high_price,
      market_cap: final_market_cap,
      mc: final_market_cap,
      liquidity: Math.max(0.0, final_market_cap * 0.12),
      holders: record.holders ?? {},
    },
  };
}

export function backtestRecords(
  records: Record<string, unknown>[],
  options: { profile: StrategyProfile }
): Record<string, unknown> {
  const { profile } = options;

  function derivedSuccess(raw_record: Record<string, unknown>, summary: Record<string, unknown>): boolean {
    if ("successful" in raw_record) return Boolean(raw_record.successful);
    const tx_counts = (raw_record.tx_counts ?? {}) as Record<string, unknown>;
    const swaps = Math.floor(Number(tx_counts.swaps ?? 0));
    const fo = (raw_record.final_ohlc ?? {}) as Record<string, unknown>;
    const open_price = safeFloat(fo.open, 0.0);
    const high_price = safeFloat(fo.high, open_price);
    if (open_price <= 0 || high_price <= 0) return false;
    return swaps >= 25 && high_price >= open_price * 1.5;
  }

  const byCreator: Record<string, Record<string, unknown>[]> = {};
  const evaluatedCases: Record<string, unknown>[] = [];
  let passed = 0;
  let winners = 0;
  let realized_edge_pct = 0.0;

  const sortedRecords = [...records].sort(
    (a, b) => safeFloat(a.creation_time, 0.0) - safeFloat(b.creation_time, 0.0)
  );

  for (const raw_record of sortedRecords) {
    const owner = String(raw_record.owner ?? "");
    const priorRecords = (byCreator[owner] ??= []);
    const creator_entry = historicalCreatorEntry(priorRecords);
    const record = summarizeHistoricalRecord(raw_record);
    const successful = derivedSuccess(raw_record, record);
    const decision = evaluateEntry(profile, creator_entry, record.mint_state as Record<string, unknown>, {
      owner,
      current_exposure: 0,
    });
    const outcome_ratio = safeFloat(record.success_ratio, 0.0);
    if (decision.should_buy) {
      passed += 1;
      realized_edge_pct += successful ? outcome_ratio : -25.0;
      if (successful) winners += 1;
    }
    evaluatedCases.push({
      mint_id: raw_record.mint_id,
      owner,
      decision: entryEvaluationToDict(decision),
      successful,
      outcome_ratio: Math.round(outcome_ratio * 1e6) / 1e6,
    });
    priorRecords.push({
      creation_time: record.creation_time,
      peak_market_cap: record.peak_market_cap,
      successful,
      success_ratio: outcome_ratio,
      is_rug: record.is_rug,
      migrated: Boolean(raw_record.migrated),
    });
  }

  return {
    profile: { name: profile.name, version: profile.version },
    metrics: {
      records: sortedRecords.length,
      passed,
      skipped: Math.max(0, sortedRecords.length - passed),
      wins: winners,
      win_rate: passed ? Math.round((winners / passed) * 1e6) / 1e6 : 0.0,
      realized_edge_pct: Math.round(realized_edge_pct * 1e6) / 1e6,
    },
    cases: evaluatedCases,
  };
}

export function renderBacktestReport(report: Record<string, unknown>): string {
  const profile = (report.profile ?? {}) as Record<string, unknown>;
  const metrics = (report.metrics ?? {}) as Record<string, unknown>;
  return [
    `profile=${profile.name} version=${profile.version}`,
    `metrics records=${metrics.records ?? 0} passed=${metrics.passed ?? 0} wins=${metrics.wins ?? 0} win_rate=${metrics.win_rate ?? 0} realized_edge_pct=${metrics.realized_edge_pct ?? 0}`,
  ].join("\n");
}

export function loadRecordsFromJson(filePath: string): Record<string, unknown>[] {
  const file_path = path.resolve(filePath);
  const raw = fs.readFileSync(file_path, "utf-8");
  const ext = path.extname(file_path).toLowerCase();
  if (ext === ".jsonl") {
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
  const loaded = JSON.parse(raw) as unknown;
  if (Array.isArray(loaded)) return loaded as Record<string, unknown>[];
  if (typeof loaded === "object" && loaded !== null && Array.isArray((loaded as { records?: unknown }).records)) {
    return (loaded as { records: Record<string, unknown>[] }).records;
  }
  throw new Error("Backtest input must be a JSON array, JSON object with a records list, or JSONL.");
}
