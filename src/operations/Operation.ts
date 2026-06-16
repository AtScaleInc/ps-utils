import type { ParameterSet } from "../Parameters.js";
import type { ServiceRegistry } from "../services/registry.js";
import type { Logger } from "../logging.js";

/**
 * Raw CLI parameters before type parsing.
 */
export type OperationParams = Record<string, string>;

/**
 * Base class for a runnable operation.
 * Operations declare parameters and use services via DI.
 */
export abstract class Operation<TParams extends Record<string, unknown>> {
  abstract name: string;
  abstract description: string;
  abstract parameters: ParameterSet;

  protected services: ServiceRegistry;
  protected logger: Logger;

  constructor(services: ServiceRegistry, logger: Logger) {
    this.services = services;
    this.logger = logger;
  }

  /**
   * Execute the operation with parsed parameters.
   */
  abstract run(params: TParams): Promise<void> | void;

  /**
   * Parse raw string arguments into typed parameters.
   */
  parseParams(raw: OperationParams): TParams {
    return this.parameters.parse(raw) as TParams;
  }
}
