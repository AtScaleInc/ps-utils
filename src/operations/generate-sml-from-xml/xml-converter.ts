/**
 * AtScale XML project (project_2_0 schema) → SML YAML converter.
 *
 * Implements the algorithm documented in CONVERSION.md.
 *
 * Output keys in the returned Map are relative file paths:
 *   catalog.yml
 *   connections/<connectionName>.yml
 *   datasets/<datasetName>.yml
 *   dimensions/<dimensionName>.yml
 *   metrics/<metricName>.yml
 *   models/<modelName>.yml
 */

import { Parser } from "xml2js";
import { dump } from "js-yaml";
import type { Logger } from "../../logging.js";

// ============================================================
// Public API
// ============================================================

export interface XmlConversionOptions {
  /** SML connection unique_name to embed in generated files. */
  connectionName: string;
  /** Optional connection type (e.g. "snowflake"). Written as comment only. */
  connectionType?: string;
  /** Override the catalog label. Defaults to schema name. */
  catalogName?: string;
}

/**
 * Parse an AtScale XML project file and emit a Map of relative-path → YAML.
 */
export async function convertXmlToSml(
  xmlContent: string,
  opts: XmlConversionOptions,
  logger: Logger,
): Promise<Map<string, string>> {
  const parser = new Parser({
    explicitArray: true,
    attrkey: "$",
    charkey: "_",
    explicitCharkey: false,
    trim: true,
    xmlns: false,
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = await parser.parseStringPromise(xmlContent);
  } catch (e) {
    throw new Error(`Failed to parse XML: ${e instanceof Error ? e.message : String(e)}`);
  }

  // xml2js does NOT wrap the root element in an array (only child elements are wrapped).
  const rawSchema = parsed.schema ?? parsed["xsd:schema"] ?? parsed["ns0:schema"] ??
    (Object.values(parsed)[0] as unknown);

  // Normalise: if it's an array (edge case), unwrap; otherwise use as-is.
  const schemaEl = (Array.isArray(rawSchema) ? rawSchema[0] : rawSchema) as
    | Record<string, unknown>
    | undefined;

  if (!schemaEl || typeof schemaEl !== "object") {
    throw new Error("No <schema> element found in XML");
  }

  const schemaName = a(schemaEl, "name") ?? "Model";
  const catalogName = opts.catalogName ?? schemaName;
  const connName = opts.connectionName;
  const output = new Map<string, string>();

  // ---------------------------------------------------------------
  // Phase 1: Build UUID resolution maps
  // ---------------------------------------------------------------

  // datasetIdToName: id → name (for resolving data-set-ref IDs)
  const datasetIdToName = new Map<string, string>();
  // datasetNameToPhysical: name → { db?, schema?, tableName?, sql? }
  const datasetNameToPhysical = new Map<string, DatasetPhysical>();

  for (const dsSec of arr(schemaEl["data-sets"])) {
    for (const ds of arr(dsSec["data-set"])) {
      const id = a(ds, "id");
      const name = a(ds, "name");
      if (id && name) datasetIdToName.set(id, name);
      if (name) {
        const phys = parseDatasetPhysical(ds);
        if (phys) datasetNameToPhysical.set(name, phys);
      }
    }
  }

  // keyMap: UUID → KeyRefEntry[]
  const keyMap = new Map<string, KeyRefEntry[]>();
  // attrMap: UUID → AttrRefEntry
  const attrMap = new Map<string, AttrRefEntry>();

  function ingestLogical(logicalEl: Record<string, unknown>, datasetName: string): void {
    for (const kr of arr(logicalEl["key-ref"])) {
      const id = a(kr, "id");
      if (!id) continue;
      const complete = a(kr, "complete") ?? "true";
      const columns = extractColumns(arr(kr.column));
      if (columns.length > 0) {
        const entries = keyMap.get(id) ?? [];
        entries.push({ datasetName, columns, complete });
        keyMap.set(id, entries);
      }
    }
    for (const ar of arr(logicalEl["attribute-ref"])) {
      const id = a(ar, "id");
      if (!id) continue;
      const cols = extractColumns(arr(ar.column));
      if (cols.length > 0) {
        attrMap.set(id, { datasetName, column: cols[0] });
      }
    }
  }

  // Schema-level datasets
  for (const dsSec of arr(schemaEl["data-sets"])) {
    for (const ds of arr(dsSec["data-set"])) {
      const dsName = a(ds, "name");
      if (!dsName) continue;
      for (const logSec of arr(ds.logical)) {
        ingestLogical(logSec as Record<string, unknown>, dsName);
      }
    }
  }

  // Phase 1b: keyed-attribute definitions (schema-level + cube-level)
  const attrDef = new Map<string, AttrDefEntry>();

  function ingestKeyedAttrs(attrsEl: Record<string, unknown>): void {
    for (const ka of arr(attrsEl["keyed-attribute"])) {
      const id = a(ka, "id");
      if (!id) continue;
      const name = a(ka, "name") ?? id;
      const keyUuid = a(ka, "key-ref") ?? "";
      const props = first(arr(ka.properties)) as Record<string, unknown> | undefined;
      const caption = props ? s(first(arr(props.caption))) : undefined;
      const folder = props ? s(first(arr(props.folder))) : undefined;
      const visibleStr = props ? s(first(arr(props.visible))) : undefined;
      const visible = visibleStr !== "false";
      const fmtEl = props ? first(arr(props.formatting)) as Record<string, unknown> | undefined : undefined;
      const formatString = fmtEl ? s(first(arr(fmtEl["format-string"]))) : undefined;
      const namedFormat = fmtEl ? s(first(arr(fmtEl["named-format"]))) : undefined;
      attrDef.set(id, { name, caption, keyUuid, formatString, namedFormat, folder, visible });
    }
  }

  // Schema-level attributes
  for (const attrsSec of arr(schemaEl.attributes)) {
    ingestKeyedAttrs(attrsSec as Record<string, unknown>);
  }

  // Collect cubes for processing and gather their data
  const cubeEls: Record<string, unknown>[] = [];
  for (const cubesSec of arr(schemaEl.cubes)) {
    for (const cube of arr(cubesSec.cube)) {
      cubeEls.push(cube as Record<string, unknown>);
    }
  }

  // Cube-level attributes and data-set-refs
  for (const cube of cubeEls) {
    for (const attrsSec of arr(cube.attributes)) {
      ingestKeyedAttrs(attrsSec as Record<string, unknown>);
    }
    for (const dsSec of arr(cube["data-sets"])) {
      for (const dsRef of arr(dsSec["data-set-ref"])) {
        const refId = a(dsRef, "id");
        const dsName = refId ? (datasetIdToName.get(refId) ?? refId) : undefined;
        if (!dsName) continue;
        for (const logSec of arr(dsRef.logical)) {
          ingestLogical(logSec as Record<string, unknown>, dsName);
        }
      }
    }
  }

  // ---------------------------------------------------------------
  // Phase 2: Emit dataset files
  // ---------------------------------------------------------------

  for (const dsSec of arr(schemaEl["data-sets"])) {
    for (const ds of arr(dsSec["data-set"])) {
      const dsName = a(ds, "name");
      if (!dsName) continue;
      const dsYaml = buildDatasetYaml(ds as Record<string, unknown>, dsName, connName);
      const fname = safeFilename(dsName);
      output.set(`datasets/${fname}.yml`, dsYaml);
      logger.log(`  → datasets/${fname}.yml`);
    }
  }

  // ---------------------------------------------------------------
  // Phase 3: Collect dimension elements
  // ---------------------------------------------------------------

  // Schema-level shared dimensions (keyed by name)
  const schemaDims = new Map<string, Record<string, unknown>>();
  for (const dimsSec of arr(schemaEl.dimensions)) {
    for (const dim of arr(dimsSec.dimension)) {
      const name = a(dim, "name");
      if (name) schemaDims.set(name, dim as Record<string, unknown>);
    }
  }

  // Per-cube inline dimensions (emitted later, scoped to each cube)
  // Also build a global map for dimension YAML emission (all dims across all cubes)
  const allDims = new Map<string, Record<string, unknown>>(schemaDims);
  for (const cube of cubeEls) {
    for (const dimsSec of arr(cube.dimensions)) {
      for (const dim of arr(dimsSec.dimension)) {
        const name = a(dim, "name");
        if (name) allDims.set(name, dim as Record<string, unknown>);
      }
    }
  }

  // We emit dimension YAMLs after processing cubes (so we know which dims are referenced)
  const referencedDimNames = new Set<string>();

  // ---------------------------------------------------------------
  // Phase 7: Schema-level calculated members
  // ---------------------------------------------------------------

  const calcMemberDefs = new Map<string, CalcMemberDef>();
  for (const cmSec of arr(schemaEl["calculated-members"])) {
    for (const cm of arr(cmSec["calculated-member"])) {
      const id = a(cm, "id");
      if (!id) continue;
      const def = parseCalcMember(cm as Record<string, unknown>);
      if (def) calcMemberDefs.set(id, def);
    }
  }

  // ---------------------------------------------------------------
  // Phase 4+5+Model: Process each cube
  // ---------------------------------------------------------------

  for (const cube of cubeEls) {
    const cubeName = a(cube, "name") ?? schemaName;

    // Find fact dataset name for this cube
    let factDatasetName: string | undefined;
    for (const dsSec of arr(cube["data-sets"])) {
      for (const dsRef of arr(dsSec["data-set-ref"])) {
        const refId = a(dsRef, "id");
        if (refId) {
          factDatasetName = datasetIdToName.get(refId) ?? refId;
          break;
        }
      }
      if (factDatasetName) break;
    }

    const metricNames: string[] = [];

    // Phase 4: Emit measures
    for (const attrsSec of arr(cube.attributes)) {
      for (const attrEl of arr((attrsSec as Record<string, unknown>).attribute)) {
        const attrId = a(attrEl, "id");
        const attrNameRaw = a(attrEl, "name") ?? "";
        if (!attrId) continue;

        const props = first(arr((attrEl as Record<string, unknown>).properties)) as
          | Record<string, unknown>
          | undefined;
        if (!props) continue;

        const typeEl = first(arr(props.type)) as Record<string, unknown> | undefined;
        if (!typeEl) continue;

        const measureEl = first(arr(typeEl.measure)) as Record<string, unknown> | undefined;
        const countDistEl = first(arr(typeEl["count-distinct"])) as
          | Record<string, unknown>
          | undefined;
        const exprEl = s(first(arr((attrEl as Record<string, unknown>).expression)));

        const caption = s(first(arr(props.caption)));
        const folder = s(first(arr(props.folder)));
        const visibleStr = s(first(arr(props.visible)));
        const visible = visibleStr !== "false";
        const fmtEl = first(arr(props.formatting)) as Record<string, unknown> | undefined;
        const formatString = fmtEl ? s(first(arr(fmtEl["format-string"]))) : undefined;
        const namedFormat = fmtEl ? s(first(arr(fmtEl["named-format"]))) : undefined;
        const format = resolveFormat(formatString, namedFormat);

        if (measureEl || countDistEl) {
          // Regular measure
          const aggText = measureEl
            ? s(first(arr(measureEl["default-aggregation"])))?.toUpperCase()
            : "DISTINCT_COUNT_ESTIMATE";
          const aggregation = mapAggregation(
            aggText ?? (countDistEl ? "COUNT_DISTINCT" : "SUM"),
          );

          // Resolve column: attrMap[attrId] → column
          const colRef = attrMap.get(attrId);
          const column = colRef?.column ?? parseColumnFromAttrName(attrNameRaw);
          if (!column || !factDatasetName) continue;

          const label = caption ?? toTitleCase(attrNameRaw);
          const uniqueName = `${safeName(cubeName)}_${safeName(attrNameRaw)}`.toLowerCase();
          const fname = safeFilename(uniqueName);
          output.set(
            `metrics/${fname}.yml`,
            buildMetricYaml(uniqueName, label, aggregation, factDatasetName, column, format, folder, visible),
          );
          logger.log(`  → metrics/${fname}.yml`);
          metricNames.push(uniqueName);
        } else if (exprEl) {
          // Inline expression (calculated measure on attribute element)
          const label = caption ?? toTitleCase(attrNameRaw);
          const uniqueName = `${safeName(cubeName)}_${safeName(attrNameRaw)}`.toLowerCase();
          const fname = safeFilename(uniqueName);
          output.set(
            `metrics/${fname}.yml`,
            buildCalcMetricYaml(uniqueName, label, unescapeHtml(exprEl), format, folder, visible),
          );
          logger.log(`  → metrics/${fname}.yml`);
          metricNames.push(uniqueName);
        }
      }
    }

    // Phase 7: Emit calculated members referenced by this cube
    for (const cmSec of arr(cube["calculated-members"])) {
      for (const cmRef of arr(cmSec["calculated-member-ref"])) {
        const refId = a(cmRef, "id");
        const def = refId ? calcMemberDefs.get(refId) : undefined;
        if (!def) continue;
        if (!def.visible) continue;
        const label = def.caption ?? def.name;
        const uniqueName = `${safeName(cubeName)}_${safeName(def.name)}`.toLowerCase();
        const format = resolveFormat(def.formatString, def.namedFormat);
        const fname = safeFilename(uniqueName);
        output.set(
          `metrics/${fname}.yml`,
          buildCalcMetricYaml(uniqueName, label, def.expression, format, def.folder, def.visible),
        );
        logger.log(`  → metrics/${fname}.yml`);
        metricNames.push(uniqueName);
      }
    }

    // Build per-cube relevant dims: this cube's inline dims + schema-level shared dims
    const cubeLevelDims = new Map<string, Record<string, unknown>>();
    for (const dimsSec of arr(cube.dimensions)) {
      for (const dim of arr(dimsSec.dimension)) {
        const name = a(dim, "name");
        if (name) cubeLevelDims.set(name, dim as Record<string, unknown>);
      }
    }
    // Schema-level dims referenced via dimension-ref
    for (const dimsSec of arr(cube.dimensions)) {
      for (const dimRef of arr(dimsSec["dimension-ref"])) {
        const refId = a(dimRef, "id");
        if (!refId) continue;
        // Find the schema dim with this id
        for (const [dname, del] of schemaDims) {
          if (a(del, "id") === refId) {
            cubeLevelDims.set(dname, del);
            break;
          }
        }
      }
    }
    const relevantDims = new Map([...schemaDims, ...cubeLevelDims]);

    // Phase 5: Infer relationships
    const relationships = inferRelationships(cube, factDatasetName, keyMap, attrDef, relevantDims);

    // Collect dimension names: inline cube dims + any schema dim referenced via a relationship
    const cubeDimNames: string[] = [...cubeLevelDims.keys()];
    for (const rel of relationships) {
      if (!cubeDimNames.includes(rel.toDimension)) {
        cubeDimNames.push(rel.toDimension);
      }
    }
    // Mark all referenced dims for YAML emission
    for (const n of cubeDimNames) referencedDimNames.add(n);

    // Cube visibility
    const cubeProps = first(arr(cube.properties)) as Record<string, unknown> | undefined;
    const cubeVisible = cubeProps ? s(first(arr(cubeProps.visible))) !== "false" : true;

    // Emit model file
    const modelYaml = buildModelYaml(cubeName, relationships, cubeDimNames, metricNames, !cubeVisible);
    const fname = safeFilename(cubeName);
    output.set(`models/${fname}.yml`, modelYaml);
    logger.log(`  → models/${fname}.yml`);
  }

  // ---------------------------------------------------------------
  // Phase 3b: Emit dimension YAML files for all referenced dims
  // ---------------------------------------------------------------

  for (const dimName of referencedDimNames) {
    const dimEl = allDims.get(dimName);
    if (!dimEl) continue;
    const dimYaml = buildDimensionYaml(dimEl, dimName, attrDef, keyMap, attrMap);
    const fname = safeFilename(dimName);
    output.set(`dimensions/${fname}.yml`, dimYaml);
    logger.log(`  → dimensions/${fname}.yml`);
  }

  // ---------------------------------------------------------------
  // Phase 6: Catalog and connection
  // ---------------------------------------------------------------

  output.set("catalog.yml", buildCatalogYaml(catalogName, connName));
  output.set(`connections/${safeFilename(connName)}.yml`, buildConnectionYaml(connName, opts.connectionType));
  logger.log(`  → catalog.yml`);
  logger.log(`  → connections/${safeFilename(connName)}.yml`);

  return output;
}

// ============================================================
// Internal types
// ============================================================

interface KeyRefEntry {
  datasetName: string;
  columns: string[];
  complete: string; // "true" | "false" | "partial"
}

interface AttrRefEntry {
  datasetName: string;
  column: string;
}

interface AttrDefEntry {
  name: string;
  caption?: string;
  keyUuid: string;
  formatString?: string;
  namedFormat?: string;
  folder?: string;
  visible: boolean;
}

interface CalcMemberDef {
  name: string;
  caption?: string;
  folder?: string;
  visible: boolean;
  formatString?: string;
  namedFormat?: string;
  expression: string;
}

interface DatasetPhysical {
  db?: string;
  schema?: string;
  tableName?: string;
  sql?: string;
}

interface RelationshipDef {
  uniqueName: string;
  fromDataset: string;
  fromColumns: string[];
  toDimension: string;
  toLevel: string;
}

// ============================================================
// XML navigation helpers
// ============================================================

/** Get first element of an array, or undefined. */
function first<T>(arr: T[] | undefined): T | undefined {
  return arr?.[0];
}

/** Ensure value is an array (handles xml2js output). */
function arr(val: unknown): Record<string, unknown>[] {
  if (!val) return [];
  if (Array.isArray(val)) return val as Record<string, unknown>[];
  return [val as Record<string, unknown>];
}

/** Get text content from an xml2js parsed value. */
function s(val: unknown): string | undefined {
  if (val == null) return undefined;
  if (typeof val === "string") return val || undefined;
  if (Array.isArray(val)) {
    const v = val[0];
    return v == null ? undefined : typeof v === "string" ? (v || undefined) : s(v);
  }
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if (typeof obj._ === "string") return obj._ || undefined;
  }
  return String(val) || undefined;
}

