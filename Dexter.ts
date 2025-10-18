import { buildProgram, legacyMainAsync } from "./dexter_cli";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "cli") {
    const rest = argv.slice(1);
    if (!rest.length) {
      buildProgram().outputHelp();
      return 0;
    }
    return legacyMainAsync(rest);
  }
  if (!argv.length || argv[0] === "menu" || argv[0] === "interactive") {
    console.error(
      "Interactive Dexter TUI is not implemented in TypeScript. Run: npm run build && node dist/Dexter.js cli <command>"
    );
    return 1;
  }
  return legacyMainAsync(argv);
}

void main().then((code) => process.exit(code));
