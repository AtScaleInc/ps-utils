/**
 * SSAS Multidimensional (classic OLAP cube) XMLA -> AtScale project XML converter.
 *
 * Converts an SSAS Multidimensional `<Create><ObjectDefinition><Database>` XMLA
 * export into an AtScale project_2_0 XML string, which can then be fed directly
 * into `generate-sml-from-xml`'s `convertXmlToSml` — this module does NOT
 * generate SML itself.
 *
 * WHAT IT DOES (Pass 1 — see LIMITATIONS)
 *   1. Parses Dimensions (Attributes, Hierarchies), Cubes (cube-dimension usages,
 *      MeasureGroups, Measures, measure-group-dimension joins), and
 *      DataSourceViews (the embedded ADO.NET-XSD physical table/column schema)
 *      from the XMLA document.
 *   2. Resolves every attribute/measure's physical table.column via the cube's
 *      DataSourceView, using DbTableName/DbColumnName when present.
 *   3. Emits one AtScale dataset + dimension per SSAS Dimension: declared
 *      hierarchies are used directly; a dimension with none gets one hierarchy
 *      synthesized from its Key attribute, walking AttributeRelationships
 *      upward for parent levels. Attributes not on any level are attached as
 *      secondary attributes to whichever level they relate to.
 *   4. Emits one fact dataset per MeasureGroup, one metric per measure.
 *   5. Regular measure-group-dimension joins are resolved via the "Granularity"
 *      attribute's KeyColumns: the physical table/column on the fact side, and
 *      the same AttributeID's own KeyColumns on the dimension side. When the
 *      resolved fact-side table equals the dimension-side table (SSAS's
 *      "Degenerate" pattern, physically confirmed rather than assumed from the
 *      xsi:type alone), the attribute is emitted directly on the fact dataset
 *      instead of as a cross-dataset join.
 *   6. Role-played dimensions are detected the same way the reference converter
 *      does: multiple cube-level dimension usages (`Cube/Dimensions/Dimension`)
 *      sharing the same underlying `DimensionID` within one cube. Each role's
 *      distinguishing name is derived via a longest-common-suffix trim across
 *      the role names (e.g. "Ship"/"Delivery" from "Ship Date"/"Delivery Date"
 *      sharing the suffix "Date"), falling back to the role's own name when no
 *      distinguishing remainder exists.
 *
 * LIMITATIONS (Pass 1 — detected and reported, not converted; matches or
 * improves on the reference Go tool's own conservative behavior for these):
 *   - Many-to-many measure-group dimensions (`ManyToManyMeasureGroupDimension`).
 *   - Reference measure-group dimensions (`ReferenceMeasureGroupDimension`,
 *     chained/snowflaked through an intermediate dimension).
 *   - Parent-child dimensions (an attribute with `Usage == "Parent"`).
 *   - Ragged hierarchies (`HideMemberIf` set on a level) — still emitted as a
 *     normal hierarchy, with a warning.
 *   - MDX calculation scripts, cube perspectives/KPIs/permissions/proactive
 *     caching/partitions/aggregation designs, data-mining relationships — none
 *     of these are read at all (matches `xml-converter.ts`'s own scope, which
 *     doesn't consume them either).
 *   - SSAS Tabular models are rejected outright with a clear error pointing at
 *     `generate-sml-from-tabular`.
 */
import { Parser } from "xml2js";
import type { Logger } from "../../logging.js";

// ============================================================
// xml2js parse-tree helpers (Parser configured to match generate-sml-from-xml)
// ============================================================

type Raw = any;

function arr(x: Raw): Raw[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}
function first(xs: Raw[]): Raw | undefined {
  return xs[0];
}
function one(x: Raw): Raw | undefined {
  return first(arr(x));
}
function attr(el: Raw, name: string): string | undefined {
  return el?.$?.[name];
}
function text(el: Raw): string | undefined {
  if (el === undefined || el === null) return undefined;
  if (typeof el === "string") return el;
  if (typeof el === "object" && "_" in el) return el._;
  return undefined;
}
function textOf(parent: Raw, tag: string): string | undefined {
  return text(one(parent?.[tag]));
}

// ============================================================
// Physical resolution (DataSourceView embedded ADO.NET/XSD schema)
// ============================================================

interface PhysColumn {
  columnId: string;
  physicalName: string;
  dataType: string;
  computedExpr?: string;
}
interface PhysTable {
  tableId: string;
  physicalName: string;
  schema?: string;
  columns: Map<string, PhysColumn>;
}

