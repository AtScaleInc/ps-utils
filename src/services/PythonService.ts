/**
 * Service for executing Python scripts with key-value parameters.
 */
import { spawnSync } from "child_process";
import { ServiceProvider } from "./ServiceProvider.js";

export type PythonResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export class PythonService extends ServiceProvider {
  name = "python";

  /**
   * Execute a Python script with the given parameters.
   * Converts { key: value } to --key value CLI args.
   */
  execute(scriptPath: string, params: Record<string, string>): PythonResult {
    const args: string[] = [scriptPath];
    for (const [key, value] of Object.entries(params)) {
      args.push(`--${key}`, value);
    }

    const result = spawnSync("python3", args, { encoding: "utf8" });

    // spawnSync sets result.error when the process could not be spawned at all
    // (e.g. python3 not found).  Surface that so callers see a useful message.
    const spawnError = result.error ? `\n${result.error.message}` : "";

    return {
      stdout: result.stdout ?? "",
      stderr: (result.stderr ?? "") + spawnError,
      exitCode: result.status ?? 1,
    };
  }
}
