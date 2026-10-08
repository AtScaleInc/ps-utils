/**
 * Shared catalog/model resolution for the Aggregate Management operations
 * (atscale-list-aggregates, atscale-rebuild-aggregates,
 * atscale-list-aggregate-build-history, atscale-export-aggregates,
 * atscale-import-aggregates).
 *
 * Mirrors the standalone atscale-aggregate-util tool's own UX: `--catalog-id`/
 * `--model-id` are optional. When either is omitted, the deployed catalogs
 * (projects) and models (cubes) are listed via `atscale-list-deployments`'
 * underlying `listModels()` call; in an interactive terminal the user is
 * prompted to pick one from a numbered "Project::Model" list (same display
 * convention as the original tool), and in a non-interactive session (CI) a
 * clear error lists every available catalog/model pair and asks for the
 * flags to be passed explicitly.
 */
import { createInterface } from "node:readline/promises";
import type { Logger } from "../logging.js";
import type { AtScaleEnvironment, AtScaleRestClientService } from "../services/AtScaleRestClientService.js";

export type ResolvedCatalogModel = {
  catalogId: string;
  modelId: string;
};

type CatalogModelOption = {
  display: string;
  catalogId: string;
  catalogName: string;
  modelId: string;
  modelName: string;
};

async function listCatalogModelOptions(
  atScaleSvc: AtScaleRestClientService,
  env: AtScaleEnvironment,
): Promise<CatalogModelOption[]> {
  const repos = await atScaleSvc.listModels(env);
  const options: CatalogModelOption[] = [];
  for (const repo of repos) {
    for (const project of repo.projects ?? []) {
      for (const model of project.models ?? []) {
        options.push({
          display:     `${project.name}::${model.name}`,
          catalogId:   project.id,
          catalogName: project.name,
          modelId:     model.id,
          modelName:   model.name,
        });
      }
    }
  }
  return options;
}

async function pickInteractively(options: CatalogModelOption[]): Promise<ResolvedCatalogModel> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("\nSelect a catalog/model:\n\n");
    options.forEach((o, i) => process.stdout.write(`  ${i + 1}. ${o.display}\n`));
    const answer = (await rl.question(`\nSelect [1-${options.length}]: `)).trim();
    const idx = Number(answer) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) {
      throw new Error("Invalid selection; no catalog/model chosen.");
    }
    const chosen = options[idx];
    return { catalogId: chosen.catalogId, modelId: chosen.modelId };
  } finally {
    rl.close();
  }
}

function formatOptionsList(options: CatalogModelOption[]): string {
  return options
    .map((o) => `  - ${o.display}  (--catalog-id ${o.catalogId} --model-id ${o.modelId})`)
    .join("\n");
}

/**
 * Resolve `--catalog-id`/`--model-id` for an aggregate-management operation.
 * When both are already given, returns them as-is without any API call.
 */
export async function resolveCatalogAndModel(
  atScaleSvc: AtScaleRestClientService,
  env: AtScaleEnvironment,
  params: { "catalog-id"?: string; "model-id"?: string },
  logger: Logger,
): Promise<ResolvedCatalogModel> {
  if (params["catalog-id"] && params["model-id"]) {
    return { catalogId: params["catalog-id"], modelId: params["model-id"] };
  }

  logger.verbose("[AggregateManagement] --catalog-id/--model-id not fully specified — listing deployed models...");
  const options = await listCatalogModelOptions(atScaleSvc, env);
  if (options.length === 0) {
    throw new Error("No deployed catalogs/models found in this AtScale instance.");
  }

  const filtered = options.filter((o) =>
    (!params["catalog-id"] || o.catalogId === params["catalog-id"]) &&
    (!params["model-id"] || o.modelId === params["model-id"]),
  );
  if (filtered.length === 1) {
    return { catalogId: filtered[0].catalogId, modelId: filtered[0].modelId };
  }
  const candidates = filtered.length > 0 ? filtered : options;

  if (process.stdin.isTTY && process.stdout.isTTY) {
    return pickInteractively(candidates);
  }

  throw new Error(
    "Both --catalog-id and --model-id are required in a non-interactive session. " +
    "Available deployed catalog/model pairs:\n\n" + formatOptionsList(candidates) + "\n",
  );
}
