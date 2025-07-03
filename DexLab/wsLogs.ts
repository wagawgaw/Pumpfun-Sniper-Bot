/** Port `DexLab/wsLogs.py` — WebSocket log collector entrypoint. */
export function run(_options?: { mode_override?: string | null; network_override?: string | null }): number {
  console.error(
    "wsLogs collector is not ported to TypeScript yet. Use the Python Dexter package for `dexter collector` / trader wsLogs."
  );
  return 1;
}

export class DexBetterLogs {
  constructor(..._args: unknown[]) {}
}
