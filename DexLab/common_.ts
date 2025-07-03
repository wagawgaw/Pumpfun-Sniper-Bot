import { loadConfig, loadEnvFile } from "../dexter_config";

loadEnvFile();
const _APP_CONFIG = loadConfig();

export const HTTP_URL = _APP_CONFIG.rpc.http_url;
export const WS_URL = _APP_CONFIG.rpc.ws_url;
export const PRIV_KEY = _APP_CONFIG.rpc.private_key;

export const PUMP_FUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_SWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SOL_ADDRESS = "So11111111111111111111111111111111111111112";
export const STAKED_API = HTTP_URL;
export const RPC_URL = HTTP_URL;
