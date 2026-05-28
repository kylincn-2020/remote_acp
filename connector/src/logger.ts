import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname, resolve } from "node:path";

export type LogLevel = "error" | "warn" | "info" | "debug";

export type LoggerOptions = {
  level?: LogLevel;
  file?: string;
  console?: boolean;
};

export type Logger = {
  level: LogLevel;
  file: string;
  error(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  debug(message: string, meta?: unknown): void;
  child(scope: string): Logger;
  close(): Promise<void>;
};

const logPriority: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const file = resolve(options.file ?? "logs/connector.log");
  const writeToConsole = options.console ?? true;
  mkdirSync(dirname(file), { recursive: true });
  const stream = createWriteStream(file, { flags: "a", encoding: "utf8" });
  return createScopedLogger({
    level,
    file,
    stream,
    scope: "connector",
    writeToConsole,
    ownsStream: true,
  });
}

export function parseLogLevel(value: unknown): LogLevel | undefined {
  if (value === "error" || value === "warn" || value === "info" || value === "debug") {
    return value;
  }
  return undefined;
}

type ScopedLoggerOptions = {
  level: LogLevel;
  file: string;
  stream: WriteStream;
  scope: string;
  writeToConsole: boolean;
  ownsStream: boolean;
};

function createScopedLogger(options: ScopedLoggerOptions): Logger {
  const write = (level: LogLevel, message: string, meta?: unknown) => {
    if (logPriority[level] > logPriority[options.level]) {
      return;
    }

    const line = formatLogLine(level, options.scope, message, meta);
    options.stream.write(`${line}\n`);
    if (options.writeToConsole) {
      const output = level === "error" || level === "warn" ? console.error : console.log;
      output(line);
    }
  };

  return {
    level: options.level,
    file: options.file,
    error: (message, meta) => write("error", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    info: (message, meta) => write("info", message, meta),
    debug: (message, meta) => write("debug", message, meta),
    child(scope) {
      return createScopedLogger({
        ...options,
        scope: `${options.scope}:${scope}`,
        ownsStream: false,
      });
    },
    close() {
      if (!options.ownsStream) {
        return Promise.resolve();
      }
      return new Promise((resolveClose) => {
        options.stream.end(resolveClose);
      });
    },
  };
}

function formatLogLine(level: LogLevel, scope: string, message: string, meta?: unknown) {
  const base = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${message}`;
  if (meta === undefined) {
    return base;
  }
  return `${base} ${formatMeta(meta)}`;
}

function formatMeta(meta: unknown) {
  if (meta instanceof Error) {
    return JSON.stringify({
      name: meta.name,
      message: meta.message,
      stack: meta.stack,
    });
  }
  if (typeof meta === "string") {
    return meta;
  }
  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}