/** Get attribute value from an xml2js element. */
function a(el: unknown, name: string): string | undefined {
  if (!el || typeof el !== "object") return undefined;
  const obj = el as Record<string, unknown>;
  const attrs = obj.$ as Record<string, string> | undefined;
  return attrs?.[name];
}

/** Extract column name from a <column> element (plain text OR structured form). */
function extractColumnName(col: unknown): string | undefined {
  if (typeof col === "string") return col || undefined;
  if (col && typeof col === "object") {
    const obj = col as Record<string, unknown>;
    // Structured: <column><name>X</name><sql>...</sql><type>Y</type></column>
    const nameVal = first(arr(obj.name));
    if (nameVal) {
      const n = s(nameVal);
      if (n) return n;
    }
    // Plain text stored as charkey
    if (typeof obj._ === "string") return obj._ || undefined;
  }
  return undefined;
}

/** Extract all column names from raw column array. */
function extractColumns(rawCols: Record<string, unknown>[]): string[] {
  return rawCols.map(extractColumnName).filter((c): c is string => Boolean(c));
}

// ============================================================
// String / format helpers
// ============================================================

function toTitleCase(s: string): string {
  return s
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Convert a name to a safe filesystem/unique_name slug (no special chars). */
function safeName(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9_\-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_|_$/g, "");
}

