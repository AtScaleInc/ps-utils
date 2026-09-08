/**
 * AtScaleListModelErrors
 *
 * Validates an SML model against the AtScale engine and reports any problems.
 *
 * SML source — provide exactly one of:
 *   --sml-dir <path>           Local SML directory (CI/CD pre-deploy validation)
 *   --repo-name / --repo-id    Repo already connected in AtScale; clones the
 *                              specified branch (or defaultBranch) to a temp dir
 *
 * Two validation phases run in sequence:
 *
 *   Phase 1 — Structural (always runs)
 *     Parses all SML YAML files and validates cross-references: datasets,
 *     dimensions, level attributes, and model relationships.
 *
 *   Phase 2 — Engine (runs only if Phase 1 passes)
 *     POSTs column-joinability and uniqueness checks to:
 *       POST /wapi/p/catalog/validate-model
 *     Checks come from model relationships (child_parent_key) and level-attribute
 *     key columns (column_unique). Incorrect → error; Warning → warning.
 *
 * Usage (local):
 *   atscale-utils atscale-list-model-errors \
 *     --connection-file connections.yaml \
 *     --atscale-connection-name my_atscale \
 *     --sml-dir ./sml
 *
 * Usage (remote repo):
 *   atscale-utils atscale-list-model-errors \
 *     --connection-file connections.yaml \
 *     --atscale-connection-name my_atscale \
 *     --repo-name ps-example \
 *     --branch main
 */
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { execSync } from "child_process";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, BooleanParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import {
  AtScaleRestClientService,
  AtScaleEnvironment,
} from "../../services/AtScaleRestClientService.js";

// ── Parameters ────────────────────────────────────────────────────────────────

