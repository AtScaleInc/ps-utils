/**
 * Echo operation implementation.
 */
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";

/**
 * Required message parameter for the echo operation.
 */
class MessageParameter extends StringParameter {
  name = "message";
  description = "Message to echo";
  required = true;
}

/**
 * Parameter set for the echo operation.
 */
class EchoParameterSet extends ParameterSet {
  parameters = [new MessageParameter()];
}

type EchoParams = {
  message: string;
};

/**
 * Operation that prints a message to stdout.
 */
export class EchoOperation extends Operation<EchoParams> {
  name = "echo";
  description = "Echo a message to stdout";
  parameters = new EchoParameterSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  run(params: EchoParams): void {
    this.logger.verbose(`Echoing message (${params.message.length} chars).`);
    this.logger.log(params.message);
  }
}