/** Convert a name to a safe filename (lowercase, hyphens). */
function safeFilename(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\-_.]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/** Unescape HTML entities from XML-encoded SQL or MDX. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&#xA;/g, "\n")
    .replace(/&#x9;/g, "\t")
    .replace(/&#xD;/g, "\r")
    .replace(/&#39;/g, "'")
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Map XML aggregation string → SML calculation_method. */
function mapAggregation(raw: string): string {
  switch (raw.toUpperCase()) {
    case "SUM":            return "sum";
    case "AVG":            return "average";
    case "MIN":            return "minimum";
    case "MAX":            return "maximum";
    case "COUNT":          return "count non-null";
    case "COUNT_DISTINCT":
    case "DISTINCT_COUNT_ESTIMATE":
    case "DISTINCTCOUNTESTIMATE": return "distinct count estimate";
    default:               return "sum";
  }
}

/** Map XML format-string or named-format → SML format. */
function resolveFormat(formatString?: string, namedFormat?: string): string | undefined {
  if (namedFormat) {
    switch (namedFormat.toLowerCase()) {
      case "percent":  return "percent:1";
      case "standard": return "decimal:2";
      case "currency": return "currency:0";
    }
  }
  if (formatString) {
    switch (formatString) {
      case "#,##0":     return "#,##0";
      case "#,##0.00":  return "#,##0.00";
      case "0%":        return "0%";
      case "#,##0.0%":  return "#,##0.0%";
      case "$#,##0":    return "$#,##0";
      case "#,##0%":    return "#,##0%";
      default:          return formatString;
    }
  }
  return undefined;
}

