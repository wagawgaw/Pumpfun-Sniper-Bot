import { randomInt } from "crypto";
import Decimal from "decimal.js";
import bs58 from "bs58";
import { PublicKey, SystemProgram, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";

export type MevProviderName =
  | "jito"
  | "helius"
  | "nextblock"
  | "zero_slot"
  | "temporal"
  | "bloxroute";

export const VALID_MEV_PROVIDERS = new Set<string>([
  "jito",
  "helius",
  "nextblock",
  "zero_slot",
  "temporal",
  "bloxroute",
]);

export const MEV_PROVIDERS_REQUIRING_KEYS = new Set<string>([
  "nextblock",
  "zero_slot",
  "temporal",
  "bloxroute",
]);

export const JITO_BLOCK_ENGINE_ENDPOINTS: readonly string[] = [
  "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1",
  "https://london.mainnet.block-engine.jito.wtf/api/v1",
  "https://amsterdam.mainnet.block-engine.jito.wtf/api/v1",
  "https://ny.mainnet.block-engine.jito.wtf/api/v1",
  "https://tokyo.mainnet.block-engine.jito.wtf/api/v1",
  "https://singapore.mainnet.block-engine.jito.wtf/api/v1",
  "https://slc.mainnet.block-engine.jito.wtf/api/v1",
  "https://mainnet.block-engine.jito.wtf/api/v1",
];

export const HELIUS_SENDER_ENDPOINTS: readonly string[] = [
  "http://fra-sender.helius-rpc.com",
  "http://ams-sender.helius-rpc.com",
  "http://lon-sender.helius-rpc.com",
  "http://slc-sender.helius-rpc.com",
  "http://ewr-sender.helius-rpc.com",
  "http://sg-sender.helius-rpc.com",
  "http://tyo-sender.helius-rpc.com",
];

export const NEXTBLOCK_ENDPOINTS: readonly string[] = [
  "http://fra.nextblock.io",
  "http://london.nextblock.io",
  "http://ny.nextblock.io",
  "http://slc.nextblock.io",
  "http://tokyo.nextblock.io",
];

export const ZERO_SLOT_ENDPOINTS: readonly string[] = [
  "http://de1.0slot.trade",
  "http://ny.0slot.trade",
  "http://ams.0slot.trade",
  "http://jp.0slot.trade",
  "http://la.0slot.trade",
];

export const TEMPORAL_HTTP_ENDPOINTS: readonly string[] = [
  "http://fra2.nozomi.temporal.xyz/?c=",
  "http://ams1.nozomi.temporal.xyz/?c=",
  "http://pit1.nozomi.temporal.xyz/?c=",
  "http://tyo1.nozomi.temporal.xyz/?c=",
  "http://sgp1.nozomi.temporal.xyz/?c=",
  "http://ewr1.nozomi.temporal.xyz/?c=",
];

export const BLOXROUTE_ENDPOINTS: readonly string[] = [
  "http://germany.solana.dex.blxrbdn.com",
  "http://uk.solana.dex.blxrbdn.com",
  "http://amsterdam.solana.dex.blxrbdn.com",
  "http://global.solana.dex.blxrbdn.com",
  "http://tokyo.solana.dex.blxrbdn.com",
  "http://la.solana.dex.blxrbdn.com",
  "http://ny.solana.dex.blxrbdn.com",
];

export const MEV_TIP_ACCOUNTS: Record<MevProviderName, readonly string[]> = {
  jito: [
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  ],
  helius: [
    "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
    "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
    "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
    "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
    "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
    "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
    "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
    "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
    "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
    "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
  ],
  nextblock: [
    "NextbLoCkVtMGcV47JzewQdvBpLqT9TxQFozQkN98pE",
    "NexTbLoCkWykbLuB1NkjXgFWkX9oAtcoagQegygXXA2",
    "NeXTBLoCKs9F1y5PJS9CKrFNNLU1keHW71rfh7KgA1X",
    "NexTBLockJYZ7QD7p2byrUa6df8ndV2WSd8GkbWqfbb",
    "neXtBLock1LeC67jYd1QdAa32kbVeubsfPNTJC1V5At",
    "nEXTBLockYgngeRmRrjDV31mGSekVPqZoMGhQEZtPVG",
    "NEXTbLoCkB51HpLBLojQfpyVAMorm3zzKg7w9NFdqid",
    "nextBLoCkPMgmG8ZgJtABeScP35qLa2AMCNKntAP7Xc",
  ],
  zero_slot: [
    "Eb2KpSC8uMt9GmzyAEm5Eb1AAAgTjRaXWFjKyFXHZxF3",
    "FCjUJZ1qozm1e8romw216qyfQMaaWKxWsuySnumVCCNe",
    "ENxTEjSQ1YabmUpXAdCgevnHQ9MHdLv8tzFiuiYJqa13",
    "6rYLG55Q9RpsPGvqdPNJs4z5WTxJVatMB8zV3WJhs5EK",
    "Cix2bHfqPcKcM233mzxbLk14kSggUUiz2A87fJtGivXr",
  ],
  temporal: [
    "TEMPaMeCRFAS9EKF53Jd6KpHxgL47uWLcpFArU1Fanq",
    "noz3jAjPiHuBPqiSPkkugaJDkJscPuRhYnSpbi8UvC4",
    "noz3str9KXfpKknefHji8L1mPgimezaiUyCHYMDv1GE",
    "noz6uoYCDijhu1V7cutCpwxNiSovEwLdRHPwmgCGDNo",
    "noz9EPNcT7WH6Sou3sr3GGjHQYVkN3DNirpbvDkv9YJ",
    "nozc5yT15LazbLTFVZzoNZCwjh3yUtW86LoUyqsBu4L",
    "nozFrhfnNGoyqwVuwPAW4aaGqempx4PU6g6D9CJMv7Z",
    "nozievPk7HyK1Rqy1MPJwVQ7qQg2QoJGyP71oeDwbsu",
    "noznbgwYnBLDHu8wcQVCEw6kDrXkPdKkydGJGNXGvL7",
    "nozNVWs5N8mgzuD3qigrCG2UoKxZttxzZ85pvAQVrbP",
    "nozpEGbwx4BcGp6pvEdAh1JoC2CQGZdU6HbNP1v2p6P",
    "nozrhjhkCr3zXT3BiT4WCodYCUFeQvcdUkM7MqhKqge",
    "nozrwQtWhEdrA6W8dkbt9gnUaMs52PdAv5byipnadq3",
    "nozUacTVWub3cL4mJmGCYjKZTnE9RbdY5AP46iQgbPJ",
    "nozWCyTPppJjRuw2fpzDhhWbW355fzosWSzrrMYB1Qk",
    "nozWNju6dY353eMkMqURqwQEoM3SFgEKC6psLCSfUne",
    "nozxNBgWohjR75vdspfxR5H9ceC7XXH99xpxhVGt3Bb",
  ],
  bloxroute: [
    "HWEoBxYs7ssKuudEjzjmpfJVX7Dvi7wescFsVx2L5yoY",
    "95cfoy472fcQHaw4tPGBTKpn6ZQnfEPfBgDQx6gcRmRg",
    "3UQUKjhMKaY2S6bjcQD6yHB7utcZt5bfarRCmctpRtUd",
    "FogxVNs6Mm2w9rnGL1vkARSwJxvLE8mujTv3LK8RnUhF",
  ],
};

export interface MevConfig {
  enabled: boolean;
  provider: MevProviderName;
  tip_sol: Decimal;
  tip_lamports: number;
  jito_key: string;
  nextblock_key: string;
  zero_slot_key: string;
  temporal_key: string;
  bloxroute_key: string;
}

export function mevRequiresApiKey(cfg: MevConfig): boolean {
  return MEV_PROVIDERS_REQUIRING_KEYS.has(cfg.provider);
}

export function mevActiveProviderKey(cfg: MevConfig): string | null {
  if (cfg.provider === "jito") {
    const v = cfg.jito_key.trim();
    return v || null;
  }
  if (cfg.provider === "nextblock") {
    const v = cfg.nextblock_key.trim();
    return v || null;
  }
  if (cfg.provider === "zero_slot") {
    const v = cfg.zero_slot_key.trim();
    return v || null;
  }
  if (cfg.provider === "temporal") {
    const v = cfg.temporal_key.trim();
    return v || null;
  }
  if (cfg.provider === "bloxroute") {
    const v = cfg.bloxroute_key.trim();
    return v || null;
  }
  return null;
}

export function normalizeMevProvider(raw: string | null | undefined): MevProviderName {
  const value = String(raw ?? "jito").trim().toLowerCase();
  if (!VALID_MEV_PROVIDERS.has(value)) {
    throw new Error(
      "MEV_PROVIDER must be one of: jito, helius, nextblock, zero_slot, temporal, bloxroute"
    );
  }
  return value as MevProviderName;
}

export function mevTipLamportsFromSol(
  raw: string | Decimal | null | undefined,
  defaultSol = "0.00001"
): { tip_sol: Decimal; tip_lamports: number } {
  const value = raw === null || raw === undefined || raw === "" ? defaultSol : String(raw);
  const tip_sol = new Decimal(value);
  if (!tip_sol.isFinite()) throw new Error("MEV_TIP must be a finite number");
  if (tip_sol.lte(0)) throw new Error("MEV_TIP must be > 0");
  if (tip_sol.gt(1)) throw new Error("MEV_TIP must be <= 1 SOL");
  const lamports = tip_sol.mul(1e9).toDecimalPlaces(0, Decimal.ROUND_CEIL).toNumber();
  if (lamports <= 0) throw new Error("MEV_TIP is too small");
  return { tip_sol, tip_lamports: lamports };
}

export function tipAccountForProvider(provider: MevProviderName): PublicKey {
  const list = MEV_TIP_ACCOUNTS[provider];
  const pick = list[randomInt(list.length)]!;
  return new PublicKey(pick);
}

export function buildMevTipInstruction(
  payer: PublicKey,
  mev_config: MevConfig | null
): TransactionInstruction | null {
  if (mev_config === null || !mev_config.enabled || mev_config.tip_lamports <= 0) return null;
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: tipAccountForProvider(mev_config.provider),
    lamports: mev_config.tip_lamports,
  });
}

