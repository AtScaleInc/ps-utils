import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { SQLOperation } from "./SQLOperation.js";

/**
 * Concrete SQL operation that prints connection metadata.
 */
export class EchoConnectionMetaDataOperation extends SQLOperation {
  name = "echo-connection-metadata";
  description = "Print schemas, tables, columns, and foreign keys for a connection";

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }
}
