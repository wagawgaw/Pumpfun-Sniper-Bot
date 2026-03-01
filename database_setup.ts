/**
 * Windows PostgreSQL bootstrap lives in Python (`Dexter/database_setup.py`).
 * Port the subprocess/WinGet flow here when you need a pure-TS installer.
 */
export function runWindowsSetup(_args: unknown): number {
  throw new Error(
    "`dexter database-setup` is not implemented in Dexter-ts. Run it from the Python Dexter package, or extend database_setup.ts."
  );
}