const DATA_TYPE_MAP: Record<string, string> = {
  string: "string", wchar: "string", text: "string", character: "string",
  int: "int", integer: "int", int4: "int", smallint: "int", tinyint: "int",
  unsignedtinyint: "int", short: "int", unsignedbyte: "int", unsignedint: "int",
  long: "long", bigint: "long", int64: "long", int8: "long",
  decimal: "decimal", numeric: "decimal", money: "decimal", d: "decimal",
  float: "float", float4: "float",
  double: "double", currency: "double", real: "double", float8: "double", float64: "double",
  datetime: "datetime", timestamp: "datetime", time: "datetime",
  date: "date", da: "date",
  boolean: "boolean", bool: "boolean",
};

function mapSsasDataType(t: string | undefined): string {
  if (!t) return "string";
  const stripped = t.toLowerCase().replace(/^xs:/, "");
  return DATA_TYPE_MAP[stripped] ?? "string";
}

/** Find a child element by local name, tolerating any namespace prefix (e.g. "xs:schema", "xsd:schema"). */
function findLocal(parent: Raw, localName: string): Raw {
  if (!parent || typeof parent !== "object") return undefined;
  for (const key of Object.keys(parent)) {
    if (key === localName || key === "$" ) continue;
    const bare = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
    if (bare === localName) return parent[key];
  }
  return undefined;
}

/** Parse one DataSourceView's embedded ADO.NET/XSD schema into physical table/column info. */
function parseDsvTables(dsvEl: Raw): Map<string, PhysTable> {
  const tables = new Map<string, PhysTable>();
  const schemaWrap = one(dsvEl?.Schema);
  if (!schemaWrap) return tables;
  const xsSchema = one(findLocal(schemaWrap, "schema"));
  if (!xsSchema) return tables;
  const rootElements = arr(findLocal(xsSchema, "element"));
  for (const rootEl of rootElements) {
    const complexType = one(findLocal(rootEl, "complexType"));
    if (!complexType) continue;
    const choice = one(findLocal(complexType, "choice"));
    if (!choice) continue;
    for (const tableEl of arr(findLocal(choice, "element"))) {
      const tableId = attr(tableEl, "name");
      if (!tableId) continue;
      const columns = new Map<string, PhysColumn>();
      const tableComplexType = one(findLocal(tableEl, "complexType"));
      const sequence = tableComplexType ? one(findLocal(tableComplexType, "sequence")) : undefined;
      for (const colEl of arr(sequence ? findLocal(sequence, "element") : undefined)) {
        const columnId = attr(colEl, "name");
        if (!columnId) continue;
        let rawType = attr(colEl, "type");
        if (!rawType) {
          const simpleType = one(findLocal(colEl, "simpleType"));
          const restriction = simpleType ? one(findLocal(simpleType, "restriction")) : undefined;
          rawType = restriction ? attr(restriction, "base") : undefined;
        }
        columns.set(columnId, {
          columnId,
          physicalName: attr(colEl, "DbColumnName") ?? columnId,
          dataType: mapSsasDataType(rawType),
          computedExpr: attr(colEl, "ComputedColumnExpression"),
        });
      }
      tables.set(tableId, {
        tableId,
        physicalName: attr(tableEl, "DbTableName") ?? tableId,
        schema: attr(tableEl, "DbSchemaName"),
        columns,
      });
    }
  }
  return tables;
}

// ============================================================
// SSAS structural extraction
// ============================================================

interface SsasKeyColumn { tableId: string; columnId: string }

interface SsasAttribute {
  id: string;
  name: string;
  usage?: string;
  keyColumns: SsasKeyColumn[];
  nameColumn?: SsasKeyColumn;
  relatedAttributeIds: string[];
}

interface SsasHierarchy {
  id: string;
  name: string;
  levels: Array<{ id: string; name: string; sourceAttributeId: string; hideMemberIf?: string }>;
}

interface SsasDimension {
  id: string;
  name: string;
  isTabular: boolean;
  attributes: Map<string, SsasAttribute>;
  hierarchies: SsasHierarchy[];
}

/**
 * Resolve a physical table/column reference from a SSAS binding element. The nesting depth
 * varies: KeyColumn/NameColumn wrap one <Source xsi:type="ColumnBinding"> level, while Measure
 * wraps two (<Measure><Source><Source xsi:type="ColumnBinding">...). Unwrap until a level with
 * TableID/ColumnID directly on it is found (an InheritedBinding — no TableID/ColumnID at any
 * level — correctly yields undefined).
 */
function parseSource(el: Raw): SsasKeyColumn | undefined {
  let cur: Raw = el;
  for (let i = 0; i < 4 && cur; i++) {
    const tableId = textOf(cur, "TableID");
    const columnId = textOf(cur, "ColumnID");
    if (tableId && columnId) return { tableId, columnId };
    cur = one(cur.Source);
  }
  return undefined;
}

