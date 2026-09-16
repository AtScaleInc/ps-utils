/**
 * AtScaleListAggregateBuildHistory
 *
 * Lists recent aggregate build batches for a given catalog/model (project/cube)
 * in AtScale, with parsed durations and a computed summary (success/failed/
 * running counts, full-build count, average/min/max duration). Writes the
 * result as JSON to stdout.
 */
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, BooleanParameter, NumberParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import {
  AtScaleRestClientService,
  type AggregateBuildBatch,
} from "../../services/AtScaleRestClientService.js";
import { resolveAtScaleEnv } from "../atscale-env.js";

// ── Parameters ────────────────────────────────────────────────────────────────

class AtScaleListAggregateBuildHistoryParamsSet extends ParameterSet {
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
    new (class extends NumberParameter {
      name         = "limit";
      description  = "Maximum number of build batches to fetch";
      required     = false;
      defaultValue = 20;
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
  "limit": number;
  "insecure"?: boolean;
};
export type AtScaleListAggregateBuildHistoryParams = Params;

// ── Duration parsing ──────────────────────────────────────────────────────────

/** Parse an ISO-8601 duration like "PT3.232S" or "PT2M" into milliseconds. */
function parseIsoDurationMs(duration?: string): number | undefined {
  if (!duration || !duration.startsWith("PT")) return undefined;
  const match = duration.match(/^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/);
  if (!match) return undefined;
  const [, hours, minutes, seconds] = match;
  const totalSeconds =
    (Number(hours ?? 0) * 3600) +
    (Number(minutes ?? 0) * 60) +
    Number(seconds ?? 0);
  return totalSeconds * 1000;
}

function durationBetween(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const startMs = Date.parse(start);
  const endMs   = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return undefined;
  return endMs - startMs;
}

type EnrichedBatch = AggregateBuildBatch & {
  durationMs?: number;
  estimateTimeMs?: number;
  sumOfInstanceBuildTimesMs?: number;
};

function enrichBatch(batch: AggregateBuildBatch): EnrichedBatch {
  return {
    ...batch,
    durationMs: durationBetween(batch.startTime, batch.endTime),
    estimateTimeMs: batch.estimateTime,
    sumOfInstanceBuildTimesMs: parseIsoDurationMs(batch.sumOfInstanceBuildTimes),
  };
}

type Summary = {
  totalBatches: number;
  successful: number;
  failed: number;
  running: number;
  fullBuilds: number;
  averageDurationMs: number;
  minDurationMs?: number;
  maxDurationMs?: number;
};

function buildSummary(batches: EnrichedBatch[]): Summary {
  const durations = batches
    .map((b) => b.durationMs)
    .filter((d): d is number => d !== undefined);

  return {
    totalBatches: batches.length,
    successful: batches.filter((b) => b.status === "done").length,
    failed: batches.filter((b) => b.status === "failed").length,
    running: batches.filter((b) => b.status === "running").length,
    fullBuilds: batches.filter((b) => b.isFullBuild).length,
    averageDurationMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
    minDurationMs: durations.length ? Math.min(...durations) : undefined,
    maxDurationMs: durations.length ? Math.max(...durations) : undefined,
  };
}

// ── Operation ─────────────────────────────────────────────────────────────────

export class AtScaleListAggregateBuildHistoryOperation extends Operation<Params> {
  name        = "atscale-list-aggregate-build-history";
  description = "List aggregate build history for a catalog/model with a computed summary";
  parameters  = new AtScaleListAggregateBuildHistoryParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const yaml       = this.services.get<YamlService>("yaml");
    const atScaleSvc = this.services.get<AtScaleRestClientService>("atscale-rest");

    const config = yaml.readFromFile<Record<string, any>>(params["connection-file"]);
    const env    = resolveAtScaleEnv(config, params["atscale-connection-name"], params["insecure"]);

    this.logger.verbose(`[AtScaleListAggregateBuildHistory] Fetching build history for catalog=${params["catalog-id"]} model=${params["model-id"]}`);

    const result = await atScaleSvc.getAggregateBuildHistory(env, {
      catalogId: params["catalog-id"],
      modelId:   params["model-id"],
      limit:     params["limit"],
    });

    const batches = result.data.map(enrichBatch);
    const summary = buildSummary(batches);

    process.stdout.write(JSON.stringify({
      catalogId: params["catalog-id"],
      modelId:   params["model-id"],
      total:     result.total,
      batches,
      summary,
    }, null, 2) + "\n");
  }
}
