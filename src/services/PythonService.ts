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

    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status ?? 1,
    };
  }
}
