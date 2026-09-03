/**
 * @atscale-ps/ps-utils — public library API
 *
 * Each exported function corresponds to one CLI operation.
 * Parameters use camelCase keys.  Fields with library defaults are optional.
 * Every file/directory parameter accepts a Node.js stream in place of a path:
 *   - input file  → Readable (raw file contents)
 *   - input dir   → Readable (ZIP archive of the directory)
 *   - output file → Writable (receives file contents)
 *   - output dir  → Writable (receives a ZIP archive)
 */

import { buildRegistry } from "./operations/index.js";
import { buildLogger } from "./logging.js";
import type { Operation } from "./operations/Operation.js";
import {
  resolveIO,
  type FileInput,
  type DirInput,
  type FileOutput,
  type DirOutput,
} from "./lib/streams.js";

export type { Logger, LoggerOptions } from "./logging.js";
export type { FileInput, DirInput, FileOutput, DirOutput } from "./lib/streams.js";

// ── Options ───────────────────────────────────────────────────────────────────

export interface LibraryOptions {
  logger?: import("./logging.js").Logger;
}

// ── Internals ─────────────────────────────────────────────────────────────────

function cc2kebab(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k.replace(/([A-Z])/g, m => `-${m.toLowerCase()}`)] = v;
  }
  return out;
}

async function run<T extends Record<string, unknown>>(
  name: string,
  params: T,
  options: LibraryOptions,
): Promise<void> {
  const logger = options.logger ?? buildLogger({});
  const registry = await buildRegistry(logger);
  const op = registry.get(name);
  if (!op) throw new Error(`Operation not found: ${name}`);
  await (op as Operation<T>).run(params);
}

// ── Model Extraction ──────────────────────────────────────────────────────────

export type ExtractModelFromAtScaleParams = {
  model: string;
  connectionFile: FileInput;
  connectionName: string;
  outputModelFile?: FileOutput;
};

export async function extractModelFromAtScale(p: ExtractModelFromAtScaleParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["connectionFile"],
    outputFiles: ["outputModelFile"],
  });
  try {
    await run("extract-model-from-atscale", cc2kebab(params), o);
    await flush();
  } finally { cleanup(); }
}

export type ExtractModelFromSMLParams = {
  smlDir: DirInput;
  modelName?: string;
  connectionName?: string;
  outputModelFile?: FileOutput;
};

export async function extractModelFromSML(p: ExtractModelFromSMLParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputDirs: ["smlDir"],
    outputFiles: ["outputModelFile"],
  });
  try {
    await run("extract-model-from-sml", cc2kebab(params), o);
    await flush();
  } finally { cleanup(); }
}

// ── SML Creation and Manipulation ─────────────────────────────────────────────

export type ExecuteSQLOnConnectionParams = {
  sqlFile: FileInput;
  connectionName: string;
  connectionFile?: FileInput;  // default: "connections.yaml"
  onError?: string;     // default: "stop"
  dryRun?: boolean;    // default: false
};

