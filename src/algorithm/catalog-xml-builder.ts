/**
 * Build an AtScale catalog XML (project_2_0 schema) from parsed SML objects.
 *
 * The generated XML is suitable for submission to /wapi/git/deploy/catalog as
 * the `projectXml` field.  Object UUIDs are derived deterministically from
 * the object's unique name and the project name using UUID v5, so repeated
 * calls with identical SML produce identical XML.
 *
 * Scope: only the objects reachable from the specified model are included
 * (referenced dimensions, their datasets, and the fact dataset).
 */
import { v5 as uuidv5, v4 as uuidv4 } from "uuid";

// ── UUID helpers ──────────────────────────────────────────────────────────────

/** Root namespace used as the base for all project-scoped UUID derivations. */
const ROOT_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // URL namespace

/**
 * Build a project-specific UUID namespace deterministically from the project
 * name.  All object UUIDs are derived from this namespace, so the same SML
 * project always produces the same UUIDs.
 */
function projectNamespace(projectName: string): string {
  return uuidv5(`atscale-project:${projectName}`, ROOT_NS);
}

function genId(ns: string, path: string): string {
  return uuidv5(path, ns);
}

// ── Data-type mapping ─────────────────────────────────────────────────────────

const SML_TO_XML_TYPE: Record<string, string> = {
  string:   "String",
  int:      "Int",
  long:     "Long",
  double:   "Double",
  float:    "Float",
  decimal:  "Decimal",
  boolean:  "Boolean",
  date:     "Date",
  datetime: "DateTime",
};

function smlTypeToXml(smlType: string): string {
  return SML_TO_XML_TYPE[(smlType ?? "string").toLowerCase()] ?? "String";
}

// ── XML helpers ───────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Public API ────────────────────────────────────────────────────────────────

export type SmlCatalog      = Record<string, any>;
export type SmlModel        = Record<string, any>;
export type SmlDimension    = Record<string, any>;
export type SmlDataset      = Record<string, any>;
export type SmlMetric       = Record<string, any>;
export type SmlConnection   = Record<string, any>;

export type CatalogXmlInput = {
  catalog:         SmlCatalog;
  model:           SmlModel;
  dimensionsMap:   Map<string, SmlDimension>;
  datasetsMap:     Map<string, SmlDataset>;
  metricsMap:      Map<string, SmlMetric>;
  connectionsMap:  Map<string, SmlConnection>;
  projectName:     string;
  /** UUID of the existing deployed project (engineId).  A new v4 UUID is used if absent. */
  projectId?:      string;
};

