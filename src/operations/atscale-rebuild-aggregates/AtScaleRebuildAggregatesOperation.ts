/**
 * AtScaleRebuildAggregates
 *
 * Triggers a full (default) or incremental aggregate rebuild for a given
 * catalog/model (project/cube) in AtScale, and writes the raw rebuild-trigger
 * response as JSON to stdout.
 */
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, BooleanParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import { AtScaleRestClientService } from "../../services/AtScaleRestClientService.js";
import { resolveAtScaleEnv } from "../atscale-env.js";

// ── Parameters ────────────────────────────────────────────────────────────────

class AtScaleRebuildAggregatesParamsSet extends ParameterSet {
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
    new (class extends StringParameter {
      name        = "catalog-id";
      description = "Catalog (project) UUID, from atscale-list-deployments";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "model-id";
      description = "Model (cube) UUID, from atscale-list-deployments";
      required    = true;
    })(),
    new (class extends BooleanParameter {
      name         = "full-build";
      description  = "Trigger a full build when true, or an incremental build when false. Defaults to true.";
      required     = false;
      defaultValue = true;
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
  "catalog-id": string;
  "model-id": string;
  "full-build": boolean;
  "insecure"?: boolean;
};
export type AtScaleRebuildAggregatesParams = Params;

// ── Operation ─────────────────────────────────────────────────────────────────

export class AtScaleRebuildAggregatesOperation extends Operation<Params> {
  name        = "atscale-rebuild-aggregates";
  description = "Trigger a full or incremental aggregate rebuild for a catalog/model";
  parameters  = new AtScaleRebuildAggregatesParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const yaml       = this.services.get<YamlService>("yaml");
    const atScaleSvc = this.services.get<AtScaleRestClientService>("atscale-rest");

    const config = yaml.readFromFile<Record<string, any>>(params["connection-file"]);
    const env    = resolveAtScaleEnv(config, params["atscale-connection-name"], params["insecure"]);

    this.logger.verbose(
      `[AtScaleRebuildAggregates] Triggering ${params["full-build"] ? "full" : "incremental"} rebuild ` +
      `for catalog=${params["catalog-id"]} model=${params["model-id"]}`,
    );

    const result = await atScaleSvc.rebuildAggregates(env, {
      catalogId:   params["catalog-id"],
      modelId:     params["model-id"],
      isFullBuild: params["full-build"],
    });

    this.logger.log(`Rebuild triggered for catalog=${params["catalog-id"]} model=${params["model-id"]}`);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
}
