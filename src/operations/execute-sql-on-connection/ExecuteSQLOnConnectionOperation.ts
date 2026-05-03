/**
 * ExecuteSQLOnConnection
 *
 * Reads a SQL file, splits it into individual statements, and executes each
 * one against a named connection in the connections.yaml file.
 *
 * Suitable for DDL (CREATE TABLE, DROP TABLE, ALTER TABLE, CREATE VIEW, …)
 * as well as DML (INSERT, UPDATE, DELETE) and mixed files.
 *
 * Statement splitting handles:
 *   - Single-quoted string literals  ('hello; world')
 *   - Double-quoted identifiers       ("My Column")
 *   - Line comments                   -- ...
 *   - Block comments                  /* ... *\/
 *   - Semicolons as statement terminators
 *   - Trailing statement with no terminating semicolon
 */
import fs from "fs";
import path from "path";
import { Operation } from "../Operation.js";
import { BooleanParameter, ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import { SqlService, type ConnectionConfig } from "../../services/SqlService.js";

// ----------------------------------------------------------
// Parameters
// ----------------------------------------------------------

class ExecuteSQLOnConnectionParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name        = "sql-file";
      description = "Path to the SQL file to execute";
      required    = true;
    })(),
    new (class extends StringParameter {
      name         = "connection-file";
      description  = "Path to the connections.yaml file";
      required     = false;
      defaultValue = "connections.yaml";
    })(),
    new (class extends StringParameter {
      name        = "connection-name";
      description = "Name of the connection in the connections file";
      required    = true;
    })(),
    new (class extends StringParameter {
      name         = "on-error";
      description  = 'Behaviour when a statement fails: "stop" (default) or "continue"';
      required     = false;
      defaultValue = "stop";
    })(),
    new (class extends BooleanParameter {
      name         = "dry-run";
      description  = "Print each statement without executing it. Pass true/false or use as a standalone flag.";
      required     = false;
      defaultValue = false;
      isFlag       = true;
    })(),
  ];
}

type Params = {
  "sql-file":        string;
  "connection-file": string;
  "connection-name": string;
  "on-error":        string;
  "dry-run":         boolean;
};
export type ExecuteSQLOnConnectionParams = Params;

// ----------------------------------------------------------
// SQL statement splitter
// ----------------------------------------------------------

/**
 * Split a SQL source string into individual statements, respecting:
 *   - String literals (single-quoted, with '' escaping)
 *   - Quoted identifiers (double-quoted)
 *   - Line comments (--)
 *   - Block comments (/* *\/)
 *
 * Statements are separated by semicolons.  A trailing statement without
 * a terminating semicolon is included if non-empty.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];

    // Block comment: /* ... */
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < len && !(sql[i] === "*" && sql[i + 1] === "/")) {
        i++;
      }
      i += 2; // consume closing */
      continue;
    }

    // Line comment: -- ...
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < len && sql[i] !== "\n") {
        i++;
      }
      continue;
    }

    // Single-quoted string literal: '...' with '' as escaped quote
    if (ch === "'") {
      current += ch;
      i++;
      while (i < len) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += "''";
          i += 2;
        } else if (sql[i] === "'") {
          current += "'";
          i++;
          break;
        } else {
          current += sql[i];
          i++;
        }
      }
      continue;
    }

    // Double-quoted identifier: "..."
    if (ch === '"') {
      current += ch;
      i++;
      while (i < len && sql[i] !== '"') {
        current += sql[i];
        i++;
      }
      if (i < len) {
        current += '"';
        i++;
      }
      continue;
    }

    // Statement terminator
    if (ch === ";") {
      const stmt = current.trim();
      if (stmt.length > 0) {
        statements.push(stmt);
      }
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  // Trailing statement without a terminating semicolon
  const last = current.trim();
  if (last.length > 0) {
    statements.push(last);
  }

  return statements;
}

// ----------------------------------------------------------
// Operation
// ----------------------------------------------------------

export class ExecuteSQLOnConnectionOperation extends Operation<Params> {
  name        = "execute-sql-on-connection";
  description = "Execute a SQL file against a named database connection";
  parameters  = new ExecuteSQLOnConnectionParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const yaml    = this.services.get<YamlService>("yaml");
    const sqlSvc  = this.services.get<SqlService>("sql");

    const sqlFile       = path.resolve(params["sql-file"]);
    const onError       = (params["on-error"] ?? "stop").toLowerCase();
    const dryRun        = params["dry-run"];

    // ---- Read and parse the SQL file ----
    if (!fs.existsSync(sqlFile)) {
      throw new Error(`SQL file not found: ${sqlFile}`);
    }

    const source     = fs.readFileSync(sqlFile, "utf8");
    const statements = splitStatements(source);

    if (statements.length === 0) {
      this.logger.info("No statements found in file — nothing to execute.");
      return;
    }

    this.logger.info(
      `Parsed ${statements.length} statement(s) from ${path.basename(sqlFile)}`,
    );

    if (dryRun) {
      this.logger.info("Dry-run mode — no statements will be executed.\n");
      for (let n = 0; n < statements.length; n++) {
        this.logger.log(`-- [${n + 1}/${statements.length}] -----------------`);
        this.logger.log(statements[n]);
      }
      return;
    }

    // ---- Connect ----
    const config = yaml.readFromFile<ConnectionConfig>(params["connection-file"]);
    const conn   = await sqlSvc.connect(config, params["connection-name"]);

    this.logger.info(
      `Connected to "${params["connection-name"]}" — executing ${statements.length} statement(s)…\n`,
    );

    // ---- Execute statements ----
    let succeeded = 0;
    let failed    = 0;

    try {
      for (let n = 0; n < statements.length; n++) {
        const stmt    = statements[n];
        const preview = stmt.length > 80 ? stmt.slice(0, 80).replace(/\s+/g, " ") + "…" : stmt.replace(/\s+/g, " ");
        const label   = `[${n + 1}/${statements.length}]`;

        try {
          const updateCount = await sqlSvc.execute(conn, stmt);
          succeeded++;
          const countNote = updateCount > 0 ? ` (${updateCount} row(s) affected)` : "";
          this.logger.info(`${label} OK${countNote}  ${preview}`);
        } catch (err) {
          failed++;
          const message = err instanceof Error ? err.message : String(err);
          this.logger.log(`${label} FAILED  ${preview}`);
          this.logger.log(`         ${message}`);

          if (onError === "stop") {
            throw new Error(
              `Execution stopped at statement ${n + 1} of ${statements.length}: ${message}`,
            );
          }
          // onError === "continue" — keep going
        }
      }
    } finally {
      await sqlSvc.close(conn);
    }

    // ---- Summary ----
    this.logger.info(
      `\nDone — ${succeeded} succeeded, ${failed} failed` +
      (failed > 0 && onError === "continue" ? " (errors skipped)" : ""),
    );

    if (failed > 0 && onError === "stop") {
      // Already thrown above; this line is unreachable but guards future changes.
      throw new Error(`${failed} statement(s) failed.`);
    }
  }
}
