import bs58 from "bs58";

function readU64(buf: Buffer, off: number): bigint {
  return buf.readBigUInt64LE(off);
}

function readI64(buf: Buffer, off: number): bigint {
  return buf.readBigInt64LE(off);
}

function readBool(buf: Buffer, off: number): boolean {
  return buf.readUInt8(off) !== 0;
}

function readPubkey(buf: Buffer, off: number): string {
  return bs58.encode(buf.subarray(off, off + 32));
}

function readBorshString(buf: Buffer, off: number): { value: string; next: number } {
  const len = buf.readUInt32LE(off);
  const start = off + 4;
  const value = buf.subarray(start, start + len).toString("utf-8");
  return { value, next: start + len };
}

export class Interpreters {
  parsePumpfunTransaction(b64_data: string): Record<string, unknown> | null {
    try {
      const data = Buffer.from(b64_data, "base64");
      let o = 8;
      const mint = readPubkey(data, o);
      o += 32;
      const sol_amount = readU64(data, o);
      o += 8;
      const token_amount = readU64(data, o);
      o += 8;
      const is_buy = readBool(data, o);
      o += 1;
      const user = readPubkey(data, o);
      o += 32;
      const timestamp = readI64(data, o);
      o += 8;
      const virtual_sol_reserves = readU64(data, o);
      o += 8;
      const virtual_token_reserves = readU64(data, o);
      return {
        mint,
        user,
        sol_amount: sol_amount.toString(),
        token_amount: token_amount.toString(),
        is_buy,
        timestamp: Number(timestamp),
        virtual_sol_reserves: virtual_sol_reserves.toString(),
        virtual_token_reserves: virtual_token_reserves.toString(),
      };
    } catch {
      return null;
    }
  }

  parsePumpfunCreation(b64_data: string): Record<string, unknown> | null {
    try {
      const data = Buffer.from(b64_data, "base64");
      let o = 8;
      const n = readBorshString(data, o);
      o = n.next;
      const s = readBorshString(data, o);
      o = s.next;
      const u = readBorshString(data, o);
      o = u.next;
      const mint = readPubkey(data, o);
      o += 32;
      const bonding_curve = readPubkey(data, o);
      o += 32;
      const user = readPubkey(data, o);
      return {
        name: n.value,
        symbol: s.value,
        uri: u.value,
        mint,
        bonding_curve,
        user,
      };
    } catch {
      return null;
    }
  }
}