/**
 * Parse the column name from a measure attribute name.
 * Convention: m_{COLUMN_NAME}_{agg_suffix}  OR  just the raw name.
 * Returns the column portion, or the full name if no convention is detected.
 */
function parseColumnFromAttrName(attrName: string): string {
  // Strip leading m_ prefix
  const withoutPrefix = attrName.replace(/^m_/i, "");
  // Strip trailing _sum / _avg / _min / _max / _count / _distinct
  return withoutPrefix.replace(/_(sum|avg|min|max|count|distinct|average|minimum|maximum)$/i, "");
}

/** Map XML dimension-type/level-type to SML time_unit. */
function mapLevelType(xmlLevelType: string | undefined): string | undefined {
  if (!xmlLevelType) return undefined;
  switch (xmlLevelType) {
    case "TimeYears":   return "year";
    case "TimeMonths":  return "month";
    case "TimeDays":    return "day";
    case "TimeWeeks":   return "week";
    default:            return undefined;
  }
}

// ============================================================
// Dataset physical section parser
// ============================================================

function parseDatasetPhysical(dsEl: Record<string, unknown>): DatasetPhysical | undefined {
  const physSec = first(arr(dsEl.physical)) as Record<string, unknown> | undefined;
  if (!physSec) return undefined;

  const tableEl = first(arr(physSec.table)) as Record<string, unknown> | undefined;
  const queryEl = first(arr(physSec.query)) as Record<string, unknown> | undefined;

  if (tableEl) {
    const db = s(first(arr(tableEl.database)));
    const schema = s(first(arr(tableEl.schema)));
    const tableName = s(first(arr(tableEl.name)));
    return { db, schema, tableName };
  }

  if (queryEl) {
    const rawSql = s(first(arr(queryEl.sql)));
    if (rawSql) {
      // Replace tabs with spaces so js-yaml can use block literal (| style) rather than quoted
      return { sql: unescapeHtml(rawSql).replace(/\t/g, "  ") };
    }
  }

  return undefined;
}

