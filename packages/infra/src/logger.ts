export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, string | number | boolean | null>;

export interface Logger {
  child(fields: LogFields): Logger;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export type LogSink = (line: string) => void;

export function createLogger(
  base: LogFields = {},
  sink: LogSink = defaultSink,
): Logger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    sink(
      JSON.stringify({
        level,
        msg,
        ts: new Date().toISOString(),
        ...base,
        ...fields,
      }),
    );
  };

  return {
    child(fields) {
      return createLogger({ ...base, ...fields }, sink);
    },
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
}

function defaultSink(line: string): void {
  // Workers runtime captures stdout; structured JSON only.
  // eslint-disable-next-line no-console -- sink boundary for Logger adapter
  console.log(line);
}
