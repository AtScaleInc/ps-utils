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
 *
 * Cross-host promotion (e.g. dev → prod): every id in the export payload
 * (catalog, model, instance, key and role-play reference ids inside
 * `planJson`, connection ids) is generated per-host, so a straight re-post
 * only works when importing back into the exact same catalog/model. When the
 * target differs from the payload's `exportCatalogId`/`exportModelId`, this
 * operation remaps the payload before posting it:
 *
 *   - catalog/model ids (including every occurrence inside `planJson`) →
 *     the target's
 *   - key/role-play reference ids inside `planJson` → the target's ids for
 *     the same logical *names* (atscale-aggregate-idmap.ts). An aggregate
 *     whose plan references an object missing on the target is skipped, not
 *     imported, and reported. Name maps come from atscale-export-aggregates'
 *     embedded `_psUtils.sourceObjectNames`, or from
 *     --source-atscale-connection-name when that isn't present.
 *   - connection ids → the target model's connection, when it differs
 *   - required string fields that are null/missing (e.g. because the source
 *     aggregate has no instance) → "", never null (the import schema rejects
 *     null)
 *
 * Promotion rules (only applied when there's something to match against —
 * i.e. the target catalog representation and aggregate list were readable):
 * an aggregate already active on the target (same objects, by plan
 * fingerprint) is skipped as a duplicate; one whose only match is blocked on
 * the target reuses that instance id, and is reactivated via the unblock
 * endpoint if AtScale ends up not (re-)importing it because it already
 * exists; an aggregate blocked on the *source* isn't promoted at all.
 */
import fs from "fs";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, BooleanParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import { AtScaleRestClientService, type AggregateDefinition } from "../../services/AtScaleRestClientService.js";
import { resolveAtScaleEnv } from "../atscale-env.js";
import { resolveCatalogAndModel } from "../atscale-aggregate-shared.js";
import { idNames, nameIds } from "../atscale-aggregate-idmap.js";
import { planFingerprint } from "../atscale-aggregate-fingerprint.js";
import { remapExport, type RemapProblem } from "../atscale-aggregate-remap.js";

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
      name        = "source-atscale-connection-name";
      description = "Name of the AtScale connection entry for the SOURCE instance the export came from, in the connections file. Only used when the input file doesn't already carry an embedded object-name map (files from an older atscale-export-aggregates, or hand-crafted per AtScale's own docs) — lets cross-host imports still translate key/role-play reference ids by name instead of only substituting catalog/model ids.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "connection-remap";
      description = "Comma-separated list of originalConnId:newConnId pairs to remap connections referenced by the imported aggregates. Manual override; connections are otherwise remapped automatically to the target model's connection when it differs.";
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
  "source-atscale-connection-name"?: string;
  "connection-remap"?: string;
  "import-distribution-key": boolean;
  "import-partition-keys": boolean;
  "import-replication": boolean;
  "insecure"?: boolean;
};
export type AtScaleImportAggregatesParams = Params;

type SkippedAggregate = { id: string; reason: string };

// ── Operation ─────────────────────────────────────────────────────────────────

export class AtScaleImportAggregatesOperation extends Operation<Params> {
  name        = "atscale-import-aggregates";
  description = "Import aggregate definitions from an export file into a catalog/model, remapping ids for cross-host promotion";
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
    const payload = JSON.parse(fs.readFileSync(params["input-file"], "utf8")) as Record<string, unknown>;

    const { catalogId, modelId } = await resolveCatalogAndModel(atScaleSvc, env, params, this.logger);
    const sourceCatalogId = String(payload.exportCatalogId ?? "");
    const sourceModelId   = String(payload.exportModelId ?? "");
    const crossHost        = sourceCatalogId !== catalogId || sourceModelId !== modelId;

    this.logger.verbose(
      `[AtScaleImportAggregates] Importing aggregates from ${params["input-file"]} ` +
      `(source catalog=${sourceCatalogId} model=${sourceModelId}) into catalog=${catalogId} model=${modelId}`,
    );