function parseAttribute(attrEl: Raw): SsasAttribute {
  const keyColumns: SsasKeyColumn[] = [];
  for (const kc of arr(one(attrEl.KeyColumns)?.KeyColumn)) {
    const src = parseSource(kc);
    if (src) keyColumns.push(src);
  }
  const nameColEl = one(attrEl.NameColumn);
  const nameColumn = nameColEl ? parseSource(nameColEl) : undefined;
  const relatedAttributeIds: string[] = [];
  for (const rel of arr(one(attrEl.AttributeRelationships)?.AttributeRelationship)) {
    const id = textOf(rel, "AttributeID");
    if (id) relatedAttributeIds.push(id);
  }
  return {
    id: textOf(attrEl, "ID") ?? "",
    name: textOf(attrEl, "Name") ?? "",
    usage: textOf(attrEl, "Usage"),
    keyColumns,
    nameColumn,
    relatedAttributeIds,
  };
}

function parseDimensions(databaseEl: Raw): Map<string, SsasDimension> {
  const result = new Map<string, SsasDimension>();
  for (const dimEl of arr(one(databaseEl.Dimensions)?.Dimension)) {
    const id = textOf(dimEl, "ID");
    if (!id) continue;
    const attributes = new Map<string, SsasAttribute>();
    for (const attrEl of arr(one(dimEl.Attributes)?.Attribute)) {
      const parsed = parseAttribute(attrEl);
      if (parsed.id) attributes.set(parsed.id, parsed);
    }
    const hierarchies: SsasHierarchy[] = [];
    for (const hierEl of arr(one(dimEl.Hierarchies)?.Hierarchy)) {
      const levels = arr(one(hierEl.Levels)?.Level).map((lvlEl) => ({
        id: textOf(lvlEl, "ID") ?? "",
        name: textOf(lvlEl, "Name") ?? "",
        sourceAttributeId: textOf(lvlEl, "SourceAttributeID") ?? "",
        hideMemberIf: textOf(lvlEl, "HideMemberIf"),
      })).filter((l) => l.sourceAttributeId);
      hierarchies.push({ id: textOf(hierEl, "ID") ?? "", name: textOf(hierEl, "Name") ?? "", levels });
    }
    result.set(id, {
      id,
      name: textOf(dimEl, "Name") ?? id,
      isTabular: Boolean(one(dimEl.TabularRelationships)),
      attributes,
      hierarchies,
    });
  }
  return result;
}

interface SsasMeasure {
  id: string;
  name: string;
  aggregateFunction: string;
  column?: SsasKeyColumn;
  formatString?: string;
  visible: boolean;
}

interface SsasMgDimension {
  xsiType: string;
  cubeDimensionId: string;
  granularity?: SsasKeyColumn[];
  granularityAttributeId?: string;
}

interface SsasMeasureGroup {
  id: string;
  name: string;
  measures: SsasMeasure[];
  mgDimensions: SsasMgDimension[];
}

interface SsasCubeDim {
  id: string;
  name: string;
  dimensionId: string;
}

interface SsasCube {
  id: string;
  name: string;
  dsvId?: string;
  cubeDims: SsasCubeDim[];
  measureGroups: SsasMeasureGroup[];
}

function parseCubes(databaseEl: Raw): SsasCube[] {
  const cubes: SsasCube[] = [];
  for (const cubeEl of arr(one(databaseEl.Cubes)?.Cube)) {
    const id = textOf(cubeEl, "ID");
    if (!id) continue;
    const dsvId = textOf(one(cubeEl.Source), "DataSourceViewID");
    const cubeDims: SsasCubeDim[] = [];
    for (const dimEl of arr(one(cubeEl.Dimensions)?.Dimension)) {
      const dimId = textOf(dimEl, "ID");
      const dimensionId = textOf(dimEl, "DimensionID");
      if (dimId && dimensionId) cubeDims.push({ id: dimId, name: textOf(dimEl, "Name") ?? dimId, dimensionId });
    }
    const measureGroups: SsasMeasureGroup[] = [];
    for (const mgEl of arr(one(cubeEl.MeasureGroups)?.MeasureGroup)) {
      const mgId = textOf(mgEl, "ID");
      if (!mgId) continue;
      const measures: SsasMeasure[] = [];
      for (const mEl of arr(one(mgEl.Measures)?.Measure)) {
        const column = parseSource(mEl);
        measures.push({
          id: textOf(mEl, "ID") ?? "",
          name: textOf(mEl, "Name") ?? "",
          aggregateFunction: textOf(mEl, "AggregateFunction") ?? "Sum",
          column,
          formatString: textOf(mEl, "FormatString"),
          visible: textOf(mEl, "Visible") !== "false",
        });
      }
      const mgDimensions: SsasMgDimension[] = [];
      for (const dimEl of arr(one(mgEl.Dimensions)?.Dimension)) {
        const cubeDimensionId = textOf(dimEl, "CubeDimensionID");
        if (!cubeDimensionId) continue;
        const xsiType = attr(dimEl, "xsi:type") ?? "RegularMeasureGroupDimension";
        let granularity: SsasKeyColumn[] | undefined;
        let granularityAttributeId: string | undefined;
        for (const attrEl of arr(one(dimEl.Attributes)?.Attribute)) {
          if (textOf(attrEl, "Type") !== "Granularity") continue;
          granularityAttributeId = textOf(attrEl, "AttributeID");
          const cols: SsasKeyColumn[] = [];
          for (const kc of arr(one(attrEl.KeyColumns)?.KeyColumn)) {
            const src = parseSource(kc);
            if (src) cols.push(src);
          }
          if (cols.length) granularity = cols;
          break;
        }
        mgDimensions.push({ xsiType, cubeDimensionId, granularity, granularityAttributeId });
      }
      measureGroups.push({ id: mgId, name: textOf(mgEl, "Name") ?? mgId, measures, mgDimensions });
    }
    cubes.push({ id, name: textOf(cubeEl, "Name") ?? id, dsvId, cubeDims, measureGroups });
  }
  return cubes;
}

