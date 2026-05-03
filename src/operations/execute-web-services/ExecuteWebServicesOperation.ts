/**
 * ExecuteWebServices
 *
 * Starts a GraphQL HTTP server that exposes every registered operation as a
 * mutation.  The schema is built dynamically from the operation registry so
 * new operations appear automatically without any schema changes here.
 *
 * File parameters (names ending in "-file") accept either:
 *   - a local file path string, or
 *   - a multipart-uploaded file (via the Upload scalar)
 *
 * Example:
 *   ./atscale-utils execute-web-services --port 4000
 *   curl http://localhost:4000/graphql  # GraphQL endpoint
 */
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, NumberParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import type { OperationRegistry } from "../registry.js";
import { startServer } from "./graphql-server.js";

// ──────────────────────────────────────────────────────────────────────────────
// Parameters
// ──────────────────────────────────────────────────────────────────────────────

class ExecuteWebServicesParamsSet extends ParameterSet {
  parameters = [
    new (class extends NumberParameter {
      name        = "port";
      description = "Port the GraphQL server will listen on";
      required    = false;
      defaultValue = 4000;
    })(),
    new (class extends StringParameter {
      name        = "host";
      description = "Host / bind address for the server";
      required    = false;
      defaultValue = "localhost";
    })(),
  ];
}

type Params = {
  port:  number;
  host:  string;
};
export type ExecuteWebServicesParams = Params;

// ──────────────────────────────────────────────────────────────────────────────
// Operation
// ──────────────────────────────────────────────────────────────────────────────

export class ExecuteWebServicesOperation extends Operation<Params> {
  name        = "execute-web-services";
  description = "Start a GraphQL HTTP server that exposes all operations as mutations";
  parameters  = new ExecuteWebServicesParamsSet();

  /**
   * The registry is injected at construction time (from index.ts) so that the
   * server can build its schema from the full operation list without creating a
   * circular module dependency.
   */
  constructor(
    services: ServiceRegistry,
    logger: Logger,
    private readonly registry: OperationRegistry,
  ) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const shutdown = await startServer(
      this.registry,
      params.port,
      params.host,
      this.logger,
    );

    // Block until SIGINT / SIGTERM
    await new Promise<void>((resolve) => {
      const stop = () => {
        this.logger.log("[execute-web-services] Shutting down…");
        shutdown().then(resolve).catch(() => resolve());
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  }
}