// ============================================================
// Phase 2: Dataset YAML
// ============================================================

function buildDatasetYaml(
  dsEl: Record<string, unknown>,
  dsName: string,
  connName: string,
): string {
  const phys = parseDatasetPhysical(dsEl) ?? {};

  const obj: Record<string, unknown> = {
    unique_name: `${dsName}.dataset`,
    object_type: "dataset",
    label: toTitleCase(dsName),
    connection_id: connName,
  };

  if (phys.sql) {
    obj.sql = phys.sql;
  } else {
    // Prefer structured table reference when db/schema are available
    if (phys.db || phys.schema) {
      obj.table = {
        ...(phys.db ? { db: phys.db } : {}),
        ...(phys.schema ? { schema: phys.schema } : {}),
        name: phys.tableName ?? dsName,
      };
    } else {
      obj.table = phys.tableName ?? dsName;
    }
  }

  return toYaml(obj);
}

// ============================================================
// Phase 3: Dimension YAML
// ============================================================

interface LevelAttrDef {
  uniqueName: string;
  label: string;
  dataset: string;
  keyColumns: string[];
  nameColumn: string;
  timeUnit?: string;
  isHiddenFromUi?: boolean;
  folder?: string;
}

function buildDimensionYaml(
  dimEl: Record<string, unknown>,
  dimName: string,
  attrDef: Map<string, AttrDefEntry>,
  keyMap: Map<string, KeyRefEntry[]>,
  attrMap: Map<string, AttrRefEntry>,
): string {
  const props = first(arr(dimEl.properties)) as Record<string, unknown> | undefined;
  const dimTypeRaw = props ? s(first(arr(props["dimension-type"]))) : undefined;
  const isTime = dimTypeRaw === "Time";
  const label = props
    ? (s(first(arr(props.caption))) ?? dimName)
    : dimName;

  // Collect level attributes (de-duplicated by uniqueName)
  const levelAttrMap = new Map<string, LevelAttrDef>();

  // hierarchy structures: { uniqueName, label, filterEmpty?, levels: uniqueName[] }
  const hierarchies: Array<{
    uniqueName: string;
    label: string;
    filterEmpty?: string;
    defaultMember?: string;
    levels: Array<{ uniqueName: string; timeUnit?: string; isHidden?: boolean }>;
  }> = [];

  for (const hierEl of arr(dimEl.hierarchy)) {
    const hierName = a(hierEl, "name") ?? "Hierarchy";
    const hierProps = first(arr(hierEl.properties)) as Record<string, unknown> | undefined;
    const hierCaption = hierProps ? s(first(arr(hierProps.caption))) : undefined;
    const filterEmptyRaw = hierProps ? s(first(arr(hierProps["filter-empty"]))) : undefined;
    const filterEmpty = filterEmptyRaw
      ? filterEmptyRaw.toLowerCase() === "always"
        ? "always"
        : "yes"
      : undefined;

    // Default member
    const defaultMemberEl = hierProps
      ? (first(arr(hierProps["default-member"])) as Record<string, unknown> | undefined)
      : undefined;
    const literalMember = defaultMemberEl
      ? s(first(arr(defaultMemberEl["literal-member"])))
      : undefined;
    const defaultMember = literalMember ? unescapeHtml(literalMember) : undefined;

    const hierLevels: Array<{ uniqueName: string; timeUnit?: string; isHidden?: boolean }> = [];

    for (const levelEl of arr(hierEl.level)) {
      const primaryAttrUuid = a(levelEl, "primary-attribute");
      if (!primaryAttrUuid) continue;

      const def = attrDef.get(primaryAttrUuid);
      if (!def) continue;

      const levelName = def.caption ?? def.name;
      const levelUniqueName = def.name;

      // Resolve key columns
      const keyEntries = keyMap.get(def.keyUuid) ?? [];
      const authEntry =
        keyEntries.find((e) => e.complete === "true") ?? keyEntries[0];
      if (!authEntry) continue;

      const keyColumns = authEntry.columns;
      const datasetRef = `${authEntry.datasetName}.dataset`;

      // Resolve name column from secondary keyed-attribute-refs
      let nameColumn = keyColumns[0];
      for (const kref of arr(levelEl["keyed-attribute-ref"])) {
        const attrId = a(kref, "attribute-id");
        if (!attrId) continue;
        const ref = attrMap.get(attrId);
        if (ref) {
          nameColumn = ref.column;
          break;
        }
        // Also check if attribute-id refers to a keyed-attribute definition
        const kaDef = attrDef.get(attrId);
        if (kaDef) {
          const kaKeyEntries = keyMap.get(kaDef.keyUuid) ?? [];
          const kaEntry = kaKeyEntries.find((e) => e.complete === "true") ?? kaKeyEntries[0];
          if (kaEntry?.columns[0]) {
            nameColumn = kaEntry.columns[0];
            break;
          }
        }
      }

      const levelVisibleStr = (() => {
        const lProps = first(arr(levelEl.properties)) as Record<string, unknown> | undefined;
        return lProps ? s(first(arr(lProps.visible))) : undefined;
      })();
      const isHidden = levelVisibleStr === "false" || !def.visible;

      const levelTypeRaw = (() => {
        const lProps = first(arr(levelEl.properties)) as Record<string, unknown> | undefined;
        return lProps ? s(first(arr(lProps["level-type"]))) : undefined;
      })();
      const timeUnit = mapLevelType(levelTypeRaw);

      // Build or merge level attribute
      if (!levelAttrMap.has(levelUniqueName)) {
        levelAttrMap.set(levelUniqueName, {
          uniqueName: levelUniqueName,
          label: levelName,
          dataset: datasetRef,
          keyColumns,
          nameColumn,
          timeUnit,
          isHiddenFromUi: isHidden || undefined,
          folder: def.folder,
        });
      }

      hierLevels.push({ uniqueName: levelUniqueName, timeUnit, isHidden: isHidden || undefined });
    }

    if (hierLevels.length > 0) {
      hierarchies.push({
        uniqueName: hierName,
        label: hierCaption ?? hierName,
        filterEmpty,
        defaultMember,
        levels: hierLevels,
      });
    }
  }

  // Build YAML structure
  const obj: Record<string, unknown> = {
    unique_name: dimName,
    object_type: "dimension",
    label,
  };

  if (isTime) obj.type = "time";

  if (hierarchies.length > 0) {
    obj.hierarchies = hierarchies.map((h) => {
      const hierObj: Record<string, unknown> = {
        unique_name: h.uniqueName,
        label: h.label,
      };
      if (h.filterEmpty) hierObj.filter_empty = h.filterEmpty;
      if (h.defaultMember) hierObj.default_member = h.defaultMember;
      hierObj.levels = h.levels.map((l) => {
        const lObj: Record<string, unknown> = { unique_name: l.uniqueName };
        if (l.isHidden) lObj.is_hidden_from_ui = true;
        return lObj;
      });
      return hierObj;
    });
  }

  if (levelAttrMap.size > 0) {
    obj.level_attributes = Array.from(levelAttrMap.values()).map((la) => {
      const laObj: Record<string, unknown> = {
        unique_name: la.uniqueName,
        label: la.label,
        dataset: la.dataset,
        name_column: la.nameColumn,
        key_columns: la.keyColumns,
      };
      if (la.timeUnit) laObj.time_unit = la.timeUnit;
      if (la.folder) laObj.folder = la.folder;
      if (la.isHiddenFromUi) laObj.is_hidden_from_ui = true;
      return laObj;
    });
  }

  return toYaml(obj);
}