// ============================================================
// Role-play detection
// ============================================================

function commonSuffixTokens(names: string[]): string[] {
  const tokenLists = names.map((n) => n.split(/\s+/).filter(Boolean));
  if (tokenLists.length < 2) return [];
  const minLen = Math.min(...tokenLists.map((t) => t.length));
  let commonLen = 0;
  for (let i = 1; i <= minLen; i++) {
    const tails = new Set(tokenLists.map((t) => t.slice(-i).map((w) => w.toLowerCase()).join("")));
    if (tails.size === 1) commonLen = i;
    else break;
  }
  return commonLen ? tokenLists[0].slice(-commonLen) : [];
}

/** cube-dim instance id -> role prefix (e.g. "Ship", "Delivery"), only for role-played dims. */
function detectRolePlay(cube: SsasCube): Map<string, string> {
  const byDbDim = new Map<string, SsasCubeDim[]>();
  for (const cd of cube.cubeDims) {
    if (!byDbDim.has(cd.dimensionId)) byDbDim.set(cd.dimensionId, []);
    byDbDim.get(cd.dimensionId)!.push(cd);
  }
  const prefixes = new Map<string, string>();
  for (const members of byDbDim.values()) {
    if (members.length < 2) continue;
    const names = members.map((m) => m.name);
    const suffixTokens = commonSuffixTokens(names);
    for (const m of members) {
      const toks = m.name.split(/\s+/).filter(Boolean);
      const remainder = suffixTokens.length ? toks.slice(0, toks.length - suffixTokens.length) : toks;
      prefixes.set(m.id, remainder.length ? remainder.join(" ") : m.name);
    }
  }
  return prefixes;
}

// ============================================================
// XML tree builder
// ============================================================

interface XmlNode {
  tag: string;
  attrs?: Record<string, string>;
  children?: XmlNode[];
  text?: string;
}

function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
  return escText(s).replace(/"/g, "&quot;");
}

function el(tag: string, attrs?: Record<string, string | undefined>, children?: Array<XmlNode | undefined | false>): XmlNode {
  const cleanAttrs: Record<string, string> = {};
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== undefined) cleanAttrs[k] = v;
  return { tag, attrs: Object.keys(cleanAttrs).length ? cleanAttrs : undefined, children: (children ?? []).filter(Boolean) as XmlNode[] };
}
function textEl(tag: string, value: string): XmlNode {
  return { tag, text: value };
}

function serialize(node: XmlNode, depth = 0): string {
  const pad = "  ".repeat(depth);
  const attrStr = node.attrs
    ? " " + Object.entries(node.attrs).map(([k, v]) => `${k}="${escAttr(v)}"`).join(" ")
    : "";
  if (node.text !== undefined) {
    return `${pad}<${node.tag}${attrStr}>${escText(node.text)}</${node.tag}>`;
  }
  if (!node.children || node.children.length === 0) {
    return `${pad}<${node.tag}${attrStr}/>`;
  }
  const inner = node.children.map((c) => serialize(c, depth + 1)).join("\n");
  return `${pad}<${node.tag}${attrStr}>\n${inner}\n${pad}</${node.tag}>`;
}

// ============================================================
// Conversion
// ============================================================

export type Severity = "error" | "action_needed" | "warning" | "info";
export interface Issue { severity: Severity; category: string; object: string; message: string }

export interface ConvertSsasMdOptions {
  xmlaFileName: string;
  catalogName?: string;
}

export interface ConvertSsasMdResult {
  projectXml: string;
  issues: Issue[];
}

let keyRefCounter = 0;
function nextKeyRefId(prefix: string): string {
  keyRefCounter += 1;
  return `${prefix}_kr${keyRefCounter}`;
}