export function buildCatalogXml(input: CatalogXmlInput): string {
  const {
    catalog, model, dimensionsMap, datasetsMap, metricsMap, connectionsMap,
    projectName, projectId,
  } = input;

  const engineId = projectId ?? uuidv4();
  const ns       = projectNamespace(projectName);
  const caption  = catalog.label ?? catalog.unique_name ?? "catalog";

  // ── Resolve connection info ──────────────────────────────────────────────────
  // Take the first connection's database/schema defaults.
  let defaultDatabase = "default";
  let defaultSchema   = "default";
  for (const [, conn] of connectionsMap) {
    if (conn.database) defaultDatabase = conn.database;
    if (conn.schema)   defaultSchema   = conn.schema;
    break;
  }

  // ── Collect model relationships ──────────────────────────────────────────────
  const relationships: Array<{
    fromDataset: string;
    joinColumns: string[];
    toDimension: string;
    toLevel:     string;
  }> = [];

  for (const rel of (model.relationships ?? [])) {
    relationships.push({
      fromDataset: rel.from?.dataset   ?? "",
      joinColumns: rel.from?.join_columns ?? [],
      toDimension: rel.to?.dimension   ?? "",
      toLevel:     rel.to?.level       ?? "",
    });
  }

  // ── Resolve referenced dimensions and fact datasets ──────────────────────────
  const refDimNames = new Set(relationships.map((r) => r.toDimension).filter(Boolean));
  const factDatasetNames = new Set(relationships.map((r) => r.fromDataset).filter(Boolean));

  // ── Collect keyed-attributes (join targets) ──────────────────────────────────
  // These are the level attributes in referenced dimensions whose unique_name
  // matches the `to.level` in a model relationship.
  type KeyedAttr = {
    laUniqueName:   string;
    datasetName:    string;
    columnName:     string;
    label:          string;
    keyId:          string; // UUID of the attribute-key element
    attrId:         string; // UUID of the keyed-attribute element
    datasetId:      string; // UUID of the dimension's dataset
  };

  const keyedAttrs: KeyedAttr[] = [];
  const keyedAttrByLevel = new Map<string, KeyedAttr>();

  for (const dimName of refDimNames) {
    const dim = dimensionsMap.get(dimName);
    if (!dim) continue;

    const laMap = new Map<string, any>();
    for (const la of (dim.level_attributes ?? [])) {
      laMap.set(la.unique_name, la);
    }

    for (const rel of relationships) {
      if (rel.toDimension !== dimName) continue;
      const la = laMap.get(rel.toLevel);
      if (!la) continue;

      const keyId  = genId(ns, `${dimName}.${rel.toLevel}.key`);
      const attrId = genId(ns, `${dimName}.${rel.toLevel}.attr`);
      const dsId   = genId(ns, la.dataset ?? "");

      const ka: KeyedAttr = {
        laUniqueName:   la.unique_name,
        datasetName:    la.dataset ?? "",
        columnName:     la.name_column ?? la.key_columns?.[0] ?? la.unique_name,
        label:          la.label ?? la.unique_name,
        keyId,
        attrId,
        datasetId:      dsId,
      };
      keyedAttrs.push(ka);
      keyedAttrByLevel.set(rel.toLevel, ka);
    }
  }

  // ── Collect fact datasets with their metric columns ──────────────────────────
  type FactDatasetEntry = {
    datasetName: string;
    ds:          SmlDataset;
    dsId:        string;
    metrics:     Array<{ unique_name: string; column: string; attrId: string }>;
    joinKeyId?:  string; // attribute-key id for FK (if this dataset joins to a dimension)
    joinColName?: string;
  };

  const factDatasetsMap = new Map<string, FactDatasetEntry>();
  for (const dsName of factDatasetNames) {
    const ds = datasetsMap.get(dsName);
    if (!ds) continue;
    const dsId = genId(ns, dsName);
    factDatasetsMap.set(dsName, {
      datasetName: dsName,
      ds,
      dsId,
      metrics: [],
      joinKeyId:  keyedAttrs[0]?.keyId,
      joinColName: relationships.find((r) => r.fromDataset === dsName)?.joinColumns[0],
    });
  }

  // ── Resolve metrics ──────────────────────────────────────────────────────────
  const modelCubeName = model.unique_name ?? model.label ?? "model";

  for (const metricRef of (model.metrics ?? [])) {
    const mn = typeof metricRef === "string" ? metricRef : metricRef.unique_name;
    const m  = metricsMap.get(mn);
    if (!m) continue;
    const fde = factDatasetsMap.get(m.dataset);
    if (!fde) continue;
    fde.metrics.push({
      unique_name: m.unique_name,
      column:      m.column,
      attrId:      genId(ns, `${modelCubeName}.${m.unique_name}`),
    });
  }

  // ── Collect dimension datasets ───────────────────────────────────────────────
  type DimDatasetEntry = {
    datasetName: string;
    ds:          SmlDataset;
    dsId:        string;
    ka:          KeyedAttr;
  };

  const dimDatasets: DimDatasetEntry[] = [];
  const seenDimDs = new Set<string>();

  for (const ka of keyedAttrs) {
    if (seenDimDs.has(ka.datasetName)) continue;
    seenDimDs.add(ka.datasetName);
    const ds = datasetsMap.get(ka.datasetName);
    if (!ds) continue;
    dimDatasets.push({ datasetName: ka.datasetName, ds, dsId: ka.datasetId, ka });
  }

  // ── Build dimensions XML ─────────────────────────────────────────────────────
  const dimensionsXml = [...refDimNames].map((dimName) => {
    const dim = dimensionsMap.get(dimName);
    if (!dim) return "";
    const dimId = genId(ns, dimName);

    // Build hierarchies — only include hierarchies whose levels are join targets.
    const hierarchiesXml = (dim.hierarchies ?? []).map((h: any) => {
      const hierLevels = (h.levels ?? []).map((l: any) => {
        const ka = keyedAttrByLevel.get(l.unique_name);
        if (!ka) return "";
        const hierId = genId(ns, `${dimName}.${h.unique_name}`);
        return `
      <hierarchy id="${hierId}" name="${esc(h.unique_name)}">
        <properties>
          <caption>${esc(h.label ?? h.unique_name)}</caption>
          <visible>true</visible>
          <filter-empty>Always</filter-empty>
          <default-member><all-member></all-member></default-member>
        </properties>
        <level primary-attribute="${ka.attrId}">
          <properties>
            <unique-in-parent>false</unique-in-parent>
            <visible>true</visible>
          </properties>
        </level>
      </hierarchy>`;
      }).filter(Boolean);
      return hierLevels.join("");
    }).filter(Boolean).join("");

    if (!hierarchiesXml) return "";

    return `
  <dimension id="${dimId}" name="${esc(dimName)}">
    <properties>
      <visible>true</visible>
      <caption>${esc(dim.label ?? dimName)}</caption>
      <dimension-type>Other</dimension-type>
    </properties>${hierarchiesXml}
  </dimension>`;
  }).filter(Boolean).join("");

  // ── Build data-sets XML ──────────────────────────────────────────────────────
  function columnsXml(ds: SmlDataset): string {
    return (ds.columns ?? []).map((col: any) =>
      `\n        <column><name>${esc(col.name)}</name><type>${smlTypeToXml(col.data_type)}</type></column>`,
    ).join("");
  }

  const dimDatasetsXml = dimDatasets.map(({ datasetName, ds, dsId, ka }) => {
    const tableName = ds.table ?? datasetName.replace(/\.dataset$/, "");
    const connId    = ds.connection_id ?? "default";
    const database  = defaultDatabase;
    const schema    = defaultSchema;

    return `
  <data-set id="${dsId}" name="${esc(datasetName)}">
    <properties><allow-aggregates>true</allow-aggregates></properties>
    <physical>
      <connection id="${esc(connId)}"></connection>
      <table>
        <database>${esc(database)}</database>
        <schema>${esc(schema)}</schema>
        <name>${esc(tableName)}</name>
      </table>
      <immutable>false</immutable>${columnsXml(ds)}
    </physical>
    <logical>
      <key-ref id="${ka.keyId}" unique="false" complete="true">
        <column>${esc(ka.columnName)}</column>
      </key-ref>
      <attribute-ref id="${ka.attrId}" complete="true">
        <column>${esc(ka.columnName)}</column>
      </attribute-ref>
    </logical>
  </data-set>`;
  }).join("");

  const factDatasetsXml = [...factDatasetsMap.values()].map(({ datasetName, ds, dsId }) => {
    const tableName = ds.table ?? datasetName.replace(/\.dataset$/, "");
    const connId    = ds.connection_id ?? "default";
    const database  = defaultDatabase;
    const schema    = defaultSchema;

    return `
  <data-set id="${dsId}" name="${esc(datasetName)}">
    <properties><allow-aggregates>true</allow-aggregates></properties>
    <physical>
      <connection id="${esc(connId)}"></connection>
      <table>
        <database>${esc(database)}</database>
        <schema>${esc(schema)}</schema>
        <name>${esc(tableName)}</name>
      </table>
      <immutable>false</immutable>${columnsXml(ds)}
    </physical>
    <logical></logical>
  </data-set>`;
  }).join("");

  // ── Build cubes XML ──────────────────────────────────────────────────────────
  const cubeId = genId(ns, modelCubeName);

  // Measure attributes
  const measureAttrsXml = [...factDatasetsMap.values()].flatMap((fde) =>
    fde.metrics.map((m) => {
      const mn = metricsMap.get(m.unique_name);
      const agg = (mn?.calculation_method ?? "sum").toUpperCase();
      const aggMap: Record<string, string> = {
        "SUM": "SUM", "AVERAGE": "AVG", "MINIMUM": "MIN", "MAXIMUM": "MAX",
        "COUNT NON-NULL": "COUNT", "COUNT": "COUNT",
      };
      const defAgg = aggMap[agg] ?? "SUM";

      return `
      <attribute id="${m.attrId}" name="${esc(m.unique_name)}">
        <properties>
          <visible>true</visible>
          <caption>${esc(mn?.label ?? m.unique_name)}</caption>
          <type><measure><default-aggregation>${defAgg}</default-aggregation></measure></type>
        </properties>
      </attribute>`;
    }),
  ).join("");

  // Cube dataset-refs (one per fact dataset)
  const cubeDsRefsXml = [...factDatasetsMap.values()].map((fde) => {
    const joinKa  = keyedAttrs[0]; // assume single join key
    const keyRef  = joinKa
      ? `\n          <key-ref id="${joinKa.keyId}" unique="false" complete="false"><column>${esc(fde.joinColName ?? "")}</column></key-ref>`
      : "";
    const attrRefs = fde.metrics.map((m) =>
      `\n          <attribute-ref id="${m.attrId}" complete="true"><column>${esc(m.column)}</column></attribute-ref>`,
    ).join("");

    return `
    <data-set-ref id="${fde.dsId}">
      <logical>${keyRef}${attrRefs}
      </logical>
    </data-set-ref>`;
  }).join("");

  const cubesXml = `
  <cube id="${cubeId}" name="${esc(modelCubeName)}">
    <properties>
      <caption>${esc(model.label ?? modelCubeName)}</caption>
      <visible>true</visible>
    </properties>
    <attributes>${measureAttrsXml}
    </attributes>
    <data-sets>${cubeDsRefsXml}
    </data-sets>
    <calculated-members></calculated-members>
  </cube>`;

  // ── Build global attributes XML ──────────────────────────────────────────────
  const attrsXml = keyedAttrs.map((ka) =>
    `\n  <attribute-key id="${ka.keyId}">` +
    `<properties><visible>true</visible><columns>1</columns></properties>` +
    `</attribute-key>` +
    `\n  <keyed-attribute id="${ka.attrId}" key-ref="${ka.keyId}" name="${esc(ka.laUniqueName)}">` +
    `<properties><visible>true</visible><caption>${esc(ka.label)}</caption>` +
    `<type><enum></enum></type>` +
    `<ordering><sort-key><order>ascending</order><value></value></sort-key></ordering>` +
    `</properties></keyed-attribute>`,
  ).join("");

  // ── Assemble XML ─────────────────────────────────────────────────────────────
  return (
    `<schema xmlns="http://www.atscale.com/xsd/project_2_0"` +
    ` name="${esc(projectName)}" version="2.0"` +
    ` xsi:schemaLocation="http://www.atscale.com/xsd/project_2_0 ../../../../../core/src/main/resources/com/atscale/engine/schema/project_2_0.xsd"` +
    ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"` +
    ` xmlns:xsd="http://www.w3.org/2001/XMLSchema">` +
    `<annotations>` +
    `<annotation name="migrationVersion">2020.3.0.1</annotation>` +
    `<annotation name="engineId">${engineId}</annotation>` +
    `<annotation name="version">version-to-be-generated-on-deploy</annotation>` +
    `</annotations>` +
    `<properties>` +
    `<visible>true</visible>` +
    `<caption>${esc(caption)}</caption>` +
    `<aggregate-prediction><speculative-aggregates>false</speculative-aggregates></aggregate-prediction>` +
    `</properties>` +
    `<attributes>${attrsXml}` +
    `\n</attributes>` +
    `<dimensions>${dimensionsXml}` +
    `\n</dimensions>` +
    `<data-sets>${dimDatasetsXml}${factDatasetsXml}` +
    `\n</data-sets>` +
    `<calculated-members></calculated-members>` +
    `<cubes>${cubesXml}` +
    `\n</cubes>` +
    `</schema>`
  );
}
