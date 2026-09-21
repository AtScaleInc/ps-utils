import { describe, expect, it } from "vitest";
import type { Logger } from "../../logging.js";
import type { AtScaleEnvironment, AtScaleRestClientService, ListModelsResult } from "../../services/AtScaleRestClientService.js";
import { resolveCatalogAndModel } from "../atscale-aggregate-shared.js";

const logger: Logger = { log() {}, info() {}, error() {}, verbose() {} };
const env = {} as AtScaleEnvironment;

const DEPLOYED: ListModelsResult = [
  {
    repoId: "repo1",
    name: "Repo 1",
    projects: [
      {
        id: "cat-a",
        name: "Catalog A",
        models: [
          { id: "model-a1", name: "Model A1" },
          { id: "model-a2", name: "Model A2" },
        ],
      },
      {
        id: "cat-b",
        name: "Catalog B",
        models: [{ id: "model-b1", name: "Model B1" }],
      },
    ],
  },
];

function fakeAtScaleSvc(deployed: ListModelsResult): AtScaleRestClientService {
  return { listModels: async () => deployed } as unknown as AtScaleRestClientService;
}

describe("resolveCatalogAndModel", () => {
  it("returns immediately when both catalog-id and model-id are given, without calling listModels", async () => {
    let called = false;
    const svc = { listModels: async () => { called = true; return DEPLOYED; } } as unknown as AtScaleRestClientService;
    const result = await resolveCatalogAndModel(svc, env, { "catalog-id": "cat-a", "model-id": "model-a1" }, logger);
    expect(result).toEqual({ catalogId: "cat-a", modelId: "model-a1" });
    expect(called).toBe(false);
  });

  it("narrows to a single match when only catalog-id is given and it has one model", async () => {
    const svc = fakeAtScaleSvc(DEPLOYED);
    const result = await resolveCatalogAndModel(svc, env, { "catalog-id": "cat-b" }, logger);
    expect(result).toEqual({ catalogId: "cat-b", modelId: "model-b1" });
  });

  it("narrows to a single match when only model-id is given and it's unambiguous", async () => {
    const svc = fakeAtScaleSvc(DEPLOYED);
    const result = await resolveCatalogAndModel(svc, env, { "model-id": "model-a2" }, logger);
    expect(result).toEqual({ catalogId: "cat-a", modelId: "model-a2" });
  });

  it("throws a non-interactive error listing available catalog/model pairs when nothing is specified", async () => {
    const svc = fakeAtScaleSvc(DEPLOYED);
    await expect(resolveCatalogAndModel(svc, env, {}, logger)).rejects.toThrow(
      /Both --catalog-id and --model-id are required.*Catalog A::Model A1.*Catalog A::Model A2.*Catalog B::Model B1/s,
    );
  });

  it("throws a non-interactive error when catalog-id alone is ambiguous (multiple models)", async () => {
    const svc = fakeAtScaleSvc(DEPLOYED);
    await expect(resolveCatalogAndModel(svc, env, { "catalog-id": "cat-a" }, logger)).rejects.toThrow(
      /Both --catalog-id and --model-id are required/,
    );
  });

  it("throws when no deployed catalogs/models exist", async () => {
    const svc = fakeAtScaleSvc([]);
    await expect(resolveCatalogAndModel(svc, env, {}, logger)).rejects.toThrow(
      /No deployed catalogs\/models found/,
    );
  });
});