class AtScaleListModelErrorsParamsSet extends ParameterSet {
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
    // ── SML source (one of the two groups is required) ─────────────────────
    new (class extends StringParameter {
      name        = "sml-dir";
      description = "Local SML directory (models/, dimensions/, datasets/). Use for pre-deploy CI/CD validation. Mutually exclusive with --repo-name / --repo-id.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "repo-name";
      description = "Name of a git repository already connected in AtScale. Clones the repo to a temp directory and validates it. Mutually exclusive with --sml-dir.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "repo-id";
      description = "UUID of a git repository already connected in AtScale. Alternative to --repo-name.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "branch";
      description = "Branch to validate when using --repo-name / --repo-id. Defaults to the repository's defaultBranch.";
      required    = false;
    })(),
    // ── Model selection ────────────────────────────────────────────────────
    new (class extends StringParameter {
      name        = "model-name";
      description = "Model label or unique_name to validate (defaults to the first model found)";
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
  "sml-dir"?:    string;
  "repo-name"?:  string;
  "repo-id"?:    string;
  "branch"?:     string;
  "model-name"?: string;
  "insecure"?:   boolean;
};
export type AtScaleListModelErrorsParams = Params;

// ── Resolve AtScale environment ───────────────────────────────────────────────

function resolveAtScaleEnv(
  config: Record<string, any>,
  connectionName: string,
  insecureOverride?: boolean,
): AtScaleEnvironment {
  const connections: Record<string, any> = config.connections ?? {};
  const entry = connections[connectionName];
  if (!entry) throw new Error(`Connection '${connectionName}' not found in connections file`);
  const atscale = entry.atscale;
  if (!atscale) throw new Error(`Connection '${connectionName}' is missing an 'atscale:' block`);
  const url = atscale.url;
  if (!url) throw new Error(`Connection '${connectionName}'.atscale is missing 'url'`);
  let username: string | undefined = atscale.username;
  let password: string | undefined = atscale.password;
  if (atscale.user) {
    const users: Record<string, any> = config.users ?? {};
    const userEntry = users[atscale.user];
    if (userEntry) {
      username ??= userEntry.username;
      password ??= userEntry.password;
    }
  }
  if (!atscale.apiToken) {
    if (!username) throw new Error(`Connection '${connectionName}'.atscale is missing 'username' or 'apiToken'`);
    if (!password) throw new Error(`Connection '${connectionName}'.atscale is missing 'password' or 'apiToken'`);
  }
  return new AtScaleEnvironment({
    baseUrl:       url,
    username,
    password,
    realm:         atscale.realm,
    clientId:      atscale.clientId,
    clientSecret:  atscale.clientSecret,
    authType:      atscale.authType,
    apiToken:      atscale.apiToken,
    sessionCookie: atscale.sessionCookie,
    insecure:      insecureOverride ?? atscale.insecure,
  });
}

// ── SML loading ───────────────────────────────────────────────────────────────

function readYamlDir(dir: string, yaml: YamlService): Map<string, any> {
  const result = new Map<string, any>();
  if (!fs.existsSync(dir)) return result;
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    try {
      const parsed = yaml.readFromFile<any>(path.join(dir, file));
      result.set(path.basename(file, path.extname(file)), parsed);
    } catch (_e) {}
  }
  return result;
}

// ── Phase 1: structural validation ───────────────────────────────────────────

type Problem = {
  phase:     "structural" | "engine";
  severity:  "error" | "warning";
  message:   string;
  location?: string;
};

function validateStructure(
  dimensionsMap:  Map<string, any>,
  datasetsMap:    Map<string, any>,
  connectionsMap: Map<string, any>,
  modelData:      any,
): Problem[] {
  const problems: Problem[] = [];

  // Every dataset must name a connection that exists — an unresolved reference
  // is what sends engine checks to a connection group the instance does not have.
  const connectionNames = new Set<string>();
  for (const [, conn] of connectionsMap) {
    const name = conn.unique_name ?? conn.label;
    if (name) connectionNames.add(name);
  }
  for (const [, ds] of datasetsMap) {
    const dsName = ds.unique_name ?? ds.label ?? "(unnamed)";
    if (!ds.connection_id) {
      problems.push({ phase: "structural", severity: "error", message: `Dataset '${dsName}': missing 'connection_id'`, location: `datasets/${dsName}` });
    } else if (!connectionNames.has(ds.connection_id)) {
      const known = [...connectionNames].join(", ") || "(none)";
      problems.push({ phase: "structural", severity: "error", message: `Dataset '${dsName}': connection_id '${ds.connection_id}' not found in connections/. Known: ${known}`, location: `datasets/${dsName}` });
    }
  }

  const datasetColumns = new Map<string, Set<string>>();
  for (const [, ds] of datasetsMap) {
    const name = ds.unique_name ?? ds.label;
    if (!name) continue;
    datasetColumns.set(
      name,
      new Set((ds.columns ?? []).map((c: any) => c.name).filter(Boolean)),
    );
  }

  const dimLevelAttrs = new Map<string, Map<string, any>>();
  for (const [, dim] of dimensionsMap) {
    const dimName = dim.unique_name ?? dim.label;
    if (!dimName) continue;
    const laMap = new Map<string, any>();
    for (const la of (dim.level_attributes ?? [])) laMap.set(la.unique_name, la);
    dimLevelAttrs.set(dimName, laMap);
  }

  for (const rel of (modelData.relationships ?? [])) {
    const relName     = rel.unique_name ?? "(unnamed)";
    const fromDataset = rel.from?.dataset;

    if (!fromDataset) {
      problems.push({ phase: "structural", severity: "error", message: `Relationship '${relName}': missing from.dataset` });
    } else if (!datasetColumns.has(fromDataset)) {
      problems.push({ phase: "structural", severity: "error", message: `Relationship '${relName}': from.dataset '${fromDataset}' not found`, location: `models/ → ${relName}` });
    } else {
      const cols = datasetColumns.get(fromDataset)!;
      for (const jc of (rel.from?.join_columns ?? [])) {
        if (!cols.has(jc)) {
          problems.push({ phase: "structural", severity: "error", message: `Relationship '${relName}': join_column '${jc}' not found in dataset '${fromDataset}'`, location: `datasets/${fromDataset}` });
        }
      }
    }

    const toDimName   = rel.to?.dimension;
    const toLevelName = rel.to?.level;
    if (!toDimName) {
      problems.push({ phase: "structural", severity: "error", message: `Relationship '${relName}': missing to.dimension` });
    } else {
      const laMap = dimLevelAttrs.get(toDimName);
      if (!laMap) {
        problems.push({ phase: "structural", severity: "error", message: `Relationship '${relName}': to.dimension '${toDimName}' not found`, location: `models/ → ${relName}` });
      } else if (toLevelName && !laMap.has(toLevelName)) {
        problems.push({ phase: "structural", severity: "error", message: `Relationship '${relName}': to.level '${toLevelName}' not found in dimension '${toDimName}'`, location: `dimensions/${toDimName}` });
      }
    }
  }

  for (const [, dim] of dimensionsMap) {
    const dimName = dim.unique_name ?? dim.label ?? "(unnamed)";
    for (const la of (dim.level_attributes ?? [])) {
      const laName  = la.unique_name ?? "(unnamed)";
      const dsName  = la.dataset;
      if (!dsName) continue;
      if (!datasetColumns.has(dsName)) {
        problems.push({ phase: "structural", severity: "error", message: `Dimension '${dimName}' la '${laName}': dataset '${dsName}' not found`, location: `dimensions/${dimName}` });
        continue;
      }
      const cols = datasetColumns.get(dsName)!;
      if (la.name_column && !cols.has(la.name_column)) {
        problems.push({ phase: "structural", severity: "error", message: `Dimension '${dimName}' la '${laName}': name_column '${la.name_column}' not found in '${dsName}'`, location: `dimensions/${dimName}` });
      }
      for (const kc of (la.key_columns ?? [])) {
        if (!cols.has(kc)) {
          problems.push({ phase: "structural", severity: "error", message: `Dimension '${dimName}' la '${laName}': key_column '${kc}' not found in '${dsName}'`, location: `dimensions/${dimName}` });
        }
      }
    }
  }

  return problems;
}

// ── Phase 2: engine checks ───────────────────────────────────────────────────

type CheckColumn = { name: string; type: string; dataType: string };
type CheckSide   = { dsId: string; dsType: string; columns: CheckColumn[] };
type ValidationCheck = {
  id: string; checkType: string;
  from: CheckSide; to: CheckSide;
  connectionId: string; database: string; schema: string; isSnowflake: boolean;
};

function toEngineDataType(smlType: string): string {
  // Map SML/SQL type names to Scala PhysicalType.name values (case-sensitive).
  // See PhysicalType.scala: IntType="Int", LongType="Long", FloatType="Float",
  // DoubleType="Double", FauxDecimalType="Decimal", MaxStringType="String",
  // BooleanType="Boolean", DateType="Date", DateTimeType="DateTime".
  const map: Record<string, string> = {
    int:       "Int",
    integer:   "Int",
    tinyint:   "Int",
    smallint:  "Int",
    bigint:    "Long",
    float:     "Float",
    double:    "Double",
    real:      "Double",
    decimal:   "Decimal",
    numeric:   "Decimal",
    number:    "Decimal",
    boolean:   "Boolean",
    bool:      "Boolean",
    bit:       "Boolean",
    date:      "Date",
    datetime:  "DateTime",
    timestamp: "DateTime",
    string:    "String",
    varchar:   "String",
    nvarchar:  "String",
    char:      "String",
    nchar:     "String",
    text:      "String",
    clob:      "String",
  };
  return map[smlType.toLowerCase()] ?? "String";
}

/**
 * Resolved coordinates for one SML `connection` object.
 *
 * `as_connection` — not `unique_name` — is the name of the connection group as
 * the engine knows it; `unique_name` only identifies the database+schema pair
 * within the repository. Sending the wrong one yields a 500 with
 * "ConnectionGroup ConnectionGroupIdentity(<name>) not found".
 */
type ConnectionInfo = {
  connectionId: string;
  database:     string;
  schema:       string;
  isSnowflake:  boolean;
};

/** Index SML connection objects by their `unique_name` (what datasets reference). */
function buildConnectionLookup(connectionsMap: Map<string, any>): Map<string, ConnectionInfo> {
  const lookup = new Map<string, ConnectionInfo>();
  for (const [, conn] of connectionsMap) {
    const key = conn.unique_name ?? conn.label;
    if (!key) continue;
    lookup.set(key, {
      connectionId: conn.as_connection ?? conn.unique_name ?? "",
      database:     conn.database ?? "",
      schema:       conn.schema ?? "",
      isSnowflake:  (conn.connection_type ?? "").toLowerCase() === "snowflake",
    });
  }
  return lookup;
}

function buildEngineChecks(
  modelData: any, dimensionsMap: Map<string, any>, datasetsMap: Map<string, any>,
  connectionLookup: Map<string, ConnectionInfo>,
): { checks: ValidationCheck[]; problems: Problem[] } {
  const checks: ValidationCheck[] = [];
  const problems: Problem[] = [];

  const datasetColTypes = new Map<string, Map<string, string>>();
  // Dataset unique_name → the `unique_name` of the connection object it names.
  const datasetConnection = new Map<string, string>();
  for (const [, ds] of datasetsMap) {
    const name = ds.unique_name ?? ds.label;
    if (!name) continue;
    const colMap = new Map<string, string>();
    for (const col of (ds.columns ?? [])) colMap.set(col.name, toEngineDataType(col.data_type ?? "string"));
    datasetColTypes.set(name, colMap);
    if (ds.connection_id) datasetConnection.set(name, ds.connection_id);
  }

  /**
   * Resolve the connection a dataset sits on. Reports a problem and returns
   * undefined when the dataset names no connection or an unknown one — a check
   * built on a guessed connection is worse than no check, since the engine
   * either rejects it or silently validates the wrong tables.
   */
  const connectionFor = (dsName: string, context: string): ConnectionInfo | undefined => {
    const connName = datasetConnection.get(dsName);
    if (!connName) {
      problems.push({ phase: "structural", severity: "error", message: `${context}: dataset '${dsName}' has no 'connection_id'`, location: `datasets/${dsName}` });
      return undefined;
    }
    const info = connectionLookup.get(connName);
    if (!info) {
      const known = [...connectionLookup.keys()].join(", ") || "(none)";
      problems.push({ phase: "structural", severity: "error", message: `${context}: dataset '${dsName}' references connection '${connName}', which is not defined in connections/. Known: ${known}`, location: `datasets/${dsName}` });
      return undefined;
    }
    return info;
  };

  const dimLaLookup = new Map<string, Map<string, any>>();
  for (const [, dim] of dimensionsMap) {
    const dimName = dim.unique_name ?? dim.label;
    if (!dimName) continue;
    const laMap = new Map<string, any>();
    for (const la of (dim.level_attributes ?? [])) laMap.set(la.unique_name, la);
    dimLaLookup.set(dimName, laMap);
  }

  for (const rel of (modelData.relationships ?? [])) {
    const fromDataset = rel.from?.dataset;
    const joinCols    = rel.from?.join_columns ?? [];
    const toDimName   = rel.to?.dimension;
    const toLevelName = rel.to?.level;
    if (!fromDataset || joinCols.length === 0 || !toDimName || !toLevelName) continue;
    const laMap = dimLaLookup.get(toDimName);
    if (!laMap) continue;
    const la = laMap.get(toLevelName);
    if (!la) continue;
    const toDataset = la.dataset;
    const keyCols   = la.key_columns ?? [];
    if (!toDataset || keyCols.length === 0) continue;

    const relName  = rel.unique_name ?? "(unnamed)";
    const fromConn = connectionFor(fromDataset, `Relationship '${relName}'`);
    const toConn   = connectionFor(toDataset,   `Relationship '${relName}'`);
    if (!fromConn || !toConn) continue;
    // The engine joins both sides inside a single connection group, so a
    // relationship spanning two of them cannot be checked in one request.
    if (fromConn.connectionId !== toConn.connectionId || fromConn.database !== toConn.database || fromConn.schema !== toConn.schema) {
      problems.push({
        phase: "engine", severity: "warning",
        message: `Relationship '${relName}': '${fromDataset}' and '${toDataset}' are on different connections (${fromConn.connectionId}/${fromConn.database}.${fromConn.schema} vs ${toConn.connectionId}/${toConn.database}.${toConn.schema}) — skipping joinability check`,
        location: `models/ → ${relName}`,
      });
      continue;
    }

    const fromTypes = datasetColTypes.get(fromDataset) ?? new Map();
    const toTypes   = datasetColTypes.get(toDataset) ?? new Map();
    checks.push({
      id: randomUUID(), checkType: "child_parent_key",
      from: { dsId: fromDataset, dsType: "data_set_table", columns: joinCols.map((c: string) => ({ name: c, type: "simple-column", dataType: fromTypes.get(c) ?? "varchar" })) },
      to:   { dsId: toDataset,   dsType: "data_set_table", columns: keyCols.map((c: string)  => ({ name: c, type: "simple-column", dataType: toTypes.get(c) ?? "varchar" })) },
      connectionId: fromConn.connectionId, database: fromConn.database, schema: fromConn.schema, isSnowflake: fromConn.isSnowflake,
    });
  }

  const seen = new Set<string>();
  for (const [, dim] of dimensionsMap) {
    const dimName = dim.unique_name ?? dim.label ?? "(unnamed)";
    for (const la of (dim.level_attributes ?? [])) {
      if (!la.is_unique_key) continue;  // only check PK / unique-key level attributes
      const dsName  = la.dataset;
      const keyCols = la.key_columns ?? [];
      if (!dsName || keyCols.length === 0) continue;
      // Use a single check with all key columns together — the engine computes
      // combined cardinality vs row count, which is correct for composite PKs.
      const key = `${dsName}.[${keyCols.join(",")}]`;
      if (seen.has(key)) continue;
      seen.add(key);
      const conn = connectionFor(dsName, `Dimension '${dimName}' la '${la.unique_name ?? "(unnamed)"}'`);
      if (!conn) continue;
      const columns = keyCols.map((kc: string) => ({ name: kc, type: "simple-column", dataType: datasetColTypes.get(dsName)?.get(kc) ?? "String" }));
      checks.push({
        id: randomUUID(), checkType: "column_unique",
        from: { dsId: dsName, dsType: "data_set_table", columns },
        to:   { dsId: dsName, dsType: "data_set_table", columns },
        connectionId: conn.connectionId, database: conn.database, schema: conn.schema, isSnowflake: conn.isSnowflake,
      });
    }
  }

  return { checks, problems };
}

// ── Operation ─────────────────────────────────────────────────────────────────

export class AtScaleListModelErrorsOperation extends Operation<Params> {
  name        = "atscale-list-model-errors";
  description = "Validate an SML model and list structural and engine-level problems";
  parameters  = new AtScaleListModelErrorsParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const yaml       = this.services.get<YamlService>("yaml");
    const atScaleSvc = this.services.get<AtScaleRestClientService>("atscale-rest");

