/**
 * Toggle operation implementation.
 */
import { Operation } from "../Operation.js";
import { BooleanParameter, ParameterSet } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";

/**
 * Optional boolean flag with a default value.
 */
class EnabledParameter extends BooleanParameter {
  name = "enabled";
  description = "Enable or disable the feature";
  required = false;
  defaultValue = false;
}

/**
 * Parameter set for the toggle operation.
 */
class ToggleParameterSet extends ParameterSet {
  parameters = [new EnabledParameter()];
}

type ToggleParams = {
  enabled: boolean;
};

/**
 * Operation that prints whether a feature is enabled.
 */
export class ToggleOperation extends Operation<ToggleParams> {
  name = "toggle";
  description = "Print whether the feature is enabled";
  parameters = new ToggleParameterSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  run(params: ToggleParams): void {
    this.logger.verbose(`Toggle status resolved to ${params.enabled}.`);
    this.logger.log(params.enabled ? "enabled" : "disabled");
  }
}