// ============================================================
// Phase 4: Metric YAML
// ============================================================

function buildMetricYaml(
  uniqueName: string,
  label: string,
  calculationMethod: string,
  factDatasetName: string,
  column: string,
  format?: string,
  folder?: string,
  visible = true,
): string {
  const obj: Record<string, unknown> = {
    unique_name: uniqueName,
    object_type: "metric",
    label,
    calculation_method: calculationMethod,
    dataset: `${factDatasetName}.dataset`,
    column,
  };
  if (format) obj.format = format;
  if (folder) obj.folder = folder;
  if (!visible) obj.is_hidden_from_ui = true;
  return toYaml(obj);
}

function buildCalcMetricYaml(
  uniqueName: string,
  label: string,
  formula: string,
  format?: string,
  folder?: string,
  visible = true,
): string {
  const obj: Record<string, unknown> = {
    unique_name: uniqueName,
    object_type: "metric",
    label,
    formula,
  };
  if (format) obj.format = format;
  if (folder) obj.folder = folder;
  if (!visible) obj.is_hidden_from_ui = true;
  return toYaml(obj);
}

// ============================================================
// Phase 7: Calculated member parser
// ============================================================

function parseCalcMember(cm: Record<string, unknown>): CalcMemberDef | undefined {
  const name = a(cm, "name");
  if (!name) return undefined;
  const props = first(arr(cm.properties)) as Record<string, unknown> | undefined;
  const caption = props ? s(first(arr(props.caption))) : undefined;
  const folder = props ? s(first(arr(props.folder))) : undefined;
  const visibleStr = props ? s(first(arr(props.visible))) : undefined;
  const visible = visibleStr !== "false";
  const fmtEl = props ? (first(arr(props.formatting)) as Record<string, unknown> | undefined) : undefined;
  const formatString = fmtEl ? s(first(arr(fmtEl["format-string"]))) : undefined;
  const namedFormat = fmtEl ? s(first(arr(fmtEl["named-format"]))) : undefined;
  const exprRaw = s(first(arr(cm.expression)));
  if (!exprRaw) return undefined;
  return {
    name,
    caption,
    folder,
    visible,
    formatString,
    namedFormat,
    expression: unescapeHtml(exprRaw),
  };
}