export async function convertSsasMultidimensionalToXml(
  xmlContent: string,
  opts: ConvertSsasMdOptions,
  logger: Logger,
): Promise<ConvertSsasMdResult> {
  const parser = new Parser({ explicitArray: true, attrkey: "$", charkey: "_", explicitCharkey: false, trim: true, xmlns: false });
  const parsed: Raw = await parser.parseStringPromise(xmlContent);
  const createEl = one(parsed.Create) ?? parsed;
  const objectDef = one(createEl?.ObjectDefinition);
  const databaseEl = objectDef ? one(objectDef.Database) : undefined;
  if (!databaseEl) {
    throw new Error("No <Create><ObjectDefinition><Database> found — input does not look like an SSAS XMLA Create script.");
  }

  const dimensions = parseDimensions(databaseEl);
  for (const dim of dimensions.values()) {
    if (dim.isTabular) {
      throw new Error(
        `Dimension '${dim.name}' has TabularRelationships — this is an SSAS Tabular model, not Multidimensional. ` +
        `Use the 'generate-sml-from-tabular' operation instead.`,
      );
    }
  }
  const cubes = parseCubes(databaseEl);

  const dsvsByid = new Map<string, Map<string, PhysTable>>();
  for (const dsvEl of arr(one(databaseEl.DataSourceViews)?.DataSourceView)) {
    const dsvId = textOf(dsvEl, "ID");
    if (dsvId) dsvsByid.set(dsvId, parseDsvTables(dsvEl));
  }

  const issues: Issue[] = [];
  const logIssue = (severity: Severity, category: string, object: string, message: string) =>
    issues.push({ severity, category, object, message });

  function physTable(dsvTables: Map<string, PhysTable>, tableId: string): PhysTable | undefined {
    return dsvTables.get(tableId);
  }
  function physColumn(dsvTables: Map<string, PhysTable>, c: SsasKeyColumn): PhysColumn | undefined {
    return dsvTables.get(c.tableId)?.columns.get(c.columnId);
  }

  // ── attributes/keyed-attributes registry, datasets, dimensions ──────────────
  const datasetNodes = new Map<string, XmlNode>(); // datasetId -> <data-set>
  const datasetLogicalKeyRefs = new Map<string, XmlNode[]>();
  const datasetAttributeRefs = new Map<string, XmlNode[]>();
  const keyedAttributeNodes: XmlNode[] = [];
  const dimensionAttributeKeyUuid = new Map<string, string>(); // "dimId::attrId" -> globally-unique keyed-attribute id
  const dimensionLevelKeyUuid = new Map<string, string>(); // dimId -> grain-level keyed-attribute id
  const dimensionNodes: XmlNode[] = [];

  function ensureDataset(tableId: string, dsvTables: Map<string, PhysTable>, connectionId: string): void {
    if (datasetNodes.has(tableId)) return;
    const t = physTable(dsvTables, tableId);
    const columns = [...(t?.columns.values() ?? [])].map((c) =>
      el("column", undefined, [textEl("name", c.physicalName), textEl("type", c.dataType)]),
    );
    datasetLogicalKeyRefs.set(tableId, []);
    datasetAttributeRefs.set(tableId, []);
    datasetNodes.set(
      tableId,
      el("data-set", { id: tableId, name: tableId }, [
        el("physical", undefined, [
          el("connection", { id: connectionId }),
          el("table", undefined, [
            textEl("schema", t?.schema ?? ""),
            textEl("name", t?.physicalName ?? tableId),
          ]),
          ...columns,
        ]),
      ]),
    );
  }

  /** Register a key-ref for one attribute's key column(s) inside its own table's dataset. Returns the key-ref id. */
  function registerKeyRef(tableId: string, cols: SsasKeyColumn[], dsvTables: Map<string, PhysTable>, complete: boolean, idHint: string): string {
    const krId = nextKeyRefId(idHint);
    const physCols = cols.map((c) => physColumn(dsvTables, c)?.physicalName ?? c.columnId);
    const krEl = el("key-ref", { id: krId, complete: complete ? "true" : "false", unique: complete ? "true" : undefined },
      physCols.map((pc) => textEl("column", pc)));
    datasetLogicalKeyRefs.get(tableId)?.push(krEl);
    return krId;
  }

  function registerAttributeRef(tableId: string, attrId: string, col: SsasKeyColumn, dsvTables: Map<string, PhysTable>): void {
    const physCol = physColumn(dsvTables, col)?.physicalName ?? col.columnId;
    datasetAttributeRefs.get(tableId)?.push(el("attribute-ref", { id: attrId }, [textEl("column", physCol)]));
  }

  function sanitizeId(s: string): string {
    return s.replace(/[^A-Za-z0-9_]+/g, "_");
  }
  /** Attribute identity is globally unique (keyed-attribute id / primary-attribute / attribute-ref id /
   *  new-ref attribute-id all share this one namespace) — distinct from the key-ref id, which only
   *  needs to be unique enough to match a fact-side and dimension-side key-ref pair. */
  function uniqueAttrId(dimId: string, attrId: string): string {
    return `${sanitizeId(dimId)}__${sanitizeId(attrId)}`;
  }

  const CONNECTION_NAME = "ssas-connection";

  // First pass: build dataset + keyed-attribute registry for every dimension.
  for (const dim of dimensions.values()) {
    const dsvTables = firstDsvTables(dsvsByid, cubes, dim.id) ?? new Map<string, PhysTable>();

    for (const [attrId, ssasAttr] of dim.attributes) {
      if (ssasAttr.usage === "Parent") {
        logIssue("action_needed", "parent_child_dimension", `${dim.name}.${ssasAttr.name}`,
          "Parent-child attribute — not supported in this pass. Needs a manual recursive/parent-child hierarchy design.");
        continue;
      }
      if (ssasAttr.keyColumns.length === 0) continue;
      const keyTableId = ssasAttr.keyColumns[0].tableId;
      ensureDataset(keyTableId, dsvTables, CONNECTION_NAME);
      const krId = registerKeyRef(keyTableId, ssasAttr.keyColumns, dsvTables, true, `${dim.id}_${attrId}`);
      const uid = uniqueAttrId(dim.id, attrId);
      dimensionAttributeKeyUuid.set(`${dim.id}::${attrId}`, uid);

      const nameCol = ssasAttr.nameColumn ?? ssasAttr.keyColumns[0];
      const nameTableId = nameCol.tableId;
      ensureDataset(nameTableId, dsvTables, CONNECTION_NAME);
      registerAttributeRef(nameTableId, uid, nameCol, dsvTables);

      keyedAttributeNodes.push(el("keyed-attribute", { id: uid, name: ssasAttr.name, "key-ref": krId }));
    }
  }

  // Second pass: build the dimension XML (declared hierarchies, or synthesize one from the Key attribute).
  for (const dim of dimensions.values()) {
    const hierarchies = dim.hierarchies.length ? dim.hierarchies : synthesizeHierarchy(dim);
    if (!dim.hierarchies.length && hierarchies.length) {
      logIssue("info", "synthesized_hierarchy", dim.name,
        "No hierarchy declared in SSAS — synthesized a single hierarchy from the Key attribute and its AttributeRelationships.");
    }
    if (!hierarchies.length) {
      logIssue("action_needed", "dimension_has_no_levels", dim.name, "No hierarchy and no Key attribute found — dimension skipped.");
      continue;
    }

    const usedAttrIds = new Set<string>();
    const hierNodes: XmlNode[] = [];
    for (const hier of hierarchies) {
      const levelNodes: XmlNode[] = [];
      for (const level of hier.levels) {
        const attrKeyUuid = dimensionAttributeKeyUuid.get(`${dim.id}::${level.sourceAttributeId}`);
        if (!attrKeyUuid) continue;
        usedAttrIds.add(level.sourceAttributeId);
        if (level.hideMemberIf) {
          logIssue("warning", "ragged_hierarchy", `${dim.name}.${level.name}`,
            `Level has HideMemberIf='${level.hideMemberIf}' (ragged hierarchy) — emitted as a normal level; verify manually.`);
        }
        if (level === hier.levels[hier.levels.length - 1]) {
          if (!dimensionLevelKeyUuid.has(dim.id)) dimensionLevelKeyUuid.set(dim.id, level.sourceAttributeId);
          const secondary: XmlNode[] = [];
          for (const [otherId, otherAttr] of dim.attributes) {
            if (usedAttrIds.has(otherId) || otherAttr.usage === "Parent") continue;
            if (!otherAttr.relatedAttributeIds.includes(level.sourceAttributeId) && hier.levels.length > 1) continue;
            const otherUid = dimensionAttributeKeyUuid.get(`${dim.id}::${otherId}`);
            if (!otherUid) continue;
            secondary.push(el("keyed-attribute-ref", { "attribute-id": otherUid }));
            usedAttrIds.add(otherId);
          }
          levelNodes.push(el("level", { "primary-attribute": attrKeyUuid }, secondary));
        } else {
          levelNodes.push(el("level", { "primary-attribute": attrKeyUuid }));
        }
      }
      if (levelNodes.length) hierNodes.push(el("hierarchy", { name: hier.name || dim.name }, levelNodes));
    }
    // Any remaining unattached attribute goes onto the base (last) level of the first hierarchy.
    if (hierNodes.length) {
      const extras: XmlNode[] = [];
      for (const [otherId] of dim.attributes) {
        if (usedAttrIds.has(otherId)) continue;
        const otherUid = dimensionAttributeKeyUuid.get(`${dim.id}::${otherId}`);
        if (!otherUid) continue;
        extras.push(el("keyed-attribute-ref", { "attribute-id": otherUid }));
      }
      if (extras.length) {
        const lastLevel = hierNodes[0].children![hierNodes[0].children!.length - 1];
        lastLevel.children = [...(lastLevel.children ?? []), ...extras];
      }
      dimensionNodes.push(el("dimension", { id: dim.id, name: dim.name }, hierNodes));
    }
  }

  // ── cubes: measures, fact datasets, joins/role-play ─────────────────────────
  const cubeNodes: XmlNode[] = [];
  for (const cube of cubes) {
    const dsvTables = cube.dsvId ? dsvsByid.get(cube.dsvId) ?? new Map() : new Map<string, PhysTable>();
    const rolePrefixes = detectRolePlay(cube);
    const cubeDimById = new Map(cube.cubeDims.map((cd) => [cd.id, cd]));

    const measureAttrNodes: XmlNode[] = [];
    const factDatasetRefs: XmlNode[] = [];
    let factTableId: string | undefined;

    for (const mg of cube.measureGroups) {
      const firstMeasureCol = mg.measures.find((m) => m.column)?.column;
      const mgFactTableId = firstMeasureCol?.tableId;
      if (!mgFactTableId) {
        logIssue("action_needed", "unresolved_fact_table", mg.name, "Could not resolve a physical fact table for this measure group — skipped.");
        continue;
      }
      ensureDataset(mgFactTableId, dsvTables, CONNECTION_NAME);
      if (!factTableId) factTableId = mgFactTableId;

      for (const m of mg.measures) {
        if (!m.column) continue;
        // The measure's inline <key-ref id> is only a pointer — xml-converter.ts resolves it
        // through the global keyMap, which is only populated from a dataset's own <logical>
        // block, so a real key-ref must also be registered there (not just referenced here).
        const measureKrId = registerKeyRef(mgFactTableId, [m.column], dsvTables, true, `${mg.id}_${m.id}`);
        const typeEl = buildMeasureTypeElement(m.aggregateFunction, measureKrId);
        measureAttrNodes.push(
          el("attribute", { id: m.id, name: m.name }, [
            el("properties", undefined, [
              el("type", undefined, [typeEl]),
              textEl("visible", String(m.visible)),
              ...(m.formatString ? [el("formatting", undefined, [textEl("format-string", m.formatString)])] : []),
            ]),
          ]),
        );
      }

      const mgKeyRefs: XmlNode[] = [];
      for (const mgDim of mg.mgDimensions) {
        if (mgDim.xsiType === "ManyToManyMeasureGroupDimension") {
          logIssue("action_needed", "many_to_many_not_converted", `${mg.name} -> ${mgDim.cubeDimensionId}`,
            "Many-to-many measure group dimension — not converted in this pass. Needs a manual bridge-table relationship design.");
          continue;
        }
        if (mgDim.xsiType === "ReferenceMeasureGroupDimension") {
          logIssue("action_needed", "reference_dimension_not_converted", `${mg.name} -> ${mgDim.cubeDimensionId}`,
            "Reference (chained/snowflaked) measure group dimension — not converted in this pass. Needs a manual relationship design.");
          continue;
        }
        if (!mgDim.granularity || !mgDim.granularityAttributeId) {
          logIssue("warning", "no_granularity_attribute", `${mg.name} -> ${mgDim.cubeDimensionId}`,
            "No Granularity attribute found for this measure-group dimension — relationship skipped.");
          continue;
        }
        const cubeDim = cubeDimById.get(mgDim.cubeDimensionId);
        if (!cubeDim) continue;
        const dim = dimensions.get(cubeDim.dimensionId);
        if (!dim) continue;
        const dimAttr = dim.attributes.get(mgDim.granularityAttributeId);
        if (!dimAttr || dimAttr.keyColumns.length === 0) {
          logIssue("warning", "unresolved_join_attribute", `${mg.name} -> ${cubeDim.name}`,
            "Could not resolve the dimension-side key column(s) for this relationship — skipped.");
          continue;
        }

        const factSideTableId = mgDim.granularity[0].tableId;
        const dimSideTableId = dimAttr.keyColumns[0].tableId;
        const isDegenerate = factSideTableId === mgFactTableId && dimSideTableId === mgFactTableId;

        if (isDegenerate) {
          // Attribute lives directly on the fact dataset — no cross-dataset join needed.
          logIssue("info", "degenerate_dimension", cubeDim.name,
            `'${cubeDim.name}' resolves to the same physical table as its fact ('${mgFactTableId}') — modeled as a fact-hosted attribute, no relationship needed.`);
          continue;
        }

        const targetAttrKeyUuid = dimensionAttributeKeyUuid.get(`${cubeDim.dimensionId}::${mgDim.granularityAttributeId}`);
        if (!targetAttrKeyUuid) {
          logIssue("warning", "unresolved_join_target", `${mg.name} -> ${cubeDim.name}`, "Dimension-side key-ref not found — relationship skipped.");
          continue;
        }

        const rolePrefix = rolePrefixes.get(cubeDim.id);
        const krId = nextKeyRefId(`${mg.id}_${cubeDim.id}`);
        const physFactCols = mgDim.granularity.map((c) => physColumn(dsvTables, c)?.physicalName ?? c.columnId);
        const children: XmlNode[] = physFactCols.map((pc) => textEl("column", pc));
        if (rolePrefix !== undefined) {
          children.push(el("ref-path", undefined, [
            el("new-ref", { "attribute-id": targetAttrKeyUuid }, [textEl("ref-naming", `${rolePrefix} {0}`)]),
          ]));
        }
        mgKeyRefs.push(el("key-ref", { id: rolePrefix !== undefined ? krId : targetAttrKeyUuid, complete: "false" }, children));
      }
      if (mgKeyRefs.length) {
        factDatasetRefs.push(el("data-set-ref", { id: mgFactTableId }, [el("logical", undefined, mgKeyRefs)]));
      } else {
        factDatasetRefs.push(el("data-set-ref", { id: mgFactTableId }));
      }
    }

    if (!factTableId) continue;
    // Fact dataset must be first under <cube><data-sets> (xml-converter.ts takes the first data-set-ref as the fact table).
    factDatasetRefs.sort((a, b) => (a.attrs?.id === factTableId ? -1 : b.attrs?.id === factTableId ? 1 : 0));

    cubeNodes.push(
      el("cube", { id: cube.id, name: cube.name }, [
        el("attributes", undefined, measureAttrNodes),
        el("data-sets", undefined, factDatasetRefs),
      ]),
    );
  }

  // ── assemble final <schema> ──────────────────────────────────────────────────
  const dataSetNodes = [...datasetNodes.entries()].map(([tableId, node]) => {
    const physical = node.children!.find((c) => c.tag === "physical")!;
    const logicalChildren = [...(datasetLogicalKeyRefs.get(tableId) ?? []), ...(datasetAttributeRefs.get(tableId) ?? [])];
    const children = [physical];
    if (logicalChildren.length) children.push(el("logical", undefined, logicalChildren));
    return el("data-set", node.attrs, children);
  });

  const schema = el("schema", { name: opts.catalogName ?? "ssas_multidimensional_import" }, [
    el("attributes", undefined, keyedAttributeNodes),
    el("data-sets", undefined, dataSetNodes),
    el("dimensions", undefined, dimensionNodes),
    el("cubes", undefined, cubeNodes),
  ]);

  const projectXml = `<?xml version="1.0" encoding="UTF-8"?>\n${serialize(schema)}\n`;
  return { projectXml, issues };
}

