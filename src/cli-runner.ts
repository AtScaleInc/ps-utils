import { buildRegistry } from "./operations/index.js";
import type { Operation, OperationParams } from "./operations/Operation.js";
import { globalInputFilter } from "./global-input.js";
import { parse } from "yaml";

/**
 * Execute the CLI with the given argv arguments and return an exit code.
 */
type StdinInput = {
  operation: string;
  parameters?: Record<string, unknown>;
};

function parseStdinInput(raw: string): StdinInput {
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse YAML from stdin: ${message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("YAML stdin input must be an object.");
  }

  const obj = parsed as Record<string, unknown>;
  const operation = obj.operation;
  if (typeof operation !== "string" || operation.trim().length === 0) {
    throw new Error("YAML stdin input must include a non-empty 'operation' field.");
  }

  const parameters = obj.parameters;
  if (parameters !== undefined) {
    if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) {
      throw new Error("YAML stdin 'parameters' must be an object.");
    }
  }

  return {
    operation,
    parameters: parameters as Record<string, unknown> | undefined,
  };
}

function coerceParamsToStrings(parameters: Record<string, unknown> | undefined): OperationParams {
  if (!parameters) {
    return {};
  }
  const result: OperationParams = {};
  for (const [key, value] of Object.entries(parameters)) {
    if (value === undefined || value === null) {
      continue;
    }
    result[key] = String(value);
  }
  return result;
}

export async function runCli(argv: string[], stdinData?: string): Promise<number> {
  if (argv.length > 0 && stdinData && stdinData.trim().length > 0) {
    console.error("Provide either CLI arguments or YAML on stdin, not both.");
    return 1;
  }

  const baseRegistry = await buildRegistry(globalInputFilter({}).logger);
  const operationList: Operation<Record<string, unknown>>[] = baseRegistry.list();

  /**
   * Print usage and available operations.
   */
  function printUsage(): void {
    const lines = [
      "Usage:",
      "  operation-cli <operation> --key value [--key value]",
      "  cat input.yml | operation-cli",
      "  atscale-utils --completion {bash|zsh|fish}",
      "",
      "Global parameters:",
      "  --logfile <path>   Path to the output log file.",
      "  --output <path>    Path to the output file or empty for stdout.",
      "  --verbose <bool>   Flag set to use verbose logging.",
      "",
      "Stdin YAML format:",
      "  operation: <operation-name>",
      "  parameters:",
      "    key: value",
      "",
      "Available operations:",
      ...operationList.map((op) => `  ${op.name}: ${op.description}`),
    ];
    console.log(lines.join("\n"));
  }

  /**
   * Print operation-specific usage and parameters.
   */
  function printOperationHelp(operation: Operation<Record<string, unknown>>): void {
    const lines = [
      "Usage:",
      `  operation-cli ${operation.name} --key value [--key value]`,
      "",
      "Global parameters:",
      "  --logfile <path>   Path to the output log file.",
      "  --output <path>    Path to the output file or empty for stdout.",
      "  --verbose <bool>   Flag set to use verbose logging.",
      "",
      "Operation parameters:",
    ];

    for (const param of operation.parameters.parameters) {
      const requiredLabel = param.required ? "required" : "optional";
      lines.push(`  --${param.name} (${requiredLabel}) ${param.description}`);
    }

    console.log(lines.join("\n"));
  }

  /**
   * Parse `--key value` or `--key=value` arguments into a map.
   */
  function parseParams(args: string[]): OperationParams {
    const params: OperationParams = {};
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (!arg.startsWith("--")) {
        continue;
      }
      const withoutPrefix = arg.slice(2);
      const eqIndex = withoutPrefix.indexOf("=");
      if (eqIndex !== -1) {
        const key = withoutPrefix.slice(0, eqIndex).trim();
        const value = withoutPrefix.slice(eqIndex + 1).trim();
        if (!key || !value) {
          throw new Error(`Invalid parameter syntax: ${arg}`);
        }
        params[key] = value;
        continue;
      }

      const key = withoutPrefix.trim();
      const value = args[i + 1];
      if (!key || !value || value.startsWith("--")) {
        throw new Error(`Missing value for parameter: --${key}`);
      }
      params[key] = value;
      i += 1;
    }
    return params;
  }

  const operationName = argv[0];
  if (!operationName) {
    if (stdinData && stdinData.trim().length > 0) {
      try {
        const input = parseStdinInput(stdinData);
        const opRegistry = await buildRegistry(globalInputFilter({}).logger);
        const stdinOperation = opRegistry.get(input.operation);
        if (!stdinOperation) {
          throw new Error(`Unknown operation: ${input.operation}`);
        }

        const rawParams = coerceParamsToStrings(input.parameters);
        const { params: filteredParams, logger } = globalInputFilter(rawParams);
        const resolvedRegistry = await buildRegistry(logger);
        const resolvedOperation = resolvedRegistry.get(input.operation);
        if (!resolvedOperation) {
          throw new Error(`Unknown operation: ${input.operation}`);
        }

        const params = resolvedOperation.parseParams(filteredParams);
        await resolvedOperation.run(params);
        return 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(message);
        printUsage();
        return 1;
      }
    }

    printUsage();
    return 1;
  }

  const operation = baseRegistry.get(operationName);
  if (!operation) {
    console.error(`Unknown operation: ${operationName}`);
    printUsage();
    return 1;
  }

  if (argv.length === 1) {
    printOperationHelp(operation);
    return 0;
  }

  try {
    const rawParams = parseParams(argv.slice(1));
    const { params: filteredParams, logger } = globalInputFilter(rawParams);
    const opRegistry = await buildRegistry(logger);
    const resolvedOperation = opRegistry.get(operationName);
    if (!resolvedOperation) {
      throw new Error(`Unknown operation: ${operationName}`);
    }
    const params = resolvedOperation.parseParams(filteredParams);
    await resolvedOperation.run(params);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    printUsage();
    return 1;
  }
}
