export async function runMigrationHarness(_options: {
  config: unknown;
  as_json?: boolean;
}): Promise<number> {
  throw new Error(
    "verify-migration harness is not ported to TypeScript yet. Use the Python Dexter CLI (`dexter verify-migration`)."
  );
}
