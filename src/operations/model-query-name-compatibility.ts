import { createHash } from "crypto";
import { createInterface } from "node:readline/promises";
import { dump, load } from "js-yaml";
import type { Logger } from "../logging.js";

export type ModelMode = "new" | "existing";

export type QueryNameObject = {
  modelName: string;
  dimensionName: string;
  uniqueName: string;
  dataset?: string;
  keyColumns: string[];
  sourceFile: string;
  objectLocation: string;
};

export type QueryNameCollision = {
  modelName: string;
  normalizedName: string;
  originalNames: string[];
  objects: QueryNameObject[];
};

export type CompatibilityResult = {
  sml: Map<string, string>;
  modelMode?: ModelMode;
  modelsProcessed: number;
  queryObjects: number;
  technicalNamesPreserved: number;
  collisionSets: QueryNameCollision[];
  resolvedCollisionSets: number;
  renamedObjects: number;
  existingModelCollisions: number;
  reviewRequired: boolean;
  renames: Array<QueryNameObject & { generatedUniqueName: string }>;
};

type ParsedProject = {
  models: Map<string, any>;
  dimensions: Map<string, any>;
  dimensionPathByName: Map<string, string>;
  modelPathByName: Map<string, string>;
};

const MAX_UNIQUE_NAME_LENGTH = 63;

export function parseModelMode(value: string): ModelMode {
  const normalized = value.trim().toLowerCase();
  if (normalized !== "new" && normalized !== "existing") {
    throw new Error('Parameter model-mode must be either "new" or "existing".');
  }
  return normalized;
}

function normalizeQueryName(value: string): string {
  return value.toLowerCase();
}

function semanticSlug(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toLowerCase() || "query_name";
}

