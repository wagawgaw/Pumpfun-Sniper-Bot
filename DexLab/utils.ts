/** Port of `DexLab/utils.py` — priority fees & lamport helpers. */
export const DEFAULT_PRIORITY_FEE_CLAMP_COMPUTE_UNITS = 1_000_000;

export async function estimatePriorityFeeMicroLamports(_rpcUrl: string): Promise<bigint> {
  return 0n;
}

export function priorityFeeLamports(_microLamportsPerCu: bigint, _units: bigint): bigint {
  return 0n;
}

export function usdToLamports(_usd: number, _solPrice: number): bigint {
  return 0n;
}

export function lamportsToTokens(_lamports: bigint, _price: number): bigint {
  return 0n;
}

export function usdToMicrolamports(_usd: number, _solPrice: number): bigint {
  return 0n;
}
