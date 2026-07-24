/**
 * CLI runner that resolves operations, validates params, and dispatches execution.
 */
import { buildRegistry } from "./operations/index.js";
import { OPERATION_GROUPS } from "./operations/operation-groups.js";
import type { Operation, OperationParams } from "./operations/Operation.js";
import { globalInputFilter } from "./global-input.js";
import { parse } from "yaml";

/**
 * Extract a human-readable message from an error, stripping Java stack traces.
 * For JVM exceptions the relevant text is on the line matching "SomeException: message";
 * everything indented with "at " is a stack frame and is discarded.
 */
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
    function wrapText(prefix: string, text: string, maxWidth = 80): string[] {
      const indent = " ".repeat(10);
      const words = text.split(/\s+/).filter(Boolean);
      const result: string[] = [];
      let cur = prefix;
      let first = true;
      for (const word of words) {
        if (first) {
          cur += word;
          first = false;
        } else if (cur.length + 1 + word.length <= maxWidth) {
          cur += " " + word;
        } else {
          result.push(cur);
          cur = indent + word;
        }
      }
      if (!first) result.push(cur);
      return result;
    }
    const lines = [
      "Usage:",
      "  atscale-utils <operation> --key value [--key value]",
      "  cat input.yml | atscale-utils",
      "",
      "Installation:",
      "  sudo npm install -g @atscale/ps-utils",
      "",
      "Shell completions:",
      "  atscale-utils --completion bash    Install bash completions (~/.bash_completion.d/atscale-utils)",
      "  atscale-utils --completion zsh     Install zsh completions  (~/.zsh/completions/_atscale-utils)",
      "  atscale-utils --completion fish    Install fish completions (~/.config/fish/completions/atscale-utils.fish)",
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
      ...(() => {
        const opMap = new Map(operationList.map((op) => [op.name, op]));
        const listed = new Set<string>();
        const output: string[] = [];
        for (const { name: groupName, operations: names } of OPERATION_GROUPS) {
          output.push(`  ${groupName}:`);
          for (const name of names) {
            const op = opMap.get(name);
            if (op) {
              output.push(...wrapText(`    ${op.name}: `, op.description));
              listed.add(name);
            }
          }
        }
        const other = operationList.filter((op) => !listed.has(op.name));
        if (other.length > 0) {
          output.push("  Other:");
          for (const op of other) {
            output.push(...wrapText(`    ${op.name}: `, op.description));
          }
        }
        return output;
      })(),
    ];
    console.log(lines.join("\n"));
  }

  /**
   * Print operation-specific usage and parameters.
   */
  function printOperationHelp(operation: Operation<Record<string, unknown>>): void {
    const lines = [
      "Usage:",
      `  atscale-utils ${operation.name} --key value [--key value]`,
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
   * knownKeys distinguishes "unknown parameter" from "missing value".
   * flagKeys are parameters that may be passed without a value (implies true).
   */
  function parseParams(args: string[], knownKeys?: Set<string>, flagKeys?: Set<string>): OperationParams {
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
      const nextValue = args[i + 1];
      if (!key || nextValue === undefined || nextValue === null || nextValue.startsWith("--")) {
        if (knownKeys && !knownKeys.has(key)) {
          throw new Error(`Unknown parameter: --${key}`);
        }
        if (flagKeys && flagKeys.has(key)) {
          params[key] = "true";
          continue;
        }
        throw new Error(`Missing value for parameter: --${key}`);
      }
      // Collect all consecutive non-flag tokens as the value (comma-joined).
      // This allows shell glob expansion to produce multiple space-separated paths
      // that are then treated as a comma-separated list by the receiving operation.
      const values: string[] = [nextValue];
      i += 1;
      while (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        i += 1;
        values.push(args[i]);
      }
      params[key] = values.join(",");
    }
    return params;
  }

  const operationName = argv[0];
  if (operationName === "--version" || operationName === "-v") {
    const versionOp = baseRegistry.get("version");
    if (versionOp) await versionOp.run({});
    return 0;
  }

  if (!operationName) {
    if (stdinData && stdinData.trim().length > 0) {
      let stdinOperation: Operation<Record<string, unknown>> | undefined;
      try {
        const input = parseStdinInput(stdinData);
        const opRegistry = await buildRegistry(globalInputFilter({}).logger);
        stdinOperation = opRegistry.get(input.operation);
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
        if (stdinOperation) {
          printOperationHelp(stdinOperation);
        } else {
          printUsage();
        }
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

  // Show per-operation help when invoked with no arguments, but only when the
  // operation has at least one required parameter (otherwise just run it with defaults).
  const hasRequiredParams = operation.parameters.parameters.some(
    (p) => p.required && p.defaultValue === undefined,
  );
  if (argv.length === 1 && hasRequiredParams) {
    printOperationHelp(operation);
    return 0;
  }

  let params: Record<string, unknown>;
  let resolvedOperation: Operation<Record<string, unknown>>;
  try {
    const knownKeys = new Set([
      ...operation.parameters.parameters.map((p) => p.name),
      "logfile", "output", "verbose",
    ]);
    const flagKeys = new Set([
      ...operation.parameters.parameters.filter((p) => p.isFlag).map((p) => p.name),
      "verbose",
    ]);
    const rawParams = parseParams(argv.slice(1), knownKeys, flagKeys);
    const { params: filteredParams, logger } = globalInputFilter(rawParams);
    const opRegistry = await buildRegistry(logger);
    resolvedOperation = opRegistry.get(operationName)!;
    params = resolvedOperation.parseParams(filteredParams);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    printOperationHelp(operation);
    return 1;
  }

  try {
    await resolvedOperation.run(params);
    return 0;
  } catch (error) {
    console.error(formatError(error));
    return 1;
  }
}