export function txSignatureFromVersionedTx(tx: VersionedTransaction): string {
  const sigs = tx.signatures;
  if (!sigs?.length) throw new Error("signed transaction is missing a signature");
  const s = sigs[0];
  if (!s || s.every((b) => b === 0)) throw new Error("signed transaction is missing a signature");
  return bs58.encode(s);
}

/** Base64-serialize signed versioned transaction (matches Python bytes(tx)). */
export function txBase64(tx: VersionedTransaction): string {
  return Buffer.from(tx.serialize()).toString("base64");
}

function truncate(value: string, limit = 240): string {
  const text = String(value ?? "")
    .trim()
    .replace(/\n/g, " ");
  if (text.length <= limit) return text;
  return text.slice(0, limit - 3) + "...";
}

type ProviderRequest = readonly [name: string, url: string, headers: Record<string, string>, payload: object];

function providerRequests(mev_config: MevConfig, b64_tx: string): ProviderRequest[] {
  const contentHeaders = { "Content-Type": "application/json" };

  if (mev_config.provider === "jito") {
    const headers: Record<string, string> = { ...contentHeaders };
    const auth = mevActiveProviderKey(mev_config);
    if (auth) headers["x-jito-auth"] = auth;
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [[b64_tx], { encoding: "base64" }],
    };
    return JITO_BLOCK_ENGINE_ENDPOINTS.map(
      (endpoint) => ["jito", `${endpoint}/bundles`, headers, payload] as const
    );
  }

  if (mev_config.provider === "helius") {
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [
        b64_tx,
        { encoding: "base64", skipPreflight: true, maxRetries: 0 },
      ],
    };
    return HELIUS_SENDER_ENDPOINTS.map(
      (endpoint) => ["helius", `${endpoint}/fast?swqos_only=true`, { ...contentHeaders }, payload] as const
    );
  }

  if (mev_config.provider === "nextblock") {
    const payload = {
      transaction: { content: b64_tx },
      frontRunningProtection: false,
    };
    const headers = {
      ...contentHeaders,
      Authorization: String(mevActiveProviderKey(mev_config) ?? ""),
    };
    return NEXTBLOCK_ENDPOINTS.map(
      (endpoint) => ["nextblock", `${endpoint}/api/v2/submit`, headers, payload] as const
    );
  }

  if (mev_config.provider === "zero_slot") {
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [b64_tx, { encoding: "base64", skipPreflight: true }],
    };
    const key = String(mevActiveProviderKey(mev_config) ?? "");
    return ZERO_SLOT_ENDPOINTS.map(
      (endpoint) => ["zero_slot", `${endpoint}?api-key=${key}`, { ...contentHeaders }, payload] as const
    );
  }

  if (mev_config.provider === "temporal") {
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [b64_tx, { encoding: "base64" }],
    };
    const key = String(mevActiveProviderKey(mev_config) ?? "");
    return TEMPORAL_HTTP_ENDPOINTS.map(
      (endpoint) => ["temporal", `${endpoint}${key}`, { ...contentHeaders }, payload] as const
    );
  }

  const headers = {
    ...contentHeaders,
    Authorization: String(mevActiveProviderKey(mev_config) ?? ""),
  };
  const payload = {
    transaction: { content: b64_tx },
    skipPreFlight: true,
    frontRunningProtection: false,
    submitProtection: "SP_LOW",
    fastBestEffort: false,
    useStakedRPCs: true,
    allowBackRun: false,
    revenueAddress: "",
  };
  return BLOXROUTE_ENDPOINTS.map(
    (endpoint) => ["bloxroute", `${endpoint}/api/v2/submit`, headers, payload] as const
  );
}

