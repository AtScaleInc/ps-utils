/**
 * GenerateDataFromDataShape
 *
 * Reads a data-shape.yaml fingerprint file and generates statistically
 * equivalent synthetic data — no database connection required.
 *
 * Output: one CSV file per table written to --output-dir:
 *   dim_1.csv, dim_2.csv, …  (dimensions first)
 *   fact_1.csv, fact_2.csv, … (facts second)
 *
 * Column names and types match those produced by generate-ddl-from-data-shape
 * so the CSV files can be loaded directly into the reconstructed schema.
 *
 * Use --scale-factor < 1 to generate a proportionally smaller dataset
 * (e.g. 0.01 = 1% of real size) suitable for testing or local development.
 * Use --seed for deterministic output.
 */
import fs   from "fs";
import path from "path";
import { Operation }        from "../Operation.js";
import { ParameterSet, StringParameter, NumberParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger }           from "../../logging.js";
import { readFingerprintFile }   from "../../statistics/fingerprint.js";
import { generateData, writeDataToCsv } from "../../statistics/data-generator.js";
import {
  SECURITY_PROFILE_VERSION,
  sha256File,
  writePipelineIsolationReport,
  writeRunManifest,
  writeIntegrityReport,
}                                 from "../../statistics/security.js";
import crypto                    from "crypto";

// ─── Parameters ────────────────────────────────────────────────────────────────

class GenerateDataFromDataShapeParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name         = "input-file";
      description  = "Path to the data-shape.yaml fingerprint file (default: data-shape.yaml)";
      required     = false;
      defaultValue = "data-shape.yaml";
    })(),
    new (class extends StringParameter {
      name         = "output-dir";
      description  = "Directory where CSV files are written (default: data)";
      required     = false;
      defaultValue = "data";
    })(),
    new (class extends NumberParameter {
      name         = "scale-factor";
      description  = "Scale row/member counts by this factor (default: 1.0; use < 1 for smaller datasets)";
      required     = false;
      defaultValue = 1.0;
    })(),
    new (class extends NumberParameter {
      name        = "seed";
      description = "Random seed for reproducible output (omit for non-deterministic)";
      required    = false;
    })(),
    new (class extends StringParameter {
      name         = "reports-dir";
      description  = "Directory where security reports are written (default: <output-dir>/_reports)";
      required     = false;
    })(),
  ];
}

type Params = {
  "input-file":    string;
  "output-dir":    string;
  "scale-factor":  number;
  "seed"?:         number;
  "reports-dir"?:  string;
};
export type GenerateDataFromDataShapeParams = Params;

// ─── Operation ────────────────────────────────────────────────────────────────

export class GenerateDataFromDataShapeOperation extends Operation<Params> {
  name        = "generate-data-from-data-shape";
  description = "Generate synthetic CSV data from a data-shape.yaml statistical fingerprint";
  parameters  = new GenerateDataFromDataShapeParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const tag        = "GenerateDataFromDataShape";
    const inputFile  = path.resolve(params["input-file"]);
    const outputDir  = path.resolve(params["output-dir"]);
    const reportsDir = path.resolve(params["reports-dir"] ?? path.join(outputDir, "_reports"));
    const scaleFactor = params["scale-factor"];
    const seed        = params["seed"];
    const startedAt   = new Date().toISOString();

    if (!fs.existsSync(inputFile)) {
      throw new Error(`Fingerprint file not found: ${inputFile}`);
    }

    this.logger.log(`[${tag}] Reading fingerprint: ${inputFile}`);
    const fp                = readFingerprintFile(inputFile);
    const fingerprintSha256 = sha256File(inputFile);
    this.logger.log(
      `[${tag}] Fingerprint v${fp.version} — ` +
      `${fp.dimensions.length} dimension(s), ${fp.facts.length} fact(s)`,
    );

    if (scaleFactor !== 1.0) {
      this.logger.log(`[${tag}] Scale factor: ${scaleFactor}`);
    }
    if (seed !== undefined) {
      this.logger.log(`[${tag}] Random seed: ${seed}`);
    }

    this.logger.log(`[${tag}] Generating data…`);
    const data = generateData(fp, { scaleFactor, seed });

    this.logger.log(`[${tag}] Writing CSV files to: ${outputDir}`);
    writeDataToCsv(data, outputDir);

    // Summary
    const allTables = [...data.dimensions, ...data.facts];
    for (const table of allTables) {
      this.logger.log(`  → ${table.tableName}.csv (${table.rows.length.toLocaleString()} rows)`);
    }

    const totalRows = allTables.reduce((s, t) => s + t.rows.length, 0);
    const completedAt = new Date().toISOString();

    // ── Security reports ─────────────────────────────────────────────────────
    const rowCounts: Record<string, number> = {};
    for (const t of allTables) rowCounts[t.tableName] = t.rows.length;

    const outputDigest = crypto.createHash("sha256")
      .update(JSON.stringify({ rowCounts, fingerprintSha256, seed, scaleFactor }))
      .digest("hex");

    const outputsResolveWithinScope = allTables.every(
      (t) => fs.existsSync(path.join(outputDir, `${t.tableName}.csv`)),
    );

    writePipelineIsolationReport(reportsDir, {
      operation:   this.name,
      startedAt, completedAt,
      inputs: { fingerprintFile: inputFile, fingerprintSha256, fingerprintVersion: fp.version },
      outputs: {
        path: outputDir,
        kind: "csv-directory",
        artifacts: allTables.map((t) => `${t.tableName}.csv`),
      },
      enforced: {
        noRealDataAccessed:        true,
        outputsResolveWithinScope,
        generatedKeyShapeOk:       true,  // assertGeneratedKeyShape would have thrown
        fkClosureOk:               data.fkClosure.failed.length === 0,
      },
      profileVersion: SECURITY_PROFILE_VERSION,
    });
    writeRunManifest(reportsDir, {
      operation:  this.name,
      startedAt, completedAt,
      seed, scaleFactor,
      fingerprintSha256,
      outputDigest,
      rowCounts,
      profileVersion: SECURITY_PROFILE_VERSION,
    });
    writeIntegrityReport(reportsDir, {
      checkedAt: completedAt,
      tables:    allTables.map((t) => ({
        name: t.tableName, rowCount: t.rows.length, columnCount: t.columns.length,
      })),
      fkClosure:      data.fkClosure,
      profileVersion: SECURITY_PROFILE_VERSION,
    });

    this.logger.log(
      `[${tag}] Done — ${allTables.length} file(s), ` +
      `${totalRows.toLocaleString()} total rows; security reports → ${reportsDir}`,
    );
  }
}
