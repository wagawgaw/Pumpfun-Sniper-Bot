import * as fs from "fs";
import * as path from "path";

export function configureRootLogging(options: {
  format: string;
  level?: string;
  datefmt?: string | null;
  log_file?: string | null;
  stream?: NodeJS.WritableStream | null;
  force?: boolean;
}): boolean {
  const force = options.force ?? false;
  if (!force && process.env.DEXTER_LOGGING_CONFIGURED === "1") {
    return false;
  }
  process.env.DEXTER_LOGGING_CONFIGURED = "1";

  const stream = options.stream ?? process.stdout;
  const handlers: NodeJS.WritableStream[] = [];
  if (options.log_file) {
    const logPath = path.resolve(options.log_file);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    handlers.push(fs.createWriteStream(logPath, { flags: "a" }));
  }
  if (stream) handlers.push(stream);

  const prefix = `[dexter] `;
  const write = (line: string) => {
    const text = prefix + line + "\n";
    for (const h of handlers) {
      h.write(text);
    }
  };

  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: unknown[]) => {
    write(args.map(String).join(" "));
    origLog.apply(console, args);
  };
  console.error = (...args: unknown[]) => {
    write("ERROR " + args.map(String).join(" "));
    origErr.apply(console, args);
  };

  return true;
}
