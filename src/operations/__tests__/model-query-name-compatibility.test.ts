import { dump, load } from "js-yaml";
import { describe, expect, it } from "vitest";
import type { Logger } from "../../logging.js";
import {
  applyModelCompatibilityPolicy,
  detectLevelAttributeQueryNameCollisions,
} from "../model-query-name-compatibility.js";

const logger: Logger = { log() {}, info() {}, error() {}, verbose() {} };

type Attribute = { dimension: string; name: string; dataset?: string; key?: string };

function project(attributes: Attribute[]): Map<string, string> {
  const sml = new Map<string, string>();
  const relationships = attributes.map((attribute, index) => ({
    unique_name: `relationship_${index}`,
    from: { dataset: "fact.dataset", join_columns: [`fk_${index}`] },
    to: { dimension: attribute.dimension, level: attribute.name },
  }));
  sml.set("models/model.yml", dump({
    unique_name: "Model",
    object_type: "model",
    label: "Model",
    relationships,
  }));
  for (const attribute of attributes) {
    const path = `dimensions/${attribute.dimension.toLowerCase().replace(/\W+/g, "-")}.yml`;
    const existing = sml.has(path) ? load(sml.get(path)!) as any : {
      unique_name: attribute.dimension,
      object_type: "dimension",
      label: attribute.dimension,
      hierarchies: [{ unique_name: `${attribute.dimension} Hierarchy`, levels: [] }],
      level_attributes: [],
    };
    existing.hierarchies[0].levels.push({ unique_name: attribute.name });
    existing.level_attributes.push({
      unique_name: attribute.name,
      dataset: attribute.dataset ?? `${attribute.dimension.toLowerCase()}.dataset`,
      name_column: attribute.key ?? `${attribute.name}_id`,
      key_columns: [attribute.key ?? `${attribute.name}_id`],
    });
    sml.set(path, dump(existing));
  }
  return sml;
}

function dimension(sml: Map<string, string>, name: string): any {
  return load(sml.get(`dimensions/${name.toLowerCase().replace(/\W+/g, "-")}.yml`)!) as any;
}

describe("model query-name compatibility", () => {
  it("leaves a new model with no collision byte-for-byte unchanged", async () => {
    const input = project([
      { dimension: "Geography", name: "division" },
      { dimension: "Organization", name: "department" },
    ]);
    const result = await applyModelCompatibilityPolicy(input, "new", logger);
    expect([...result.sml]).toEqual([...input]);
    expect(result.renamedObjects).toBe(0);
  });

  it("renames all members of a three-way collision", async () => {
    const result = await applyModelCompatibilityPolicy(project([
      { dimension: "Geography", name: "division" },
      { dimension: "Organization", name: "division" },
      { dimension: "Sales", name: "division" },
    ]), "new", logger);
    expect(result.renames.map((rename) => rename.generatedUniqueName)).toEqual([
      "geography_division",
      "organization_division",
      "sales_division",
    ]);
  });

  it("uses a stable semantic hash when a generated name already exists", async () => {
    const result = await applyModelCompatibilityPolicy(project([
      { dimension: "Geography", name: "division" },
      { dimension: "Organization", name: "division" },
      { dimension: "Reference", name: "organization_division" },
    ]), "new", logger);
    expect(result.renames.find((rename) => rename.dimensionName === "Geography")?.generatedUniqueName)
      .toBe("geography_division");
    expect(result.renames.find((rename) => rename.dimensionName === "Organization")?.generatedUniqueName)
      .toMatch(/^organization_division_[0-9a-f]{8}$/);
  });

  it("is idempotent", async () => {
    const first = await applyModelCompatibilityPolicy(project([
      { dimension: "Geography", name: "division" },
      { dimension: "Organization", name: "division" },
    ]), "new", logger);
    const second = await applyModelCompatibilityPolicy(first.sml, "new", logger);
    expect([...second.sml]).toEqual([...first.sml]);
    expect(second.renamedObjects).toBe(0);
  });

  it("is deterministic regardless of input map order", async () => {
    const firstInput = project([
      { dimension: "Geography", name: "division" },
      { dimension: "Organization", name: "division" },
      { dimension: "Reference", name: "organization_division" },
    ]);
    const secondInput = new Map([...firstInput].reverse());
    const first = await applyModelCompatibilityPolicy(firstInput, "new", logger);
    const second = await applyModelCompatibilityPolicy(secondInput, "new", logger);
    for (const path of [...first.sml.keys()].sort()) expect(second.sml.get(path)).toBe(first.sml.get(path));
  });

  it("preserves unique established names exactly in existing mode", async () => {
    const input = project([
      { dimension: "Geography", name: "DivisionCode" },
      { dimension: "Organization", name: "DepartmentCode" },
    ]);
    const result = await applyModelCompatibilityPolicy(input, "existing", logger);
    expect([...result.sml]).toEqual([...input]);
    expect(result.reviewRequired).toBe(false);
  });

  it("preserves an existing-model collision and requires review", async () => {
    const input = project([
      { dimension: "Geography", name: "division" },
      { dimension: "Organization", name: "division" },
    ]);
    const result = await applyModelCompatibilityPolicy(input, "existing", logger);
    expect([...result.sml]).toEqual([...input]);
    expect(result.renamedObjects).toBe(0);
    expect(result.reviewRequired).toBe(true);
  });

  it("treats query names that differ only by case as colliding", () => {
    const input = project([
      { dimension: "Geography", name: "division" },
      { dimension: "Organization", name: "Division" },
    ]);
    const models = new Map<string, any>();
    const dimensions = new Map<string, any>();
    for (const [file, content] of input) {
      const parsed = load(content) as any;
      if (file.startsWith("models/")) models.set(parsed.unique_name, parsed);
      if (file.startsWith("dimensions/")) dimensions.set(parsed.unique_name, parsed);
    }
    expect(detectLevelAttributeQueryNameCollisions(models, dimensions).collisions).toHaveLength(1);
  });

  it("does not report names used by dimensions in separate models", async () => {
    const input = project([
      { dimension: "Geography", name: "division" },
      { dimension: "Organization", name: "division" },
    ]);
    const combinedModel = load(input.get("models/model.yml")!) as any;
    input.delete("models/model.yml");
    input.set("models/geography.yml", dump({
      ...combinedModel,
      unique_name: "Geography Model",
      relationships: [combinedModel.relationships[0]],
    }));
    input.set("models/organization.yml", dump({
      ...combinedModel,
      unique_name: "Organization Model",
      relationships: [combinedModel.relationships[1]],
    }));

    const result = await applyModelCompatibilityPolicy(input, undefined, logger);

    expect(result.collisionSets).toHaveLength(0);
    expect([...result.sml]).toEqual([...input]);
  });
});