function boundedName(value: string): string {
  if (value.length <= MAX_UNIQUE_NAME_LENGTH) return value;
  const hash = createHash("sha1").update(value).digest("hex").slice(0, 8);
  return `${value.slice(0, MAX_UNIQUE_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

function parsedProject(sml: Map<string, string>): ParsedProject {
  const models = new Map<string, any>();
  const dimensions = new Map<string, any>();
  const dimensionPathByName = new Map<string, string>();
  const modelPathByName = new Map<string, string>();

  for (const [relativePath, content] of sml) {
    if (!relativePath.match(/^(models|dimensions)\//)) continue;
    const document = load(content) as any;
    if (!document || typeof document !== "object") continue;
    const uniqueName = document.unique_name ?? document.label;
    if (!uniqueName) continue;
    if (relativePath.startsWith("models/")) {
      models.set(uniqueName, document);
      modelPathByName.set(uniqueName, relativePath);
    } else {
      dimensions.set(uniqueName, document);
      dimensionPathByName.set(uniqueName, relativePath);
    }
  }
  return { models, dimensions, dimensionPathByName, modelPathByName };
}

function referencedDimensionNames(model: any): string[] {
  const result = new Set<string>();
  for (const dimension of model.dimensions ?? []) {
    const name = typeof dimension === "string" ? dimension : dimension?.unique_name;
    if (name) result.add(name);
  }
  for (const relationship of model.relationships ?? []) {
    const name = relationship?.to?.dimension;
    if (name) result.add(name);
  }
  return [...result];
}

export function detectLevelAttributeQueryNameCollisions(
  models: Map<string, any>,
  dimensions: Map<string, any>,
  dimensionPathByName = new Map<string, string>(),
): { collisions: QueryNameCollision[]; queryObjects: number } {
  const groups = new Map<string, {
    modelName: string;
    normalizedName: string;
    objects: QueryNameObject[];
  }>();
  let queryObjects = 0;

  for (const [modelName, model] of [...models].sort(([a], [b]) => a.localeCompare(b))) {
    for (const dimensionName of referencedDimensionNames(model).sort((a, b) => a.localeCompare(b))) {
      const dimension = dimensions.get(dimensionName);
      if (!dimension) continue;
      for (const [index, levelAttribute] of (dimension.level_attributes ?? []).entries()) {
        const uniqueName = levelAttribute?.unique_name;
        if (typeof uniqueName !== "string" || !uniqueName) continue;
        queryObjects += 1;
        const normalizedName = normalizeQueryName(uniqueName);
        const object: QueryNameObject = {
          modelName,
          dimensionName,
          uniqueName,
          dataset: levelAttribute.dataset,
          keyColumns: [...(levelAttribute.key_columns ?? [])],
          sourceFile: dimensionPathByName.get(dimensionName) ?? `dimensions/${dimensionName}`,
          objectLocation: `level_attributes[${index}]`,
        };
        const groupKey = `${modelName}\0${normalizedName}`;
        const group = groups.get(groupKey) ?? { modelName, normalizedName, objects: [] };
        group.objects.push(object);
        groups.set(groupKey, group);
      }
    }
  }

  const collisions: QueryNameCollision[] = [];
  for (const { modelName, normalizedName, objects } of groups.values()) {
    const distinctDimensions = new Set(objects.map((object) => object.dimensionName));
    if (distinctDimensions.size < 2) continue;
    const uniqueObjects = new Map<string, QueryNameObject>();
    for (const object of objects) {
      const key = `${object.dimensionName}\0${object.uniqueName}\0${object.sourceFile}\0${object.objectLocation}`;
      if (!uniqueObjects.has(key)) uniqueObjects.set(key, object);
    }
    const sorted = [...uniqueObjects.values()].sort((a, b) =>
      `${a.dimensionName}\0${a.uniqueName}\0${a.sourceFile}`.localeCompare(
        `${b.dimensionName}\0${b.uniqueName}\0${b.sourceFile}`,
      ),
    );
    collisions.push({
      modelName,
      normalizedName,
      originalNames: [...new Set(sorted.map((object) => object.uniqueName))].sort(),
      objects: sorted,
    });
  }
  collisions.sort((a, b) =>
    `${a.modelName}\0${a.normalizedName}`.localeCompare(`${b.modelName}\0${b.normalizedName}`),
  );
  return { collisions, queryObjects };
}

function renamePlan(
  collisions: QueryNameCollision[],
  dimensions: Map<string, any>,
): Array<QueryNameObject & { generatedUniqueName: string }> {
  const affectedKeys = new Set(
    collisions.flatMap((collision) => collision.objects.map((object) =>
      `${object.dimensionName}\0${normalizeQueryName(object.uniqueName)}`,
    )),
  );
  const reserved = new Set<string>();
  for (const [dimensionName, dimension] of dimensions) {
    for (const levelAttribute of dimension.level_attributes ?? []) {
      const uniqueName = levelAttribute?.unique_name;
      if (typeof uniqueName !== "string") continue;
      if (!affectedKeys.has(`${dimensionName}\0${normalizeQueryName(uniqueName)}`)) {
        reserved.add(normalizeQueryName(uniqueName));
      }
    }
  }

  const objects = new Map<string, QueryNameObject>();
  for (const collision of collisions) {
    for (const object of collision.objects) {
      objects.set(`${object.dimensionName}\0${normalizeQueryName(object.uniqueName)}`, object);
    }
  }
  const proposed = [...objects.values()].map((object) => ({
    object,
    base: boundedName(`${semanticSlug(object.dimensionName)}_${semanticSlug(object.uniqueName)}`),
  }));
  const baseCounts = new Map<string, number>();
  for (const { base } of proposed) {
    const key = normalizeQueryName(base);
    baseCounts.set(key, (baseCounts.get(key) ?? 0) + 1);
  }

  const used = new Set(reserved);
  return proposed
    .sort((a, b) => `${a.object.dimensionName}\0${a.object.uniqueName}`.localeCompare(`${b.object.dimensionName}\0${b.object.uniqueName}`))
    .map(({ object, base }) => {
      const baseKey = normalizeQueryName(base);
      let generatedUniqueName = base;
      if (reserved.has(baseKey) || (baseCounts.get(baseKey) ?? 0) > 1) {
        const identity = `${object.dimensionName}\0${object.uniqueName}\0${object.sourceFile}`;
        const hash = createHash("sha1").update(identity).digest("hex").slice(0, 8);
        generatedUniqueName = boundedName(`${base}_${hash}`);
      }
      let suffix = 2;
      const deterministicBase = generatedUniqueName;
      while (used.has(normalizeQueryName(generatedUniqueName))) {
        generatedUniqueName = boundedName(`${deterministicBase}_${suffix}`);
        suffix += 1;
      }
      used.add(normalizeQueryName(generatedUniqueName));
      return { ...object, generatedUniqueName };
    });
}

function updateReferences(
  project: ParsedProject,
  renames: Array<QueryNameObject & { generatedUniqueName: string }>,
): void {
  const byDimensionAndName = new Map<string, string>();
  for (const rename of renames) {
    byDimensionAndName.set(
      `${rename.dimensionName}\0${normalizeQueryName(rename.uniqueName)}`,
      rename.generatedUniqueName,
    );
  }
  const replacement = (dimensionName: string, uniqueName: unknown): string | undefined =>
    typeof uniqueName === "string"
      ? byDimensionAndName.get(`${dimensionName}\0${normalizeQueryName(uniqueName)}`)
      : undefined;

  for (const [dimensionName, dimension] of project.dimensions) {
    for (const levelAttribute of dimension.level_attributes ?? []) {
      const generated = replacement(dimensionName, levelAttribute.unique_name);
      if (generated) levelAttribute.unique_name = generated;
    }
    for (const hierarchy of dimension.hierarchies ?? []) {
      for (const level of hierarchy.levels ?? []) {
        const generated = replacement(dimensionName, level.unique_name);
        if (generated) level.unique_name = generated;
      }
    }
    for (const relationship of dimension.relationships ?? []) {
      const targetDimension = relationship?.to?.dimension;
      const generated = targetDimension ? replacement(targetDimension, relationship?.to?.level) : undefined;
      if (generated) relationship.to.level = generated;
    }
  }

  for (const model of project.models.values()) {
    for (const relationship of model.relationships ?? []) {
      const targetDimension = relationship?.to?.dimension;
      const generated = targetDimension ? replacement(targetDimension, relationship?.to?.level) : undefined;
      if (generated) relationship.to.level = generated;
    }
    for (const aggregate of model.aggregates ?? []) {
      for (const attribute of aggregate.attributes ?? []) {
        const generated = attribute.dimension ? replacement(attribute.dimension, attribute.name) : undefined;
        if (generated) attribute.name = generated;
      }
    }
  }
}

function serializeChangedProject(sml: Map<string, string>, project: ParsedProject): Map<string, string> {
  const result = new Map(sml);
  const options = { noRefs: true, lineWidth: -1, sortKeys: false };
  for (const [name, document] of project.dimensions) {
    const relativePath = project.dimensionPathByName.get(name);
    if (relativePath) result.set(relativePath, dump(document, options));
  }
  for (const [name, document] of project.models) {
    const relativePath = project.modelPathByName.get(name);
    if (relativePath) result.set(relativePath, dump(document, options));
  }
  return result;
}

function describeObject(object: QueryNameObject): string[] {
  const lines = [`  ${object.dimensionName}.${object.uniqueName}`];
  if (object.dataset) lines.push(`    dataset: ${object.dataset}`);
  if (object.keyColumns.length > 0) lines.push(`    key: ${object.keyColumns.join(", ")}`);
  lines.push(`    source: ${object.sourceFile} (${object.objectLocation})`);
  return lines;
}

export function formatPolicyRequiredError(collisions: QueryNameCollision[]): string {
  const lines = [
    "ERROR: ambiguous query-name collision requires a model compatibility policy.",
    "",
  ];
  for (const collision of collisions) {
    lines.push(
      "Model:",
      `  ${collision.modelName}`,
      "Query name:",
      `  ${collision.originalNames.join(" / ")}`,
      "",
      "Conflicting objects:",
    );
    for (const object of collision.objects) lines.push(...describeObject(object));
    lines.push("");
  }
  lines.push(
    "Specify one of:",
    "",
    "  --model-mode new",
    "      Automatically generate unique technical/query names for all",
    "      colliding objects.",
    "",
    "  --model-mode existing",
    "      Preserve established technical/query names and report the",
    "      conflict for explicit resolution.",
    "",
    "For automated workflows, a model compatibility policy is required",
    "when a naming collision needs resolution.",
    "",
    "Run with --help for additional information.",
  );
  return lines.join("\n");
}

export function formatExistingConflict(result: CompatibilityResult): string {
  const lines = ["Compatibility conflict: duplicate query name", ""];
  for (const collision of result.collisionSets) {
    lines.push(
      `Model: '${collision.modelName}'`,
      `Query name: '${collision.originalNames.join(" / ")}'`,
      "",
    );
    for (const object of collision.objects) lines.push(...describeObject(object));
    lines.push("");
  }
  lines.push(
    "Existing-model compatibility mode is active.",
    "Automatic renaming was not performed because downstream reports, queries,",
    "or applications may depend on these established names.",
    "Resolve the collision explicitly before production deployment.",
  );
  return lines.join("\n");
}

async function chooseModeInteractively(
  collisions: QueryNameCollision[],
  proposedRenames: Array<QueryNameObject & { generatedUniqueName: string }>,
): Promise<ModelMode> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("Query-name collision detected\n\n");
    for (const collision of collisions) {
      process.stdout.write(
        `In model '${collision.modelName}', the technical/query name ` +
        `'${collision.originalNames.join(" / ")}' is used by multiple semantic objects:\n\n`,
      );
      for (const object of collision.objects) process.stdout.write(`${describeObject(object).join("\n")}\n`);
      process.stdout.write("\n");
    }
    process.stdout.write(
      "Do existing reports, dashboards, queries, or applications depend on these technical/query names?\n\n" +
      "  1. No — New model\n     PS-Utils may safely generate unique technical names.\n\n" +
      "  2. Yes — Existing model\n     PS-Utils will preserve established technical names and report the conflict.\n\n",
    );
    const answer = (await rl.question("Select [1/2]: ")).trim();
    if (answer === "2") return "existing";
    if (answer !== "1") throw new Error("Model compatibility selection cancelled; select 1 or 2.");

    process.stdout.write("\nProposed query-name resolution:\n\n");
    for (const rename of proposedRenames) {
      process.stdout.write(`  ${rename.dimensionName}.${rename.uniqueName}\n    → ${rename.generatedUniqueName}\n`);
    }
    const confirm = (await rl.question("\nApply these changes? [Y/n] ")).trim().toLowerCase();
    if (confirm && confirm !== "y" && confirm !== "yes") {
      throw new Error("Query-name resolution cancelled; no generated files were written.");
    }
    return "new";
  } finally {
    rl.close();
  }
}

export async function applyModelCompatibilityPolicy(
  sml: Map<string, string>,
  requestedMode: ModelMode | undefined,
  logger: Logger,
): Promise<CompatibilityResult> {
  const project = parsedProject(sml);
  const { collisions, queryObjects } = detectLevelAttributeQueryNameCollisions(
    project.models,
    project.dimensions,
    project.dimensionPathByName,
  );
  const proposedRenames = renamePlan(collisions, project.dimensions);

  let modelMode = requestedMode;
  if (collisions.length > 0 && !modelMode) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(formatPolicyRequiredError(collisions));
    }
    modelMode = await chooseModeInteractively(collisions, proposedRenames);
  }

  const renames = modelMode === "new" ? proposedRenames : [];
  if (renames.length > 0) updateReferences(project, renames);
  const result: CompatibilityResult = {
    sml: renames.length > 0 ? serializeChangedProject(sml, project) : new Map(sml),
    modelMode,
    modelsProcessed: project.models.size,
    queryObjects,
    technicalNamesPreserved: Math.max(0, queryObjects - renames.length),
    collisionSets: collisions,
    resolvedCollisionSets: modelMode === "new" ? collisions.length : 0,
    renamedObjects: renames.length,
    existingModelCollisions: modelMode === "existing" ? collisions.length : 0,
    reviewRequired: modelMode === "existing" && collisions.length > 0,
    renames,
  };

  if (modelMode || collisions.length > 0) logger.log(formatCompatibilitySummary(result));
  return result;
}

export function formatCompatibilitySummary(result: CompatibilityResult): string {
  const lines = [
    "MODEL COMPATIBILITY SUMMARY",
    "",
    `Models processed:                         ${result.modelsProcessed}`,
    `Query-facing dimension objects:          ${result.queryObjects}`,
    `Technical names preserved:               ${result.technicalNamesPreserved}`,
    `Collision sets detected:                 ${result.collisionSets.length}`,
    `New-model collision sets resolved:       ${result.resolvedCollisionSets}`,
    `Objects automatically renamed:           ${result.renamedObjects}`,
    `Existing-model collisions detected:      ${result.existingModelCollisions}`,
    `Compatibility conflicts requiring review: ${result.reviewRequired ? result.collisionSets.length : 0}`,
  ];
  for (const collision of result.collisionSets) {
    lines.push(
      "",
      `Finding: duplicate-query-name '${collision.originalNames.join(" / ")}'`,
      `Model: ${collision.modelName}`,
      `Mode: ${result.modelMode}`,
    );
    if (result.modelMode === "new") {
      lines.push("Resolution: renamed-all");
      const members = new Set(collision.objects.map((object) =>
        `${object.dimensionName}\0${normalizeQueryName(object.uniqueName)}`,
      ));
      for (const rename of result.renames.filter((item) =>
        members.has(`${item.dimensionName}\0${normalizeQueryName(item.uniqueName)}`),
      )) {
        lines.push(`  ${rename.dimensionName}.${rename.uniqueName} → ${rename.generatedUniqueName}`);
      }
    } else {
      lines.push("Resolution: source-preserved / manual-resolution-required");
      for (const object of collision.objects) lines.push(`  ${object.dimensionName}.${object.uniqueName}`);
    }
  }
  return lines.join("\n");
}

export function compatibilityReportMarkdown(result: CompatibilityResult): string {
  return `\n\n## Model Compatibility Summary\n\n\`\`\`text\n${formatCompatibilitySummary(result)}\n\`\`\`\n`;
}
