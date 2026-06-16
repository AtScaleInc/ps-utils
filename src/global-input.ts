import { buildLogger, type Logger, type LoggerOptions } from "./logging.js";
import type { OperationParams } from "./operations/Operation.js";

/**
 * Result of parsing global inputs and building a logger.
 */
export type GlobalInputResult = {
  params: OperationParams;
  logger: Logger;
};

const GLOBAL_KEYS = new Set(["logfile", "output", "verbose"]);

function parseVerbose(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new Error("verbose must be true/false or 1/0.");
}

/**
 * Extract global inputs and build a logger for all operations.
 */
export function globalInputFilter(raw: OperationParams): GlobalInputResult {
  const options: LoggerOptions = {
    logfile: raw.logfile,
    output: raw.output,
    verbose: parseVerbose(raw.verbose),
  };

  const params: OperationParams = {};
  for (const [key, value] of Object.entries(raw)) {
    if (GLOBAL_KEYS.has(key)) {
      continue;
    }
    params[key] = value;
  }

  return { params, logger: buildLogger(options) };
}