    const config = yaml.readFromFile<Record<string, any>>(params["connection-file"]);
    const env    = resolveAtScaleEnv(config, params["atscale-connection-name"], params["insecure"]);

    // ── Resolve SML directory ────────────────────────────────────────────────
    const hasLocal = Boolean(params["sml-dir"]);
    const hasRemote = Boolean(params["repo-name"] || params["repo-id"]);

    if (hasLocal && hasRemote) {
      throw new Error("Provide either --sml-dir OR --repo-name/--repo-id, not both.");
    }
    if (!hasLocal && !hasRemote) {
      throw new Error("Provide either --sml-dir (local path) or --repo-name/--repo-id (connected AtScale repo).");
    }

    let smlDir: string;
    let tempDir: string | undefined;

    if (hasLocal) {
      smlDir = path.resolve(params["sml-dir"]!);
      if (!fs.existsSync(smlDir)) throw new Error(`SML directory not found: ${smlDir}`);
    } else {
      // Fetch repo info from AtScale and clone
      this.logger.verbose("Fetching repo list from AtScale…");
      const repos = await atScaleSvc.listRepos(env);

      let repo: { id: string; name: string; url: string; defaultBranch?: string | null } | undefined;
      if (params["repo-id"]) {
        repo = repos.find(r => r.id === params["repo-id"]);
        if (!repo) throw new Error(`Repo with id '${params["repo-id"]}' not found in AtScale.`);
      } else {
        repo = repos.find(r => r.name === params["repo-name"]);
        if (!repo) {
          const names = repos.map(r => r.name).join(", ") || "(none)";
          throw new Error(`Repo '${params["repo-name"]}' not found in AtScale. Available: ${names}`);
        }
      }

      const branch = params["branch"] ?? (repo as any).defaultBranch ?? "main";
      this.logger.info(`Cloning repo '${repo.name}' branch '${branch}' from ${repo.url}…`);

      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atscale-sml-"));
      try {
        execSync(
          `git clone --depth 1 --branch ${branch} ${repo.url} ${tempDir}`,
          { stdio: "pipe" },
        );
      } catch (err: any) {
        const msg = err.stderr?.toString() ?? err.message;
        throw new Error(`Failed to clone repo '${repo.name}': ${msg}`);
      }

      // SML may be at repo root or in a sub-directory — try common locations
      const candidates = [
        tempDir,
        path.join(tempDir, "sml"),
        path.join(tempDir, "catalog"),
        path.join(tempDir, "model"),
      ];
      smlDir = candidates.find(d => fs.existsSync(path.join(d, "models"))) ?? tempDir;
      this.logger.verbose(`Using SML directory: ${smlDir}`);
    }

