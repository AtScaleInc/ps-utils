#!/usr/bin/env node
import { runCli } from "./cli-runner.js";

/**
 * CLI entrypoint. Delegates execution to the shared runner.
 */
async function readStdin(): Promise<string | undefined> {
  // YAML on stdin is only meaningful when no operation was named on the
  // command line. Reading stdin unconditionally made every shell loop that
  // pipes a list into a `while read` body hang or fail, because the first
  // invocation swallowed the rest of the list as "YAML".
  if (process.stdin.isTTY || process.argv.length > 2) {
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
