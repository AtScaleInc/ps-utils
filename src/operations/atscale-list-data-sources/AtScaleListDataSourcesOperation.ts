/**
 * AtScaleListDataSources
 *
 * Lists the data sources (data warehouses) registered in an AtScale instance
 * and writes the result as JSON to stdout.
 *
 * The connection file is expected to contain an `atscale` block under the
 * named connection entry, e.g.:
 *
 *   connections:
 *     my-atscale:
 *       atscale:
 *         url: https://atscale.example.com
 *         user: admin                   # key into the top-level users block
 *         # or inline:
 *         # username: admin
 *         # password: secret
 *
 *   users:
 *     admin:
 *       username: admin
 *       password: secret
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

class AtScaleListDataSourcesParamsSet extends ParameterSet {
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
export type AtScaleListDataSourcesParams = Params;

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Operation ─────────────────────────────────────────────────────────────────

export class AtScaleListDataSourcesOperation extends Operation<Params> {
  name        = "atscale-list-data-sources";
  description = "List data sources (data warehouses) registered in an AtScale instance";
  parameters  = new AtScaleListDataSourcesParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const yaml       = this.services.get<YamlService>("yaml");
    const atScaleSvc = this.services.get<AtScaleRestClientService>("atscale-rest");

    const config = yaml.readFromFile<Record<string, any>>(params["connection-file"]);
    const env    = resolveAtScaleEnv(config, params["atscale-connection-name"], params["insecure"]);

    this.logger.verbose(`[AtScaleListDataSources] Fetching data sources from ${env.baseUrl}`);

    const dataSources = await atScaleSvc.listDataSources(env);

    process.stdout.write(JSON.stringify(dataSources, null, 2) + "\n");
  }
}
