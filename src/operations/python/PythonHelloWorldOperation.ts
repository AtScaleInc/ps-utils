/**
 * Reference Python operation: greets a name via a Python script.
 */
import path from "path";
import { fileURLToPath } from "url";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import type { PythonService } from "../../services/PythonService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class NameParameter extends StringParameter {
  name = "name";
  description = "Name to greet";
  required = false;
  defaultValue = "World";
}

class PythonHelloWorldParameterSet extends ParameterSet {
  parameters = [new NameParameter()];
}

type PythonHelloWorldParams = {
  name: string;
};

export class PythonHelloWorldOperation extends Operation<PythonHelloWorldParams> {
  name = "python-hello-world";
  description = "Greet a name using a Python script";
  parameters = new PythonHelloWorldParameterSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  run(params: PythonHelloWorldParams): void {
    const python = this.services.get<PythonService>("python");
    const scriptPath = path.join(__dirname, "hello_world.py");
    const result = python.execute(scriptPath, { name: params.name });

    if (result.stdout) {
      this.logger.log(result.stdout.trimEnd());
    }

    if (result.exitCode !== 0) {
      if (result.stderr) {
        this.logger.error(result.stderr.trimEnd());
      }
      throw new Error(`Python script exited with code ${result.exitCode}`);
    }
  }
}