    // ── Target catalog/connection/aggregate metadata (best-effort — used for
    //    id-by-name translation and duplicate/instance detection; missing any
    //    of it degrades gracefully rather than failing the import). ─────────
    let targetNames: Record<string, string> | undefined;
    let targetIdsByName: Record<string, string> | undefined;
    try {
      const targetCatalogExport = await atScaleSvc.getCatalogExportRepresentation(env, { catalogId });
      targetNames     = idNames(targetCatalogExport);
      targetIdsByName = nameIds(targetCatalogExport);
    } catch (err) {
      this.logger.verbose(
        `[AtScaleImportAggregates] Could not read the target catalog representation ` +
        `(key/reference translation and duplicate detection will be skipped): ${(err as Error).message}`,
      );
    }

    let targetConnections: string[] = [];
    try {
      const catalog = await atScaleSvc.getCatalog(env, { catalogId });
      const model = (catalog.models ?? []).find((m) => m.id === modelId);
      targetConnections = model?.connection_ids ?? model?.connectionIds ?? [];
    } catch (err) {
      this.logger.verbose(`[AtScaleImportAggregates] Could not read the target model's connections: ${(err as Error).message}`);
    }

    // ── Source object names, for key/reference translation. ────────────────
    const psUtilsMeta = payload._psUtils as { sourceObjectNames?: Record<string, string> } | undefined;
    let sourceNames: Record<string, string> | undefined =
      psUtilsMeta?.sourceObjectNames && Object.keys(psUtilsMeta.sourceObjectNames).length > 0
        ? psUtilsMeta.sourceObjectNames
        : undefined;
    if (!sourceNames && sourceCatalogId === catalogId) {
      // Literally the same catalog — the payload's ids are already this host's.
      sourceNames = targetNames;
    }
    if (!sourceNames && params["source-atscale-connection-name"]) {
      try {
        const sourceEnv = resolveAtScaleEnv(config, params["source-atscale-connection-name"], params["insecure"]);
        const sourceCatalogExport = await atScaleSvc.getCatalogExportRepresentation(sourceEnv, { catalogId: sourceCatalogId });
        sourceNames = idNames(sourceCatalogExport);
      } catch (err) {
        this.logger.verbose(`[AtScaleImportAggregates] Could not read the source catalog representation: ${(err as Error).message}`);
      }
    }
    if (crossHost && !sourceNames) {
      this.logger.log(
        "[AtScaleImportAggregates] Warning: importing across catalogs/models without source object names — " +
        "key and role-play reference ids in each aggregate's plan will not be translated. Re-export with the " +
        "current atscale-export-aggregates (embeds them automatically), or pass --source-atscale-connection-name.",
      );
    }

    // ── Duplicate / instance-reuse detection against the target's existing
    //    aggregates (best-effort; skipped entirely if any call fails). ─────
    const targetInstances: Record<string, string | undefined> = {};
    const counterpartDefinitionId: Record<string, string> = {};
    const preSkipped: SkippedAggregate[] = [];
    let candidateValues = Array.isArray((payload.aggregates as any)?.values) ? [...(payload.aggregates as any).values] : [];