// ============================================================
// Phase 5: Relationship inference
// ============================================================

/**
 * Scan all levels of all hierarchies in a dimension to find one whose key-ref UUID
 * appears in cubeKeyCols (the set of key UUIDs referenced by the cube).
 * Returns { keyUuid, toLevel } for the first matching level, or undefined if none match.
 * This handles both degenerate dims (complete=true in cube) and cross-table dims
 * (complete=false in cube + complete=true in dim dataset), as well as multi-level
 * hierarchies where only the leaf level has a FK in the fact table.
 */
function findCubeMatchingLevel(
  dimEl: Record<string, unknown>,
  attrDef: Map<string, AttrDefEntry>,
  cubeKeyCols: Map<string, string[]>,
): { keyUuid: string; toLevel: string } | undefined {
  for (const hierEl of arr(dimEl.hierarchy)) {
    for (const levelEl of arr(hierEl.level)) {
      const pa = a(levelEl, "primary-attribute");
      if (!pa) continue;
      const def = attrDef.get(pa);
      if (!def?.keyUuid) continue;
      if (cubeKeyCols.has(def.keyUuid)) {
        return { keyUuid: def.keyUuid, toLevel: def.name };
      }
    }
  }
  return undefined;
}

function inferRelationships(
  cubeEl: Record<string, unknown>,
  factDatasetName: string | undefined,
  keyMap: Map<string, KeyRefEntry[]>,
  attrDef: Map<string, AttrDefEntry>,
  relevantDims: Map<string, Record<string, unknown>>,
): RelationshipDef[] {
  if (!factDatasetName) return [];

  // Build the set of key-ref UUIDs that appear in this cube's data-set-ref logical sections,
  // mapped to the fact-table columns that hold that key.
  // We prefer complete="false" entries (explicit FK) but also accept complete="true" (degenerate).
  const cubeKeyCols = new Map<string, string[]>(); // keyUuid → fact columns
  for (const dsSec of arr(cubeEl["data-sets"])) {
    for (const dsRef of arr(dsSec["data-set-ref"])) {
      for (const logSec of arr(dsRef.logical)) {
        for (const kr of arr(logSec["key-ref"])) {
          const id = a(kr, "id");
          if (!id) continue;
          const cols = extractColumns(arr(kr.column));
          if (cols.length === 0) continue;
          // Store once; prefer complete=false (explicit FK) over complete=true (degenerate)
          const complete = a(kr, "complete") ?? "true";
          if (!cubeKeyCols.has(id) || complete === "false") {
            cubeKeyCols.set(id, cols);
          }
        }
      }
    }
  }

  const relationships: RelationshipDef[] = [];
  const seen = new Set<string>();

  for (const [dimName, dimEl] of relevantDims) {
    // Find the first level of this dimension whose key UUID appears in the cube's key-refs.
    // For multi-level hierarchies (e.g. date dims) the cube FK is typically on the leaf level;
    // for degenerate dims it is usually the sole level.
    const match = findCubeMatchingLevel(dimEl, attrDef, cubeKeyCols);
    if (!match) continue; // Dimension not used by this cube

    const { keyUuid, toLevel } = match;
    const fromColumns = cubeKeyCols.get(keyUuid)!;

    const relKey = `${dimName}|${fromColumns.join(",")}`;
    if (seen.has(relKey)) continue;
    seen.add(relKey);

    const relUniqueName = `${safeName(factDatasetName)}_to_${safeName(dimName)}_${safeName(fromColumns.join("_"))}`;

    relationships.push({
      uniqueName: relUniqueName,
      fromDataset: factDatasetName,
      fromColumns,
      toDimension: dimName,
      toLevel,
    });
  }

  return relationships;
}