function buildMeasureTypeElement(aggFn: string, keyRefId: string): XmlNode {
  const keyRef = el("key-ref", { id: keyRefId });
  switch (aggFn) {
    case "DistinctCount":
      return el("count-distinct", undefined, [keyRef]);
    case "Count":
      return el("count-nonnull", undefined, [keyRef]);
    default: {
      const method = { Sum: "SUM", Min: "MIN", Max: "MAX", Average: "AVERAGE" }[aggFn] ?? "SUM";
      return el("measure", undefined, [textEl("default-aggregation", method), keyRef]);
    }
  }
}

/** Synthesize a single hierarchy from a dimension's Key attribute, walking AttributeRelationships
 *  upward to build parent levels (deepest relationship chain first), when SSAS declared none. */
function synthesizeHierarchy(dim: SsasDimension): SsasHierarchy[] {
  const keyAttr = [...dim.attributes.values()].find((a) => a.usage === "Key");
  if (!keyAttr) return [];
  const chain: string[] = [keyAttr.id];
  const seen = new Set([keyAttr.id]);
  let current = keyAttr;
  for (;;) {
    const parentId = current.relatedAttributeIds.find((id) => dim.attributes.has(id) && !seen.has(id));
    if (!parentId) break;
    seen.add(parentId);
    chain.unshift(parentId);
    current = dim.attributes.get(parentId)!;
  }
  return [{
    id: `${dim.id}_hierarchy`,
    name: dim.name,
    levels: chain.map((attrId) => ({
      id: attrId,
      name: dim.attributes.get(attrId)?.name ?? attrId,
      sourceAttributeId: attrId,
    })),
  }];
}

/** Find a usable DSV table map for a dimension: prefer the DSV of any cube that uses it, else the first DSV. */
function firstDsvTables(
  dsvsById: Map<string, Map<string, PhysTable>>,
  cubes: SsasCube[],
  dimensionDbId: string,
): Map<string, PhysTable> | undefined {
  for (const cube of cubes) {
    if (cube.dsvId && cube.cubeDims.some((cd) => cd.dimensionId === dimensionDbId)) {
      const t = dsvsById.get(cube.dsvId);
      if (t) return t;
    }
  }
  return dsvsById.values().next().value;
}