    if (targetNames) {
      try {
        const [targetExport, targetDefs] = await Promise.all([
          atScaleSvc.exportAggregates(env, { catalogId, modelId }),
          atScaleSvc.listAggregateDefinitions(env, { catalogId, modelId }),
        ]);
        const targetDefById = new Map<string, AggregateDefinition>(targetDefs.map((d) => [d.id, d]));
        const targetFingerprintToId = new Map<string, string>();
        for (const v of ((targetExport as any)?.aggregates?.values ?? []) as Array<Record<string, unknown>>) {
          const fp = planFingerprint(v.planJson, targetNames);
          if (fp && typeof v.id === "string") targetFingerprintToId.set(fp, v.id);
        }

        const kept: Record<string, unknown>[] = [];
        for (const v of candidateValues as Array<Record<string, unknown>>) {
          const id = String(v.id);
          if (v.blocked === true) {
            preSkipped.push({ id, reason: "Inactive on source" });
            continue;
          }
          const fp = planFingerprint(v.planJson, sourceNames);
          const matchId = fp ? targetFingerprintToId.get(fp) : undefined;
          const matchDef = matchId ? targetDefById.get(matchId) : undefined;
          if (matchDef && matchDef.blocked === false) {
            preSkipped.push({ id, reason: "Duplicate on target" });
            continue;
          }
          if (matchDef) {
            const instanceId = matchDef.activeInstance?.id ?? matchDef.latestInstance?.id;
            targetInstances[id] = instanceId;
            counterpartDefinitionId[id] = matchDef.id;
          }
          kept.push(v);
        }
        candidateValues = kept;
      } catch (err) {
        this.logger.verbose(
          `[AtScaleImportAggregates] Could not read the target's existing aggregates ` +
          `(duplicate/instance detection skipped): ${(err as Error).message}`,
        );
      }
    }

    const effectivePayload: Record<string, unknown> = {
      ...payload,
      aggregates: { ...(payload.aggregates as Record<string, unknown> | undefined ?? {}), count: candidateValues.length, values: candidateValues },
    };

    const { payload: remapped, problems } = remapExport(effectivePayload, {
      targetCatalogId: catalogId,
      targetModelId:   modelId,
      targetInstances,
      targetConnections,
      sourceNames,
      targetIdsByName,
    });

    delete remapped._psUtils; // not part of AtScale's import request schema; only carried on export files for our own use

    const skipped: SkippedAggregate[] = [...preSkipped, ...problems.map((p: RemapProblem) => ({ id: p.id, reason: p.reason }))];

    const values = (remapped.aggregates as any)?.values ?? [];
    if (values.length === 0) {
      this.logger.log(
        `[AtScaleImportAggregates] Nothing to import into catalog=${catalogId} model=${modelId} ` +
        `(${skipped.length} aggregate(s) skipped).`,
      );
      for (const s of skipped) this.logger.log(`  ✗ ${s.id} — ${s.reason}`);
      process.stdout.write(JSON.stringify({ catalogId, modelId, numberOfDefinitionsImported: 0, numberOfDefinitionsIgnored: 0, skipped }, null, 2) + "\n");
      return;
    }

    const connectionRemap = params["connection-remap"]
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const result = await atScaleSvc.importAggregates(env, {
      catalogId,
      modelId,
      body: remapped,
      importDistributionKey: params["import-distribution-key"],
      importPartitionKeys:   params["import-partition-keys"],
      importReplication:     params["import-replication"],
      connectionRemap,
    });

    const reactivated: string[] = [];
    for (const v of result.aggregates?.values ?? []) {
      if (v.imported) continue;
      const counterpart = counterpartDefinitionId[v.id];
      if (!counterpart) continue;
      try {
        await atScaleSvc.unblockAggregateDefinition(env, { definitionId: counterpart });
        reactivated.push(counterpart);
      } catch (err) {
        skipped.push({ id: v.id, reason: `Failed to reactivate existing (blocked) copy ${counterpart}: ${(err as Error).message}` });
      }
    }

    this.logger.log(
      `[AtScaleImportAggregates] Imported ${result.numberOfDefinitionsImported ?? 0} definition(s), ` +
      `ignored ${result.numberOfDefinitionsIgnored ?? 0}, reactivated ${reactivated.length}, ` +
      `skipped ${skipped.length}, into catalog=${catalogId} model=${modelId}`,
    );
    for (const v of result.aggregates?.values ?? []) {
      if (!v.imported && !counterpartDefinitionId[v.id]) {
        this.logger.log(`  ✗ ${v.id}${v.reason ? ` — ${v.reason}` : ""}`);
      }
    }
    for (const s of skipped) {
      this.logger.log(`  ✗ ${s.id} — ${s.reason}`);
    }

    process.stdout.write(JSON.stringify({ ...result, reactivated, skipped }, null, 2) + "\n");
  }
}
