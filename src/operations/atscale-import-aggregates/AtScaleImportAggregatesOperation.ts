/**
 * AtScaleImportAggregates
 *
 * Imports aggregate definitions (typically produced by
 * atscale-export-aggregates, then possibly hand-edited) into a target
 * catalog/model in AtScale
 * (POST /v1/aggregates/import/catalogs/{catalogId}/models/{modelId}).
 *
 * Per AtScale's own docs (https://documentation.atscale.com/container-api/import),
 * "the identical model must exist in the system" in the target instance, and
 * importing from a newer AtScale version into an older one is not supported.
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

class AtScaleImportAggregatesParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name         = "connection-file";
      description  = "Path to the connections YAML file";
      required     = false;
      defaultValue = "connections.yaml";
    })(),
    new (class extends StringParameter {
      name        = "atscale-connection-name";
      description = "Name of the AtScale connection entry (the target instance/environment to import into) in the connections file";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "input-file";
      description = "Path to the export JSON file to import (from atscale-export-aggregates, optionally hand-edited)";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "catalog-id";
      description = "Target catalog (project) UUID to import into, from atscale-list-deployments. When omitted (with --model-id), the deployed catalogs/models are listed and — in an interactive terminal — you're prompted to pick one; in a non-interactive session, an error lists the available options.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "model-id";
      description = "Target model (cube) UUID to import into, from atscale-list-deployments. See --catalog-id for behavior when omitted.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "connection-remap";
      description = "Comma-separated list of originalConnId:newConnId pairs to remap connections referenced by the imported aggregates";
      required    = false;
    })(),
    new (class extends BooleanParameter {
      name         = "import-distribution-key";
      description  = "Import distribution-key hints. Defaults to true.";
      required     = false;
      defaultValue = true;
    })(),
    new (class extends BooleanParameter {
      name         = "import-partition-keys";
      description  = "Import partition-key hints. Defaults to true.";
      required     = false;
      defaultValue = true;
    })(),
    new (class extends BooleanParameter {
      name         = "import-replication";
      description  = "Import replication hints. Defaults to true.";
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
  "input-file": string;
  "catalog-id"?: string;
  "model-id"?: string;
  "connection-remap"?: string;
  "import-distribution-key": boolean;
  "import-partition-keys": boolean;
  "import-replication": boolean;
  "insecure"?: boolean;
};
export type AtScaleImportAggregatesParams = Params;

// ── Operation ─────────────────────────────────────────────────────────────────

export class AtScaleImportAggregatesOperation extends Operation<Params> {
  name        = "atscale-import-aggregates";
  description = "Import aggregate definitions from an export file into a catalog/model";
  parameters  = new AtScaleImportAggregatesParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const yaml       = this.services.get<YamlService>("yaml");
    const atScaleSvc = this.services.get<AtScaleRestClientService>("atscale-rest");

    const config = yaml.readFromFile<Record<string, any>>(params["connection-file"]);
    const env    = resolveAtScaleEnv(config, params["atscale-connection-name"], params["insecure"]);

    if (!fs.existsSync(params["input-file"])) {
      throw new Error(`Input file not found: ${params["input-file"]}`);
    }
    const body = JSON.parse(fs.readFileSync(params["input-file"], "utf8"));

    const { catalogId, modelId } = await resolveCatalogAndModel(atScaleSvc, env, params, this.logger);
    const connectionRemap = params["connection-remap"]
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    this.logger.verbose(`[AtScaleImportAggregates] Importing aggregates from ${params["input-file"]} into catalog=${catalogId} model=${modelId}`);

    const result = await atScaleSvc.importAggregates(env, {
      catalogId,
      modelId,
      body,
      importDistributionKey: params["import-distribution-key"],
      importPartitionKeys:   params["import-partition-keys"],
      importReplication:     params["import-replication"],
      connectionRemap,
    });

    this.logger.log(
      `[AtScaleImportAggregates] Imported ${result.numberOfDefinitionsImported ?? 0} definition(s), ` +
      `ignored ${result.numberOfDefinitionsIgnored ?? 0}, into catalog=${catalogId} model=${modelId}`,
    );
    for (const v of result.aggregates?.values ?? []) {
      if (!v.imported) {
        this.logger.log(`  ✗ ${v.id}${v.reason ? ` — ${v.reason}` : ""}`);
      }
    }

    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
}
