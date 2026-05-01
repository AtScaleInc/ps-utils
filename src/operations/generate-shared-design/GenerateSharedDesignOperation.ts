/**
 * GenerateSharedDesign
 *
 * Applies a machine-readable recommendation YAML produced by
 * generate-shared-model-plan.  For each kind:
 *
 *   dataset-consolidation     — merges identical/similar datasets into a
 *                               single shared file at <shared-dir>/datasets/
 *   shared-dimension-library  — merges similar dimensions (preserving all SML
 *                               attributes) into <shared-dir>/dimensions/
 *   base-model-extraction     — creates a shared base model and slim
 *                               project-specific models at <shared-dir>/models/
 *
 * Pass --remove-sources to also delete the local source copies after writing
 * the shared file.  Use --dry-run to preview all actions without touching disk.
 */
import fs from "fs";
import path from "path";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, BooleanParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { parsePlanYaml, applyPlan, type ApplyAction } from "./design-applier.js";

// ----------------------------------------------------------
// Parameters
// ----------------------------------------------------------

class GenerateSharedDesignParams extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "plan-file";
      description = "Path to the option YAML file produced by generate-shared-model-plan";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "shared-dir";
      description = "Base directory for shared output files (e.g. ./shared)";
      required    = true;
    })(),
    new (class extends BooleanParameter {
      name         = "remove-sources";
      description  = "Delete the local source files after writing the shared version (default false)";
      required     = false;
      defaultValue = false;
      isFlag       = true;
    })(),
    new (class extends BooleanParameter {
      name         = "dry-run";
      description  = "Print all actions that would be taken without writing or deleting any files";
      required     = false;
      defaultValue = false;
      isFlag       = true;
    })(),
  ];
}

type Params = {
  "plan-file":       string;
  "shared-dir":      string;
  "remove-sources"?: boolean;
  "dry-run"?:        boolean;
};

// ----------------------------------------------------------
// Operation
// ----------------------------------------------------------

export class GenerateSharedDesignOperation extends Operation<Params> {
  name        = "generate-shared-design";
  description = "Apply a generate-shared-model-plan recommendation YAML to create shared SML files";
  parameters  = new GenerateSharedDesignParams();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const planFile     = path.resolve(params["plan-file"]);
    const sharedDir    = path.resolve(params["shared-dir"]);
    const removeSources = params["remove-sources"] ?? false;
    const dryRun       = params["dry-run"] ?? false;

    if (!fs.existsSync(planFile)) {
      throw new Error(`Plan file not found: ${planFile}`);
    }

    if (dryRun) {
      this.logger.log("[GenerateSharedDesign] DRY RUN — no files will be written or deleted");
    }

    this.logger.log(`[GenerateSharedDesign] Reading plan: ${planFile}`);
    const plan = parsePlanYaml(planFile);
    this.logger.log(`[GenerateSharedDesign] Kind: ${plan.kind} — ${plan.title}`);
    this.logger.log(`[GenerateSharedDesign] Sources: ${plan.source_references.length} reference(s)`);
    this.logger.log(`[GenerateSharedDesign] Shared output dir: ${sharedDir}`);
    if (removeSources) this.logger.log("[GenerateSharedDesign] --remove-sources: local copies will be deleted");

    fs.mkdirSync(sharedDir, { recursive: true });

    const result = applyPlan(plan, sharedDir, removeSources, dryRun);

    // Report actions
    const creates = result.actions.filter((a) => a.type === "create");
    const deletes = result.actions.filter((a) => a.type === "delete");
    const notes   = result.actions.filter((a) => a.type === "note");

    this.logger.log("");
    for (const a of result.actions) {
      this.logger.log(`  [${a.type.toUpperCase().padEnd(6)}] ${a.description}`);
    }

    if (result.warnings.length > 0) {
      this.logger.log("\n[GenerateSharedDesign] Warnings:");
      for (const w of result.warnings) this.logger.log(`  ! ${w}`);
    }

    const summary = [
      `${creates.length} file(s) ${dryRun ? "would be " : ""}created`,
      deletes.length > 0 ? `${deletes.length} file(s) ${dryRun ? "would be " : ""}deleted` : null,
      notes.length > 0   ? `${notes.length} note(s)` : null,
    ].filter(Boolean).join(", ");

    this.logger.log(
      `\n[GenerateSharedDesign] ${dryRun ? "DRY RUN — " : ""}Done — ${summary}`,
    );

    // Write an apply report alongside the shared files
    if (!dryRun) {
      const reportPath = path.join(sharedDir, "APPLY_REPORT.md");
      fs.writeFileSync(reportPath, this.buildReport(plan, result.actions, result.warnings, removeSources), "utf8");
      this.logger.log(`[GenerateSharedDesign] Report: ${reportPath}`);
    }
  }

  private buildReport(
    plan:          ReturnType<typeof parsePlanYaml>,
    actions:       ApplyAction[],
    warnings:      string[],
    removeSources: boolean,
  ): string {
    const date  = new Date().toISOString().split("T")[0];
    const lines = [
      "# Shared Design Apply Report",
      "",
      `**Date:** ${date}  `,
      `**Plan:** ${plan.option_id} — ${plan.title}  `,
      `**Kind:** \`${plan.kind}\`  `,
      `**Remove sources:** ${removeSources}`,
      "",
      plan.description,
      "",
      "## Actions Taken",
      "",
    ];

    for (const a of actions) {
      const icon = a.type === "create" ? "✅" : a.type === "delete" ? "🗑️" : "ℹ️";
      lines.push(`- ${icon} **${a.type.toUpperCase()}** ${a.description}`);
    }

    if (warnings.length > 0) {
      lines.push("", "## Warnings", "");
      for (const w of warnings) lines.push(`- ⚠️ ${w}`);
    }

    lines.push("", "## Next Steps", "");
    switch (plan.kind) {
      case "dataset-consolidation":
        lines.push(
          "1. Configure your AtScale SML project to include the `shared/datasets/` directory",
          "   (or copy the shared dataset file into each consuming project's `datasets/` folder).",
          "2. Remove any local dataset copies listed as notes above.",
          "3. Redeploy all affected projects.",
        );
        break;
      case "shared-dimension-library":
        lines.push(
          "1. Configure your AtScale SML project to include the `shared/dimensions/` directory",
          "   (or copy the shared dimension file into each consuming project's `dimensions/` folder).",
          "2. Remove any local dimension copies listed as notes above.",
          "3. Redeploy all affected projects.",
        );
        break;
      case "base-model-extraction":
        lines.push(
          "1. Review the generated base model and slim source models in `shared/models/`.",
          "2. For 100%-identical source models: replace one with the base model in your deployment.",
          "3. For partially-overlapping models: update each source project to reference",
          "   the base model's dimensions and metrics, then add their specific content.",
          "4. AtScale SML does not support native model inheritance — the base model is a",
          "   reference artifact. Implement sharing via a shared SML catalog or by copying.",
        );
        break;
    }

    lines.push("", "---", "");
    return lines.join("\n");
  }
}
