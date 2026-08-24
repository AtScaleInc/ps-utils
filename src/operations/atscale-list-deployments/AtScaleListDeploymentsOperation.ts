/**
 * AtScaleListDeployments
 *
 * Lists the deployed catalogs (semantic models) in an AtScale instance
 * and writes the result as JSON to stdout.
 */
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, BooleanParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import {
  AtScaleRestClientService,
} from "../../services/AtScaleRestClientService.js";
import { resolveAtScaleEnv } from "../atscale-env.js";

// ── Parameters ────────────────────────────────────────────────────────────────

class AtScaleListDeploymentsParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name         = "connection-file";
      description  = "Path to the connections YAML file";
      required     = false;
      defaultValue = "connections.yaml";
    })(),
    new (class extends StringParameter {
      name        = "atscale-connection-name";
      description = "Name of the AtScale connection entry in the connections file";
      required    = true;
    })(),
    new (class extends BooleanParameter {
      name         = "insecure";
      description  = "Skip TLS certificate verification (overrides the connections file value). Defaults to true.";
      required     = false;
    })(),
  ];
}

type Params = {
  "connection-file": string;
  "atscale-connection-name": string;
  "insecure"?: boolean;
};
export type AtScaleListDeploymentsParams = Params;

// ── Helpers ───────────────────────────────────────────────────────────────────


// ── Operation ─────────────────────────────────────────────────────────────────

export class AtScaleListDeploymentsOperation extends Operation<Params> {
  name        = "atscale-list-deployments";
  description = "List deployed catalogs (semantic models) in an AtScale instance";
  parameters  = new AtScaleListDeploymentsParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const yaml       = this.services.get<YamlService>("yaml");
    const atScaleSvc = this.services.get<AtScaleRestClientService>("atscale-rest");

    const config = yaml.readFromFile<Record<string, any>>(params["connection-file"]);
    const env    = resolveAtScaleEnv(config, params["atscale-connection-name"], params["insecure"]);

    this.logger.verbose(`[AtScaleListDeployments] Fetching deployments from ${env.baseUrl}`);

    const models = await atScaleSvc.listModels(env);

    process.stdout.write(JSON.stringify(models, null, 2) + "\n");
  }
}
