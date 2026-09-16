/**
 * AtScaleListAggregates
 *
 * Lists aggregates for a given catalog/model (project/cube) in AtScale, along
 * with a computed summary (type/subtype/status breakdowns, row and build-time
 * totals, fastest/slowest/largest/smallest aggregate) and a health check
 * (inactive aggregates, zero-row aggregates, slow builds). Writes the result
 * as JSON to stdout, and optionally a CSV export to --output-file.
 *
 * Health checks are limited to what GET /v1/aggregates/instances actually
 * returns — it carries no query-utilization or last-query-time fields, so
 * checks based on those (present in the source Python tool) are not ported.
 */
import fs from "fs";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, BooleanParameter, NumberParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import {
  AtScaleRestClientService,
  type AggregateInstance,
} from "../../services/AtScaleRestClientService.js";
import { resolveAtScaleEnv } from "../atscale-env.js";
import { resolveCatalogAndModel } from "../atscale-aggregate-shared.js";

// ── Parameters ────────────────────────────────────────────────────────────────

class AtScaleListAggregatesParamsSet extends ParameterSet {
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
      description = "Catalog (project) UUID, from atscale-list-deployments. When omitted (with --model-id), the deployed catalogs/models are listed and — in an interactive terminal — you're prompted to pick one; in a non-interactive session, an error lists the available options.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "model-id";
      description = "Model (cube) UUID, from atscale-list-deployments. See --catalog-id for behavior when omitted.";
      required    = false;
    })(),
    new (class extends NumberParameter {
      name         = "limit";
      description  = "Maximum number of aggregates to fetch";
      required     = false;
      defaultValue = 200;
    })(),
    new (class extends StringParameter {
      name        = "output-file";
      description = "When provided, also write a CSV export of the aggregates to this path";
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
  "limit": number;
  "output-file"?: string;
  "insecure"?: boolean;
};
export type AtScaleListAggregatesParams = Params;

// ── Summary / health computation ─────────────────────────────────────────────

type Summary = {
  totalAggregates: number;
  activeCount: number;
  totalRows: number;
  averageRows: number;
  totalBuildDurationMs: number;
  averageBuildDurationMs: number;
  typeBreakdown: Record<string, number>;
  subtypeBreakdown: Record<string, number>;
  statusBreakdown: Record<string, number>;
  fastestBuildId?: string;
  slowestBuildId?: string;
  largestAggregateId?: string;
  smallestAggregateId?: string;
};

function buildSummary(aggregates: AggregateInstance[]): Summary {
  const typeBreakdown: Record<string, number> = {};
  const subtypeBreakdown: Record<string, number> = {};
  const statusBreakdown: Record<string, number> = {};
  let totalRows = 0;
  let totalBuildDurationMs = 0;
  let activeCount = 0;

  for (const agg of aggregates) {
    const type = String(agg["type"] ?? "unknown");
    const subtype = String(agg["subtype"] ?? "unknown");
    typeBreakdown[type] = (typeBreakdown[type] ?? 0) + 1;
    subtypeBreakdown[subtype] = (subtypeBreakdown[subtype] ?? 0) + 1;
    statusBreakdown[agg.status] = (statusBreakdown[agg.status] ?? 0) + 1;
    totalRows += agg.stats.numberOfRows ?? 0;
    totalBuildDurationMs += agg.stats.buildDurationMs ?? 0;
    if (agg.status.toLowerCase() === "active") activeCount++;
  }

  const byBuildTime = [...aggregates].sort(
    (a, b) => (a.stats.buildDurationMs ?? 0) - (b.stats.buildDurationMs ?? 0),
  );
  const byRows = [...aggregates].sort(
    (a, b) => (a.stats.numberOfRows ?? 0) - (b.stats.numberOfRows ?? 0),
  );

  const count = aggregates.length;
  return {
    totalAggregates: count,
    activeCount,
    totalRows,
    averageRows: count ? totalRows / count : 0,
    totalBuildDurationMs,
    averageBuildDurationMs: count ? totalBuildDurationMs / count : 0,
    typeBreakdown,
    subtypeBreakdown,
    statusBreakdown,
    fastestBuildId: byBuildTime[0]?.id,
    slowestBuildId: byBuildTime[byBuildTime.length - 1]?.id,
    smallestAggregateId: byRows[0]?.id,
    largestAggregateId: byRows[byRows.length - 1]?.id,
  };
}

type Health = {
  issues: string[];
  warnings: string[];
  healthScore: number;
};

const SLOW_BUILD_THRESHOLD_MS = 30_000;

function buildHealth(aggregates: AggregateInstance[]): Health {
  const issues: string[] = [];
  const warnings: string[] = [];

  for (const agg of aggregates) {
    if (agg.status.toLowerCase() !== "active") {
      issues.push(`${agg.id}: status is '${agg.status}'`);
    }
    if ((agg.stats.numberOfRows ?? 0) === 0) {
      warnings.push(`${agg.id}: has 0 rows`);
    }
    if ((agg.stats.buildDurationMs ?? 0) > SLOW_BUILD_THRESHOLD_MS) {
      warnings.push(`${agg.id}: slow build (${agg.stats.buildDurationMs}ms)`);
    }
  }

  const count = aggregates.length;
  const issuePenalty = count ? (issues.length / count) * 50 : 0;
  const warningPenalty = count ? (warnings.length / count) * 25 : 0;
  const healthScore = Math.max(0, 100 - issuePenalty - warningPenalty);

  return { issues, warnings, healthScore };
}

// ── CSV export ────────────────────────────────────────────────────────────────

function csvEscape(value: unknown): string {
  const str = value === undefined || value === null ? "" : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toCsv(aggregates: AggregateInstance[]): string {
  const columns = [
    "id", "type", "subtype", "status", "rows", "buildDurationMs",
    "tableName", "tableSchema", "batchId", "connectionId",
  ];
  const lines = [columns.join(",")];
  for (const agg of aggregates) {
    lines.push([
      agg.id,
      agg["type"] ?? "",
      agg["subtype"] ?? "",
      agg.status,
      agg.stats.numberOfRows ?? 0,
      agg.stats.buildDurationMs ?? 0,
      agg.tableName ?? "",
      agg.tableSchema ?? "",
      agg.batchId ?? "",
      agg.connectionId ?? "",
    ].map(csvEscape).join(","));
  }
  return lines.join("\n") + "\n";
}

// ── Operation ─────────────────────────────────────────────────────────────────

export class AtScaleListAggregatesOperation extends Operation<Params> {
  name        = "atscale-list-aggregates";
  description = "List aggregates for a catalog/model with a computed summary and health check";
  parameters  = new AtScaleListAggregatesParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const yaml       = this.services.get<YamlService>("yaml");
    const atScaleSvc = this.services.get<AtScaleRestClientService>("atscale-rest");

    const config = yaml.readFromFile<Record<string, any>>(params["connection-file"]);
    const env    = resolveAtScaleEnv(config, params["atscale-connection-name"], params["insecure"]);

    const { catalogId, modelId } = await resolveCatalogAndModel(atScaleSvc, env, params, this.logger);
    this.logger.verbose(`[AtScaleListAggregates] Fetching aggregates for catalog=${catalogId} model=${modelId}`);

    const result = await atScaleSvc.getAggregatesByCube(env, {
      catalogId,
      modelId,
      limit: params["limit"],
    });

    const summary = buildSummary(result.data);
    const health  = buildHealth(result.data);

    if (params["output-file"]) {
      fs.writeFileSync(params["output-file"], toCsv(result.data), "utf8");
      this.logger.log(`Wrote CSV export to ${params["output-file"]}`);
    }

    process.stdout.write(JSON.stringify({
      catalogId,
      modelId,
      total:     result.total,
      aggregates: result.data,
      summary,
      health,
    }, null, 2) + "\n");
  }
}