export async function executeSQLOnConnection(p: ExecuteSQLOnConnectionParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["sqlFile", "connectionFile"],
  });
  try {
    await run("execute-sql-on-connection", Object.assign({
      "connection-file": "connections.yaml",
      "on-error": "stop",
      "dry-run": false,
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type ExtractDDLFromConnectionParams = {
  connectionName: string;
  schema: string;
  connectionFile?: FileInput;  // default: "connections.yaml"
  tables?: string;
  outputFile?: FileOutput;
};

export async function extractDDLFromConnection(p: ExtractDDLFromConnectionParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["connectionFile"],
    outputFiles: ["outputFile"],
  });
  try {
    await run("extract-ddl-from-connection", Object.assign({
      "connection-file": "connections.yaml",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type GenerateSMLFromConnectionParams = {
  connectionName: string;
  modelName: string;
  outputDir: DirOutput;
  connectionFile?: FileInput;   // default: "connections.yaml"
  smlConfigFile?: FileInput;   // default: "sml.style.yaml"
  schema?: string;
  catalogName?: string;
  piiSeverity?: string;
  sampleSize?: number;
  factTables?: string;
  camelCaseFiles?: boolean;
  camelCaseMeasures?: boolean;
  minHierarchiesPerDim?: number;
  maxHierarchiesPerDim?: number;
};

export async function generateSMLFromConnection(p: GenerateSMLFromConnectionParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["connectionFile", "smlConfigFile"],
    outputDirs: ["outputDir"],
  });
  try {
    await run("generate-sml-from-connection", Object.assign({
      "connection-file": "connections.yaml",
      "sml-config-file": "sml.style.yaml",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type GenerateSMLFromDDLParams = {
  ddlFile: FileInput;
  outputDir: DirOutput;
  connectionName?: string;    // default: "my_connection"
  smlConfigFile?: FileInput; // default: "sml.style.yaml"
  modelName?: string;
  catalogName?: string;
  piiSeverity?: string;
  schema?: string;
  database?: string;
  dialect?: string;
  factTables?: string;
  camelCaseFiles?: boolean;
  camelCaseMeasures?: boolean;
  minHierarchiesPerDim?: number;
  maxHierarchiesPerDim?: number;
};

export async function generateSMLFromDDL(p: GenerateSMLFromDDLParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["ddlFile", "smlConfigFile"],
    outputDirs: ["outputDir"],
  });
  try {
    await run("generate-sml-from-ddl", Object.assign({
      "connection-name": "my_connection",
      "sml-config-file": "sml.style.yaml",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type GenerateSMLFromXMLParams = {
  xmlFile: FileInput;
  outputDir: DirOutput;
  connectionName?: string;
  connectionType?: string;
  catalogName?: string;
  connectionDb?: string;
  connectionSchema?: string;
};

export async function generateSMLFromXML(p: GenerateSMLFromXMLParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["xmlFile"],
    outputDirs: ["outputDir"],
  });
  try {
    await run("generate-sml-from-xml", cc2kebab(params), o);
    await flush();
  } finally { cleanup(); }
}

export type GenerateSharedModelPlanParams = {
  /** Comma-separated paths, or a Readable ZIP whose top-level folders are the directories. */
  inputDirs: DirInput;
  outputDir: DirOutput;
  threshold?: number;  // default: 0.5
  maxPerSubject?: number;  // default: 3
};

export async function generateSharedModelPlan(p: GenerateSharedModelPlanParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputDirLists: ["inputDirs"],
    outputDirs: ["outputDir"],
  });
  try {
    await run("generate-shared-model-plan", Object.assign({
      threshold: 0.5,
      "max-per-subject": 3,
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type GenerateSMLDocsParams = {
  smlDir:       DirInput;
  outputFile?:  string;   // default: "README.md" (relative → written inside smlDir)
  title?:       string;
};

export async function generateSMLDocs(p: GenerateSMLDocsParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputDirs: ["smlDir"],
  });
  try {
    await run("generate-sml-docs", Object.assign({
      "output-file": "README.md",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type ApplySharedModelPlanOptionParams = {
  planFile: FileInput;
  sharedDir: DirOutput;
  removeSources?: boolean;  // default: false
  dryRun?: boolean;  // default: false
};

export async function applySharedModelPlanOption(p: ApplySharedModelPlanOptionParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["planFile"],
    outputDirs: ["sharedDir"],
  });
  try {
    await run("apply-shared-model-plan-option", Object.assign({
      "remove-sources": false,
      "dry-run": false,
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type GenerateDDLFromAtScaleParams = {
  atscaleConnectionName: string;
  dataSourceName: string;
  database: string;
  schema: string;
  connectionFile?: FileInput;  // default: "connections.yaml"
  tables?: string;
  outputFile?: FileOutput;
  insecure?: boolean;
};

export async function generateDDLFromAtScale(p: GenerateDDLFromAtScaleParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["connectionFile"],
    outputFiles: ["outputFile"],
  });
  try {
    await run("generate-ddl-from-atscale", Object.assign({
      "connection-file": "connections.yaml",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type GenerateMetricsFromModelParams = {
  modelFile: FileInput;
  smlConfigFile?: FileInput;  // default: "sml.style.yaml"
  format?: string;     // default: "text"
  modelName?: string;
  maxSuggestions?: number;
  minScore?: number;
  includeTuples?: boolean;
  outputFile?: FileOutput;
};

export async function generateMetricsFromModel(p: GenerateMetricsFromModelParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["modelFile", "smlConfigFile"],
    outputFiles: ["outputFile"],
  });
  try {
    await run("generate-metrics-from-model", Object.assign({
      "sml-config-file": "sml.style.yaml",
      format: "text",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type EchoConnectionMetadataParams = {
  connectionName: string;
  connectionFile?: FileInput;  // default: "connections.yaml"
  schema?: string;
};

export async function echoConnectionMetadata(p: EchoConnectionMetadataParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["connectionFile"],
  });
  try {
    await run("echo-connection-metadata", Object.assign({
      "connection-file": "connections.yaml",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

// ── Synthetic Data Generation ─────────────────────────────────────────────────

export type ExtractDataShapeFromConnectionParams = {
  connectionName: string;
  /** Path to SML output directory or model.yml, or a Readable ZIP of the directory. */
  smlPath: DirInput;
  connectionFile?: FileInput;  // default: "connections.yaml"
  outputFile?: FileOutput; // default: "data-shape.yaml"
  targetFactRows?: number;     // default: 100000
  targetColumnRows?: number;     // default: 10000
  tablesample?: boolean;    // default: true
  serial?: boolean;    // default: false
  preserveMetadata?: boolean;    // default: false
};

export async function extractDataShapeFromConnection(p: ExtractDataShapeFromConnectionParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["connectionFile"],
    inputDirs: ["smlPath"],
    outputFiles: ["outputFile"],
  });
  try {
    await run("extract-data-shape-from-connection", Object.assign({
      "connection-file": "connections.yaml",
      "output-file": "data-shape.yaml",
      "target-fact-rows": 100_000,
      "target-column-rows": 10_000,
      tablesample: true,
      serial: false,
      "preserve-meta-data": false,
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type GenerateDDLFromDataShapeParams = {
  inputFile?: FileInput;  // default: "data-shape.yaml"
  dialect?: string;     // default: "ansi"
  outputFile?: FileOutput;
  preserveMetadata?: boolean;    // default: false
};

export async function generateDDLFromDataShape(p: GenerateDDLFromDataShapeParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["inputFile"],
    outputFiles: ["outputFile"],
  });
  try {
    await run("generate-ddl-from-data-shape", Object.assign({
      "input-file": "data-shape.yaml",
      dialect: "ansi",
      "preserve-meta-data": false,
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type GenerateDataFromDataShapeParams = {
  inputFile?: FileInput;  // default: "data-shape.yaml"
  outputDir?: DirOutput;  // default: "data"
  scaleFactor?: number;     // default: 1.0
  seed?: number;
  preserveMetadata?: boolean;    // default: false
};

export async function generateDataFromDataShape(p: GenerateDataFromDataShapeParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["inputFile"],
    outputDirs: ["outputDir"],
  });
  try {
    await run("generate-data-from-data-shape", Object.assign({
      "input-file": "data-shape.yaml",
      "output-dir": "data",
      "scale-factor": 1.0,
      "preserve-meta-data": false,
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type GenerateDataFromDataShapeToConnectionParams = {
  connectionName: string;
  inputFile?: FileInput;  // default: "data-shape.yaml"
  connectionFile?: FileInput;  // default: "connections.yaml"
  scaleFactor?: number;     // default: 1.0
  createTables?: boolean;    // default: false
  dropIfExists?: boolean;    // default: false
  dialect?: string;     // auto-detected from connection config; falls back to "ansi"
  batchSize?: number;     // default: 500
  reportsDir?: string;     // default: "_reports"
  seed?: number;
  schema?: string;
  preserveMetadata?: boolean;   // default: false
};

export async function generateDataFromDataShapeToConnection(p: GenerateDataFromDataShapeToConnectionParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["inputFile", "connectionFile"],
  });
  try {
    await run("generate-data-from-data-shape-to-connection", Object.assign({
      "input-file": "data-shape.yaml",
      "connection-file": "connections.yaml",
      "scale-factor": 1.0,
      "create-tables": false,
      "drop-if-exists": false,
      "batch-size": 500,
      "reports-dir": "_reports",
      "preserve-meta-data": false,
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

// ── Visualization and Namespace Processing ────────────────────────────────────

export type GenerateNamespaceFromModelParams = {
  modelFile: FileInput;
  maxSuggestions?: string;    // default: "25"
  minScore?: string;    // default: "0.5"
  modelName?: string;
  title?: string;
  outputFile?: FileOutput;
};

export async function generateNamespaceFromModel(p: GenerateNamespaceFromModelParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["modelFile"],
    outputFiles: ["outputFile"],
  });
  try {
    await run("generate-namespace-from-model", Object.assign({
      "max-suggestions": "25",
      "min-score": "0.5",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type GenerateTableauFromNamespaceParams = {
  namespaceFile?: FileInput;   // default: "analysis/namespace.yaml"
  connectionFile?: FileInput;   // default: "connections.yaml"
  modelFile?: FileInput;   // default: "model.yaml"
  targetFile?: FileOutput;  // default: "tableau.twb"
  tableauVersion?: string;      // default: "2025"
  connectionName?: string;      // default: "default"
  aliasesFile?: FileInput;
};

export async function generateTableauFromNamespace(p: GenerateTableauFromNamespaceParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["namespaceFile", "connectionFile", "modelFile", "aliasesFile"],
    outputFiles: ["targetFile"],
  });
  try {
    await run("generate-tableau-from-namespace", Object.assign({
      "namespace-file": "analysis/namespace.yaml",
      "connection-file": "connections.yaml",
      "model-file": "model.yaml",
      "target-file": "tableau.twb",
      "tableau-version": "2025",
      "connection-name": "default",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type GenerateExcelFromNamespaceParams = {
  namespaceFile?: FileInput;   // default: "analysis/namespace.yaml"
  connectionFile?: FileInput;   // default: "connections.yaml"
  modelFile?: FileInput;   // default: "model.yaml"
  targetFile?: FileOutput;  // default: "analysis/workbook.xlsx"
  connectionName?: string;      // default: "default"
  aliasesFile?: FileInput;
};

export async function generateExcelFromNamespace(p: GenerateExcelFromNamespaceParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["namespaceFile", "connectionFile", "modelFile", "aliasesFile"],
    outputFiles: ["targetFile"],
  });
  try {
    await run("generate-excel-from-namespace", Object.assign({
      "namespace-file": "analysis/namespace.yaml",
      "connection-file": "connections.yaml",
      "model-file": "model.yaml",
      "target-file": "analysis/workbook.xlsx",
      "connection-name": "default",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type GenerateNotebookFromConnectionParams = {
  namespaceFile?: FileInput;   // default: "analysis/namespace.yaml"
  connectionFile?: FileInput;   // default: "connections.yaml"
  modelFile?: FileInput;   // default: "model.yaml"
  targetFile?: FileOutput;  // default: "notebook.ipynb"
  connectionName?: string;      // default: "default"
  aliasesFile?: FileInput;
};

export async function generateNotebookFromConnection(p: GenerateNotebookFromConnectionParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["namespaceFile", "connectionFile", "modelFile", "aliasesFile"],
    outputFiles: ["targetFile"],
  });
  try {
    await run("generate-notebook-from-connection", Object.assign({
      "namespace-file": "analysis/namespace.yaml",
      "connection-file": "connections.yaml",
      "model-file": "model.yaml",
      "target-file": "notebook.ipynb",
      "connection-name": "default",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

// ── Testing / Query Processing ────────────────────────────────────────────────

export type GenerateQueriesFromSMLParams = {
  smlDir: DirInput;
  xmlaOutputFile: FileOutput;
  sqlOutputFile: FileOutput;
  modelName?: string;
  cubeName?: string;
};

export async function generateQueriesFromSML(p: GenerateQueriesFromSMLParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputDirs: ["smlDir"],
    outputFiles: ["xmlaOutputFile", "sqlOutputFile"],
  });
  try {
    await run("generate-queries-from-sml", cc2kebab(params), o);
    await flush();
  } finally { cleanup(); }
}

export type GenerateQueriesFromModelParams = {
  modelFile: FileInput;
  xmlaOutputFile: FileOutput;
  sqlOutputFile: FileOutput;
  modelName?: string;
  cubeName?: string;
};

export async function generateQueriesFromModel(p: GenerateQueriesFromModelParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["modelFile"],
    outputFiles: ["xmlaOutputFile", "sqlOutputFile"],
  });
  try {
    await run("generate-queries-from-model", cc2kebab(params), o);
    await flush();
  } finally { cleanup(); }
}

export type ExtractQueryStatsFromAtScaleParams = {
  connectionFile: FileInput;
  connectionName: string;
  model: string;
  outputDir?: DirOutput;  // default: "."
  windowDays?: string;     // default: "30"
  monthly?: string;     // default: "false"
  limit?: string;     // default: "100"
  numQueries?: string;     // default: "10"
  startDate?: string;
  endDate?: string;
  monthlyYear?: string;
};

export async function extractQueryStatsFromAtScale(p: ExtractQueryStatsFromAtScaleParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["connectionFile"],
    outputDirs: ["outputDir"],
  });
  try {
    await run("extract-query-stats-from-atscale", Object.assign({
      "output-dir": ".",
      "window-days": "30",
      monthly: "false",
      limit: "100",
      "num-queries": "10",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type ExtractQueriesFromAtScaleParams = {
  connectionFile: FileInput;
  connectionName?: string;    // default: "default"
  days?: string;    // default: "60"
  outputDir?: DirOutput; // default: "queries"
  protocol?: string;    // default: "all"
  minExecutions?: string;    // default: "1"
  dbSchema?: string;    // default: ""
  models?: string;
};

export async function extractQueriesFromAtScale(p: ExtractQueriesFromAtScaleParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["connectionFile"],
    outputDirs: ["outputDir"],
  });
  try {
    await run("extract-queries-from-atscale", Object.assign({
      "connection-name": "default",
      days: "60",
      "output-dir": "queries",
      protocol: "all",
      "min-executions": "1",
      "db-schema": "",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type ExecuteAtScaleQueryHarnessParams = {
  connectionFile: FileInput;
  connectionName: string;
  protocol?: string;    // default: "xmla"
  concurrentUsers?: string;    // default: "1"
  throttleMs?: string;    // default: "5"
  outputDir?: DirOutput; // default: "run_results"
  redact?: string;    // default: "false"
  durationMinutes?: string;    // default: "0"
  annotateQueries?: string;    // default: "true"
  queryFile?: FileInput;
  ingestFile?: FileInput;
  taskFile?: FileInput;
  runId?: string;
};

export async function executeAtScaleQueryHarness(p: ExecuteAtScaleQueryHarnessParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["connectionFile", "queryFile", "ingestFile", "taskFile"],
    outputDirs: ["outputDir"],
  });
  try {
    await run("execute-atscale-query-harness", Object.assign({
      protocol: "xmla",
      "concurrent-users": "1",
      "throttle-ms": "5",
      "output-dir": "run_results",
      redact: "false",
      "duration-minutes": "0",
      "annotate-queries": "true",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type ExecuteQueryOnConnectionParams = {
  connectionFile: FileInput;
  connectionName: string;
  queryFile: FileInput;
  queryName: string;
  outputFile: FileOutput;
  protocol?: string;  // default: "xmla"
};

export async function executeQueryOnConnection(p: ExecuteQueryOnConnectionParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["connectionFile", "queryFile"],
    outputFiles: ["outputFile"],
  });
  try {
    await run("execute-query-on-connection", Object.assign({
      protocol: "xmla",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type GenerateEnhancedQueryResultsParams = {
  resultsFile: FileInput;
  connectionFile: FileInput;
  connectionName: string;
  dbSchema?: string;    // default: ""
  days?: string;    // default: "7"
  outputFile?: FileOutput;
  targetConnectionName?: string;
};

export async function generateEnhancedQueryResults(p: GenerateEnhancedQueryResultsParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["resultsFile", "connectionFile"],
    outputFiles: ["outputFile"],
  });
  try {
    await run("generate-enhanced-query-results", Object.assign({
      "db-schema": "",
      days: "7",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type ExecuteRunAnalysisParams = {
  fileA: FileInput;
  fileB: FileInput;
  summaryFile: FileOutput;
  comparisonFile: FileOutput;
  outliersFile: FileOutput;
  joinKey?: string;  // default: "original_text_hash"
  durationVariancePct?: string;  // default: "20"
};

export async function executeRunAnalysis(p: ExecuteRunAnalysisParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["fileA", "fileB"],
    outputFiles: ["summaryFile", "comparisonFile", "outliersFile"],
  });
  try {
    await run("execute-run-analysis", Object.assign({
      "join-key": "original_text_hash",
      "duration-variance-pct": "20",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

// ── AtScale Config ────────────────────────────────────────────────────────────

export type GenerateAtScaleInstallYamlParams = {
  hostname: string;
  outputFile?: FileOutput;  // default: "values.yaml"
  enableMcp?: boolean;     // default: false
  minimal?: boolean;     // default: false
  externalPostgres?: boolean;     // default: false
  gatekeeperCompliant?: boolean;     // default: false
  certFile?: FileInput;
  keyFile?: FileInput;
  licenseKey?: string;
};

export async function generateAtScaleInstallYaml(p: GenerateAtScaleInstallYamlParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["certFile", "keyFile"],
    outputFiles: ["outputFile"],
  });
  try {
    await run("generate-atscale-install-yaml", Object.assign({
      "output-file": "values.yaml",
      "enable-mcp": false,
      minimal: false,
      "external-postgres": false,
      "gatekeeper-compliant": false,
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type AtScaleListDataSourcesParams = {
  atscaleConnectionName: string;
  connectionFile?: FileInput;  // default: "connections.yaml"
  insecure?: boolean;
};

export async function atScaleListDataSources(p: AtScaleListDataSourcesParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["connectionFile"],
  });
  try {
    await run("atscale-list-data-sources", Object.assign({
      "connection-file": "connections.yaml",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type AtScaleCreateDataSourceParams = {
  atscaleConnectionName: string;
  newConnectionName: string;
  aggregateSchema: string;
  connectionFile?: FileInput;  // default: "connections.yaml"
  accessUsers?: string;     // default: ""
  name?: string;
  connectionId?: string;
  aggregateProjectId?: string;
  insecure?: boolean;
};

export async function atScaleCreateDataSource(p: AtScaleCreateDataSourceParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["connectionFile"],
  });
  try {
    await run("atscale-create-data-source", Object.assign({
      "connection-file": "connections.yaml",
      "access-users": "",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type AtScaleListReposParams = {
  atscaleConnectionName: string;
  connectionFile?: FileInput;  // default: "connections.yaml"
  insecure?: boolean;
};

export async function atScaleListRepos(p: AtScaleListReposParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["connectionFile"],
  });
  try {
    await run("atscale-list-repos", Object.assign({
      "connection-file": "connections.yaml",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type AtScaleCreateRepoParams = {
  atscaleConnectionName: string;
  name: string;
  url: string;
  connectionFile?: FileInput;  // default: "connections.yaml"
  type?: string;     // default: "catalog"
  visibleBranchesPattern?: string;
  defaultBranch?: string;
  insecure?: boolean;
};

export async function atScaleCreateRepo(p: AtScaleCreateRepoParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["connectionFile"],
  });
  try {
    await run("atscale-create-repo", Object.assign({
      "connection-file": "connections.yaml",
      type: "catalog",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type AtScaleListDeploymentsParams = {
  atscaleConnectionName: string;
  connectionFile?: FileInput;  // default: "connections.yaml"
  insecure?: boolean;
};

export async function atScaleListDeployments(p: AtScaleListDeploymentsParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["connectionFile"],
  });
  try {
    await run("atscale-list-deployments", Object.assign({
      "connection-file": "connections.yaml",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type AtScaleDeployCatalogParams = {
  atscaleConnectionName: string;
  smlDir: DirInput;
  connectionFile?: FileInput;  // default: "connections.yaml"
  repoId?: string;
  repoName?: string;
  projectName?: string;
  tableauServers?: string;
  insecure?: boolean;
};

export async function atScaleDeployCatalog(p: AtScaleDeployCatalogParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["connectionFile"],
    inputDirs: ["smlDir"],
  });
  try {
    await run("atscale-deploy-catalog", Object.assign({
      "connection-file": "connections.yaml",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type AtScaleListModelErrorsParams = {
  atscaleConnectionName: string;
  connectionFile?: FileInput;  // default: "connections.yaml"
  smlDir?: DirInput;
  repoName?: string;
  repoId?: string;
  branch?: string;
  modelName?: string;
  insecure?: boolean;
  skipEngineChecks?: boolean;
  skipStructuralChecks?: boolean;
  timeout?: number;
};

export async function atScaleListModelErrors(p: AtScaleListModelErrorsParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["connectionFile"],
    inputDirs: ["smlDir"],
  });
  try {
    await run("atscale-list-model-errors", Object.assign({
      "connection-file": "connections.yaml",
      "timeout": 60,
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

export type GetDsoCountParams = {
  connectionFile: FileInput;
  connectionName: string;
  catalog?: string;
  model?: string;
};

export async function getDsoCount(p: GetDsoCountParams, o: LibraryOptions = {}) {
  const { params, flush, cleanup } = await resolveIO(p as Record<string, unknown>, {
    inputFiles: ["connectionFile"],
  });
  try {
    await run("get-dso-count", Object.assign({
      "connection-file": "connections.yaml",
    }, cc2kebab(params)), o);
    await flush();
  } finally { cleanup(); }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export type VersionParams = Record<string, never>;

export async function version(p: VersionParams = {} as VersionParams, o: LibraryOptions = {}) {
  await run("version", cc2kebab(p as Record<string, unknown>), o);
}

// ── Web Services ──────────────────────────────────────────────────────────────

export type ExecuteWebServicesParams = {
  port?: number;   // default: 4000
  host?: string;   // default: "localhost"
};

/**
 * Starts an HTTP server (GraphQL + REST) and returns a Promise that never
 * resolves under normal operation — the process must be killed to stop it.
 */
export async function executeWebServices(p: ExecuteWebServicesParams = {}, o: LibraryOptions = {}) {
  await run("execute-web-services", Object.assign({
    port: 4000,
    host: "localhost",
  }, cc2kebab(p as Record<string, unknown>)), o);
}