/**
 * Find the unique_name of the first level attribute in a dimension.
 * Used as the relationship target level.
 */
function findFirstLevelName(
  dimEl: Record<string, unknown>,
  attrDef: Map<string, AttrDefEntry>,
): string | undefined {
  for (const hierEl of arr(dimEl.hierarchy)) {
    for (const levelEl of arr(hierEl.level)) {
      const pa = a(levelEl, "primary-attribute");
      if (!pa) continue;
      const def = attrDef.get(pa);
      if (def) return def.name;
    }
  }
  return undefined;
}

// ============================================================
// Phase 6: Catalog, connection, model YAML
// ============================================================

function buildCatalogYaml(catalogName: string, connName: string): string {
  return toYaml({
    unique_name: `${catalogName}.catalog`,
    object_type: "catalog",
    label: catalogName,
    version: 1.5,
    aggressive_agg_promotion: false,
    build_speculative_aggs: false,
    default_data_source: connName,
  });
}

function buildConnectionYaml(connName: string, connType?: string): string {
  const obj: Record<string, unknown> = {
    unique_name: connName,
    object_type: "connection",
    label: connName,
    as_connection: connName,
  };
  if (connType) obj.connection_type = connType;
  return toYaml(obj);
}

function buildModelYaml(
  modelName: string,
  relationships: RelationshipDef[],
  dimNames: string[],
  metricNames: string[],
  isHidden = false,
): string {
  const obj: Record<string, unknown> = {
    unique_name: modelName,
    object_type: "model",
    label: modelName,
  };

  if (isHidden) obj.is_hidden_from_ui = true;

  obj.relationships = relationships.map((r) => ({
    unique_name: r.uniqueName,
    from: {
      dataset: `${r.fromDataset}.dataset`,
      join_columns: r.fromColumns,
    },
    to: {
      dimension: r.toDimension,
      level: r.toLevel,
    },
  }));

  if (dimNames.length > 0) {
    obj.dimensions = dimNames.map((n) => ({ unique_name: n }));
  }

  if (metricNames.length > 0) {
    obj.metrics = metricNames.map((n) => ({ unique_name: n }));
  }

  return toYaml(obj);
}

// ============================================================
// YAML serialization
// ============================================================

function toYaml(obj: unknown): string {
  return dump(obj, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: false,
  });
}
