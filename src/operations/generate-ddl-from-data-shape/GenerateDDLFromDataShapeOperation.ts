/**
 * GenerateDDLFromDataShape
 *
 * Reads a statistical fingerprint file (data-shape.yaml) produced by
 * extract-data-shape-from-connection and emits CREATE TABLE DDL statements
 * that faithfully reproduce the structural and type information implied by
 * the fingerprint.
 *
 * No database connection is required.  The operation is the inverse of
 * extract-data-shape-from-connection in the sense that it reconstructs a
 * schema from the fingerprint rather than producing a fingerprint from a
 * schema.
 *
 * Output:
 *   <output-file>   (default: stdout)
 *
 * Dialect support:
 *   ansi (default), postgresql, snowflake, mysql, bigquery
 *
 * See STATISTICS.md §Phase 7 for the reconstruction algorithm.
 */
import fs   from "fs";
import path from "path";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger }          from "../../logging.js";
import { readFingerprintFile }  from "../../statistics/fingerprint.js";
import { generateDdl, type SqlDialect } from "../../statistics/ddl-generator.js";

// ─── Parameters ────────────────────────────────────────────────────────────────

class GenerateDDLFromDataShapeParams extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name         = "input-file";
      description  = "Path to the data-shape.yaml fingerprint file (default: data-shape.yaml)";
      required     = false;
      defaultValue = "data-shape.yaml";
    })(),
    new (class extends StringParameter {
      name        = "output-file";
      description = "Output path for the generated DDL.  Omit to write to stdout.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name         = "dialect";
      description  = "SQL dialect: ansi (default), postgresql, snowflake, mysql, bigquery";
      required     = false;
      defaultValue = "ansi";
    })(),
  ];
}

type Params = {
  "input-file":   string;
  "output-file"?: string;
  "dialect":      string;
};

// ─── Operation ────────────────────────────────────────────────────────────────

export class GenerateDDLFromDataShapeOperation extends Operation<Params> {
  name        = "generate-ddl-from-data-shape";
  description = "Generate CREATE TABLE DDL from a data-shape.yaml statistical fingerprint";
  parameters  = new GenerateDDLFromDataShapeParams();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const tag       = "GenerateDDLFromDataShape";
    const inputFile = path.resolve(params["input-file"]);
    const dialect   = (params["dialect"] ?? "ansi") as SqlDialect;

    // ── Read fingerprint ───────────────────────────────────────────────────────
    if (!fs.existsSync(inputFile)) {
      throw new Error(`Fingerprint file not found: ${inputFile}`);
    }
    this.logger.log(`[${tag}] Reading fingerprint: ${inputFile}`);
    const fingerprint = readFingerprintFile(inputFile);

    this.logger.log(
      `[${tag}] Fingerprint v${fingerprint.version} — ` +
      `${fingerprint.dimensions.length} dimension(s), ` +
      `${fingerprint.facts.length} fact(s)`,
    );

    // ── Generate DDL ───────────────────────────────────────────────────────────
    this.logger.log(`[${tag}] Generating DDL (dialect: ${dialect})…`);
    const ddl = generateDdl(fingerprint, { dialect });

    // ── Write output ───────────────────────────────────────────────────────────
    if (params["output-file"]) {
      const outputPath = path.resolve(params["output-file"]);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, ddl, "utf8");
      this.logger.log(`[${tag}] Wrote DDL to: ${outputPath}`);
    } else {
      process.stdout.write(ddl);
    }

    this.logger.log(
      `[${tag}] Done — ` +
      `${fingerprint.dimensions.length} dimension table(s), ` +
      `${fingerprint.facts.length} fact table(s)`,
    );
  }
}