async function submitRequest(
  provider_name: string,
  url: string,
  headers: Record<string, string>,
  payload: object
): Promise<readonly [boolean, string]> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const body = await response.text();
    if (!response.ok) {
      return [false, `${provider_name} returned HTTP ${response.status}: ${truncate(body)}`];
    }
    let data: unknown = {};
    try {
      data = body ? JSON.parse(body) : {};
    } catch {
      data = {};
    }
    if (typeof data === "object" && data !== null && "error" in data && (data as { error?: unknown }).error != null) {
      return [false, `${provider_name} returned error: ${truncate(JSON.stringify((data as { error: unknown }).error))}`];
    }
    return [true, provider_name];
  } catch (exc) {
    return [false, `${provider_name} request failed: ${exc}`];
  }
}

export async function submitSignedTransactionViaMev(
  tx: VersionedTransaction,
  mev_config: MevConfig,
  timeout_seconds = 8.0
): Promise<string> {
  if (!mev_config.enabled) throw new Error("MEV is not enabled");
  if (mevRequiresApiKey(mev_config) && mevActiveProviderKey(mev_config) === null) {
    throw new Error(`missing API key for ${mev_config.provider}`);
  }
  const signature = txSignatureFromVersionedTx(tx);
  const b64_tx = txBase64(tx);
  const requests = providerRequests(mev_config, b64_tx);
  void timeout_seconds;
  const results = await Promise.all(
    requests.map(([name, url, headers, payload]) => submitRequest(name, url, headers, payload))
  );

  const errors: string[] = [];
  for (const result of results) {
    const [ok, detail] = result;
    if (ok) return signature;
    errors.push(detail);
  }
  throw new Error(errors.slice(0, 4).join("; ") || "MEV submission failed");
}
