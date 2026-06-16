import { runCli } from "./cli-runner.js";

/**
 * Convert a JSON object string into CLI `--key value` args.
 */
function toArgList(parameters: string | undefined): string[] {
  if (!parameters || parameters.trim().length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(parameters);
  } catch {
    throw new Error(
      "Action input 'parameters' must be a JSON object string, e.g. {\"message\":\"hello\"}."
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Action input 'parameters' must be a JSON object.");
  }

  const args: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined || value === null) {
      continue;
    }
    const valueString = String(value);
    args.push(`--${key}`, valueString);
  }
  return args;
}

/**
 * GitHub Action entrypoint that maps inputs to CLI invocation.
 */
async function main(): Promise<void> {
  const operation = process.env.INPUT_OPERATION;
  if (!operation) {
    throw new Error("Action input 'operation' is required.");
  }

  const parameters = process.env.INPUT_PARAMETERS;
  const args = [operation, ...toArgList(parameters)];
  const exitCode = await runCli(args);
  process.exitCode = exitCode;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
