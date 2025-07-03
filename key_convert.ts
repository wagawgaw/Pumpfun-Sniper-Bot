import * as fs from "fs";
import * as path from "path";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

const keypairJsonPath = path.resolve(process.cwd(), "keypair.json");
if (!fs.existsSync(keypairJsonPath)) {
  console.error("Error: keypair.json not found in the current directory.");
  process.exit(1);
}
const keypairData = JSON.parse(fs.readFileSync(keypairJsonPath, "utf-8")) as number[];
const secretKeyBytes = Uint8Array.from(keypairData);
const keypair = Keypair.fromSecretKey(secretKeyBytes);
const privateKeyBase58 = bs58.encode(secretKeyBytes);
const publicKeyBase58 = keypair.publicKey.toBase58();
console.log("Base58 Private Key:", privateKeyBase58);
console.log("Public Key:", publicKeyBase58);
