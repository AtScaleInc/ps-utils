/**
 * AtScaleExportAggregates
 *
 * Exports a catalog/model's System-Defined aggregate definitions from AtScale
 * (GET /v1/aggregates/export/catalogs/{catalogId}/models/{modelId}) and writes
 * the raw JSON payload to a file, unmodified.
 *
 * This is the first half of the manual cross-environment aggregate promotion
 * workflow documented at https://documentation.atscale.com/container-api/export
 * and https://documentation.atscale.com/container-api/import: export from a
 * source (e.g. dev) catalog/model, hand-edit the resulting JSON file if the
 * target (e.g. prod) catalog/model has different names/IDs or connections,
 * then feed it to atscale-import-aggregates against the target instance.
 *
 * User-Defined Aggregates (UDAs) are not included in the export — this is an
 * AtScale API limitation, not a limitation of this operation.
 */
import fs from "fs";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, BooleanParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import { AtScaleRestClientService } from "../../services/AtScaleRestClientService.js";
import { resolveAtScaleEnv } from "../atscale-env.js";
import { resolveCatalogAndModel } from "../atscale-aggregate-shared.js";

// ── Parameters ────────────────────────────────────────────────────────────────

class AtScaleExportAggregatesParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name         = "connection-file";
      description  = "Path to the connections YAML file";
      required     = false;
      defaultValue = "connections.yaml";
    })(),
    new (class extends StringParameter {
      name        = "atscale-connection-name";
      description = "Name of the AtScale connection entry (the source instance/environment to export from) in the connections file";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "catalog-id";
      description = "Catalog (project) UUID to export from, from atscale-list-deployments. When omitted (with --model-id), the deployed catalogs/models are listed and — in an interactive terminal — you're prompted to pick one; in a non-interactive session, an error lists the available options.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "model-id";
      description = "Model (cube) UUID to export from, from atscale-list-deployments. See --catalog-id for behavior when omitted.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "output-file";
      description = "Path to write the export JSON to. Defaults to aggregates-export-<catalog-id>-<model-id>.json in the current directory.";
      required    = false;
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
  "catalog-id"?: string;
  "model-id"?: string;
  "output-file"?: string;
  "insecure"?: boolean;
};
export type AtScaleExportAggregatesParams = Params;

// ── Operation ─────────────────────────────────────────────────────────────────

export class AtScaleExportAggregatesOperation extends Operation<Params> {
  name        = "atscale-export-aggregates";
  description = "Export a catalog/model's aggregate definitions to a JSON file";
  parameters  = new AtScaleExportAggregatesParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const yaml       = this.services.get<YamlService>("yaml");
    const atScaleSvc = this.services.get<AtScaleRestClientService>("atscale-rest");

    const config = yaml.readFromFile<Record<string, any>>(params["connection-file"]);
    const env    = resolveAtScaleEnv(config, params["atscale-connection-name"], params["insecure"]);

    const { catalogId, modelId } = await resolveCatalogAndModel(atScaleSvc, env, params, this.logger);
    this.logger.verbose(`[AtScaleExportAggregates] Exporting aggregates for catalog=${catalogId} model=${modelId}`);

    const result = await atScaleSvc.exportAggregates(env, { catalogId, modelId });

    const outputFile = params["output-file"] ?? `aggregates-export-${catalogId}-${modelId}.json`;
    fs.writeFileSync(outputFile, JSON.stringify(result, null, 2) + "\n", "utf8");

    const aggregateCount = (result as any)?.aggregates?.count ?? (result as any)?.aggregates?.values?.length ?? 0;
    this.logger.log(`[AtScaleExportAggregates] Wrote ${aggregateCount} aggregate definition(s) to ${outputFile}`);
    this.logger.log(
      "Edit this file if importing into a different catalog/model/connection (see atscale-import-aggregates), " +
      "then run atscale-import-aggregates against the target instance.",
    );

    process.stdout.write(JSON.stringify({ catalogId, modelId, outputFile, aggregateCount }, null, 2) + "\n");
  }
}