    try {
      await this.validate(params, env, atScaleSvc, yaml, smlDir);
    } finally {
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        this.logger.verbose(`Cleaned up temp dir ${tempDir}`);
      }
    }
  }

  private async validate(
    params: Params,
    env: AtScaleEnvironment,
    atScaleSvc: AtScaleRestClientService,
    yaml: YamlService,
    smlDir: string,
  ): Promise<void> {
    const modelsMap     = readYamlDir(path.join(smlDir, "models"),      yaml);
    const dimensionsMap = readYamlDir(path.join(smlDir, "dimensions"),  yaml);
    const datasetsMap   = readYamlDir(path.join(smlDir, "datasets"),    yaml);
    const connectionsMap = readYamlDir(path.join(smlDir, "connections"), yaml);

    this.logger.verbose(`Loaded ${modelsMap.size} model(s), ${dimensionsMap.size} dimension(s), ${datasetsMap.size} dataset(s)`);

    // Select model
    let modelData: any;
    if (params["model-name"]) {
      for (const [, m] of modelsMap) {
        if (m.unique_name === params["model-name"] || m.label === params["model-name"]) {
          modelData = m; break;
        }
      }
      if (!modelData) throw new Error(`Model '${params["model-name"]}' not found in ${smlDir}/models/`);
    } else {
      const first = modelsMap.values().next();
      if (first.done) throw new Error(`No model files found in ${smlDir}/models/`);
      modelData = first.value;
    }

    const modelLabel = modelData.label ?? modelData.unique_name ?? "(unnamed)";
    this.logger.info(`Validating model: ${modelLabel}`);

    const allProblems: Problem[] = [];

    // Phase 1: structural
    this.logger.verbose("Phase 1: structural validation…");
    const structuralErrors = validateStructure(dimensionsMap, datasetsMap, connectionsMap, modelData);
    allProblems.push(...structuralErrors);

    if (structuralErrors.length > 0) {
      this.logger.info(`Phase 1 found ${structuralErrors.length} structural problem(s). Skipping Phase 2.`);
    } else {
      this.logger.verbose("Phase 1 passed — running Phase 2 engine validation…");

      const connectionLookup = buildConnectionLookup(connectionsMap);
      this.logger.verbose(`Loaded ${connectionLookup.size} connection(s): ${[...connectionLookup.keys()].join(", ") || "(none)"}`);

      const { checks, problems: checkProblems } = buildEngineChecks(modelData, dimensionsMap, datasetsMap, connectionLookup);
      allProblems.push(...checkProblems);
      this.logger.verbose(`Built ${checks.length} engine check(s).`);

      if (checks.length > 0) {
        // Each check carries its own connection group, database and schema —
        // one request per distinct triple, since validate-model takes a single
        // set for the whole batch.
        const byConnection = new Map<string, ValidationCheck[]>();
        for (const check of checks) {
          const key = `${check.connectionId} ${check.database} ${check.schema}`;
          if (!byConnection.has(key)) byConnection.set(key, []);
          byConnection.get(key)!.push(check);
        }

        for (const connChecks of byConnection.values()) {
          const { connectionId: cid, database, schema } = connChecks[0];
          this.logger.verbose(`Phase 2: POSTing ${connChecks.length} check(s) for connectionId='${cid}' ${database}.${schema}`);
          try {
            const result = await atScaleSvc.validateModel(env, { connectionId: cid, database, schema, checks: connChecks });
            const checkById = new Map(connChecks.map(c => [c.id, c]));
            for (const cr of (result.checks ?? [])) {
              if (/^(correct|unknown)$/i.test(cr.result ?? "")) continue;
              const check    = checkById.get(cr.id);
              const severity = /^warning$/i.test(cr.result ?? "") ? "warning" : "error";
              const from     = check?.from.dsId ?? cr.id;
              const to       = check?.to.dsId ?? "";
              const cols     = check?.from.columns.map(c => c.name).join(", ") ?? "";
              allProblems.push({
                phase: "engine", severity,
                message:  `${cr.result}: ${check?.checkType ?? "check"} on '${from}' [${cols}]` + (to && to !== from ? ` → '${to}'` : ""),
                location: `connectionId: ${cid}`,
              });
            }
          } catch (err: any) {
            allProblems.push({ phase: "engine", severity: "warning", message: `Engine validation failed for connectionId='${cid}': ${err?.message ?? err}` });
          }
        }
      }
    }

    // Output
    if (allProblems.length === 0) {
      this.logger.log(`✓ No problems found in model '${modelLabel}'`);
      process.stdout.write(JSON.stringify({ model: modelLabel, problems: [] }, null, 2) + "\n");
      return;
    }

    const errors   = allProblems.filter(p => p.severity === "error");
    const warnings = allProblems.filter(p => p.severity === "warning");
    this.logger.log(`Model '${modelLabel}': ${errors.length} error(s), ${warnings.length} warning(s)`);
    for (const p of allProblems) {
      const tag = p.severity === "error" ? "ERROR" : "WARN ";
      const loc = p.location ? ` [${p.location}]` : "";
      this.logger.log(`  [${tag}][${p.phase}]${loc} ${p.message}`);
    }
    process.stdout.write(JSON.stringify({ model: modelLabel, problems: allProblems, summary: { errors: errors.length, warnings: warnings.length } }, null, 2) + "\n");
  }
}
