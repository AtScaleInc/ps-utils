import fs from "fs";

/**
 * Logging interface used by operations.
 */
export type Logger = {
  log: (message: string) => void;
  info: (message: string) => void;
  error: (message: string) => void;
  verbose: (message: string) => void;
};

export type LoggerOptions = {
  logfile?: string;
  output?: string;
  verbose?: boolean;
};

/**
 * Build a logger that can write to stdout, a log file, and an optional output file.
 */
export function buildLogger(options: LoggerOptions): Logger {
  const logStream = options.logfile
    ? fs.createWriteStream(options.logfile, { flags: "a" })
    : null;
  const outputStream = options.output
    ? fs.createWriteStream(options.output, { flags: "w" })
    : null;

  function writeAll(message: string, toStdout: boolean): void {
    const line = message.endsWith("\n") ? message : `${message}\n`;
    if (toStdout) {
      process.stdout.write(line);
    } else {
      process.stderr.write(line);
    }
    if (logStream) {
      logStream.write(line);
    }
    if (outputStream && toStdout) {
      outputStream.write(line);
    }
  }

  return {
    log: (message) => writeAll(message, true),
    info: (message) => writeAll(message, true),
    error: (message) => writeAll(message, false),
    verbose: (message) => {
      if (options.verbose) {
        writeAll(message, true);
      }
    },
  };
}
