/**
 * Shared base types for operations that render templates from YAML inputs.
 */
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";

export type TemplateOperationParams = {
  namespace: string;
  "connection-file"?: string;
  "model-file"?: string;
  "target-file"?: string;
};

/**
 * Base parameter set for template-based operations.
 */
export abstract class TemplateParameterSet extends ParameterSet {
  protected baseParameters() {
    return [
      new (class extends StringParameter {
        name = "namespace";
        description = "The namespace to generate";
        required = true;
      })(),
      new (class extends StringParameter {
        name = "model-file";
        description = "The file where the models are defined";
        required = false;
        defaultValue = "model.yaml";
      })(),
      new (class extends StringParameter {
        name = "connection-file";
        description = "The file where the connections are defined";
        required = false;
        defaultValue = "connections.yaml";
      })(),
      new (class extends StringParameter {
        name = "target-file";
        description = "Target file to output the workbook";
        required = false;
        defaultValue = "output.txt";
      })(),
    ];
  }
}

/**
 * Base operation for template-based generators.
 */
export abstract class TemplateOperation<TParams extends TemplateOperationParams> extends Operation<TParams> {
  abstract name: string;
  abstract description: string;
  abstract parameters: TemplateParameterSet;

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }
}
