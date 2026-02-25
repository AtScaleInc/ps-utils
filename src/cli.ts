#!/usr/bin/env node
import { runCli } from "./cli-runner.js";

/**
 * CLI entrypoint. Delegates execution to the shared runner.
 */
async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    return undefined;
  }

  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", (error) => reject(error));
  });
}

readStdin()
  .then((stdinData) => runCli(process.argv.slice(2), stdinData))
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
