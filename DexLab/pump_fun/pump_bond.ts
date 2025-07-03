import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

const DISCRIMINATOR = Buffer.allocUnsafe(8);
DISCRIMINATOR.writeBigUInt64LE(6966180631402821399n, 0);

export class BondingCurveState {
  virtual_token_reserves!: bigint;
  virtual_sol_reserves!: bigint;
  real_token_reserves!: bigint;
  real_sol_reserves!: bigint;
  token_total_supply!: bigint;
  complete!: boolean;
  creator!: Buffer;
  is_mayhem_mode = false;
  is_cashback_coin = false;

  constructor(data: Buffer) {
    const body = data.subarray(8);
    let o = 0;
    this.virtual_token_reserves = body.readBigUInt64LE(o);
    o += 8;
    this.virtual_sol_reserves = body.readBigUInt64LE(o);
    o += 8;
    this.real_token_reserves = body.readBigUInt64LE(o);
    o += 8;
    this.real_sol_reserves = body.readBigUInt64LE(o);
    o += 8;
    this.token_total_supply = body.readBigUInt64LE(o);
    o += 8;
    this.complete = body.readUInt8(o) !== 0;
    o += 1;
    this.creator = Buffer.from(body.subarray(o, o + 32));
    o += 32;
    const trailing = body.subarray(o);
    if (trailing.length >= 1) this.is_mayhem_mode = trailing.readUInt8(0) !== 0;
    if (trailing.length >= 2) this.is_cashback_coin = trailing.readUInt8(1) !== 0;
  }
}

export function getAssociatedBondingCurveAddress(
  mint: PublicKey,
  programId = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBytes()], programId);
}

export async function getBondingCurveState(
  conn: Connection,
  curveAddress: PublicKey
): Promise<BondingCurveState | null> {
  try {
    const response = await conn.getAccountInfo(curveAddress, { commitment: "processed" });
    if (!response?.data) throw new Error("Invalid curve state: No data");
    const data = Buffer.from(response.data);
    if (!data.subarray(0, 8).equals(DISCRIMINATOR)) throw new Error("Invalid curve state discriminator");
    return new BondingCurveState(data);
  } catch {
    return null;
  }
}

export async function getCreator(conn: Connection, bonding_curve: string): Promise<string | false> {
  const bc_state = await getBondingCurveState(conn, new PublicKey(bonding_curve));
  if (!bc_state) return false;
  return bs58.encode(bc_state.creator);
}

export async function checkHasMigrated(conn: Connection, bc: PublicKey): Promise<boolean> {
  const bc_state = await getBondingCurveState(conn, bc);
  if (!bc_state) return false;
  return bc_state.complete;
}
