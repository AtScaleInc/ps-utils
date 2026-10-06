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

  // Datasets reference the SML connection object's unique_name; the engine
  // expects the AtScale data-warehouse connection id (`as_connection`).
  const asConnectionId = (connId: string | undefined): string => {
    if (!connId) return "default";
    return connectionsMap.get(connId)?.as_connection ?? connId;
  };

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

  // ── Collect keyed-attributes ─────────────────────────────────────────────────
  // Every level attribute of a referenced dimension becomes a keyed-attribute —
  // not only the ones named as a relationship's `to.level`. Join keys are rarely
  // browsable attributes, so keeping just those strips out the descriptive levels
  // (names, cities, categories) that make a dimension usable.
  type KeyedAttr = {
    laUniqueName:   string;
    dimName:        string;
    datasetName:    string;
    columnName:     string;  // display column (name_column)
    keyColumn:      string;  // join/key column (key_columns[0]) — often a different type
    label:          string;
    keyId:          string; // UUID of the attribute-key element
    attrId:         string; // UUID of the keyed-attribute element
    datasetId:      string; // UUID of the dimension's dataset
  };

  const keyedAttrs: KeyedAttr[] = [];
  const keyedAttrByLevel = new Map<string, KeyedAttr>();
  // Subset of the above that a model relationship actually joins on.
  const joinAttrs: KeyedAttr[] = [];
  // Secondary attributes hanging off a level, by that level's unique_name.
  const secondaryByLevel = new Map<string, KeyedAttr[]>();
  const seenAttr = new Map<string, KeyedAttr>();

  function addAttr(src: any, dimName: string): KeyedAttr | null {
    if (!src?.unique_name) return null;
    const dedupeKey = `${dimName}::${src.unique_name}`;
    const existing = seenAttr.get(dedupeKey);
    if (existing) return existing;
    const ka: KeyedAttr = {
      laUniqueName: src.unique_name,
      dimName,
      datasetName:  src.dataset ?? "",
      columnName:   src.name_column ?? src.key_columns?.[0] ?? src.unique_name,
      keyColumn:    src.key_columns?.[0] ?? src.name_column ?? src.unique_name,
      label:        src.label ?? src.unique_name,
      keyId:        genId(ns, `${dimName}.${src.unique_name}.key`),
      attrId:       genId(ns, `${dimName}.${src.unique_name}.attr`),
      datasetId:    genId(ns, src.dataset ?? ""),
    };
    seenAttr.set(dedupeKey, ka);
    keyedAttrs.push(ka);
    if (!keyedAttrByLevel.has(src.unique_name)) keyedAttrByLevel.set(src.unique_name, ka);
    return ka;
  }

  function addSecondary(levelName: string, sa: any, dimName: string): void {
    const ka = addAttr(sa, dimName);
    if (!ka) return;
    if (!secondaryByLevel.has(levelName)) secondaryByLevel.set(levelName, []);
    const list = secondaryByLevel.get(levelName)!;
    if (!list.some((x) => x.attrId === ka.attrId)) list.push(ka);
  }

  for (const dimName of refDimNames) {
    const dim = dimensionsMap.get(dimName);
    if (!dim) continue;

    for (const la of (dim.level_attributes ?? [])) {
      addAttr(la, dimName);
      for (const sa of (la?.secondary_attributes ?? [])) addSecondary(la.unique_name, sa, dimName);
    }

    // Secondary attributes are commonly declared on the hierarchy level rather
    // than on the level attribute, so both shapes have to be collected.
    for (const h of (dim.hierarchies ?? [])) {
      for (const l of (h?.levels ?? [])) {
        for (const sa of (l?.secondary_attributes ?? [])) addSecondary(l.unique_name, sa, dimName);
      }
    }

    for (const rel of relationships) {
      if (rel.toDimension !== dimName) continue;
      const ka = keyedAttrByLevel.get(rel.toLevel);
      if (ka) joinAttrs.push(ka);
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
      joinKeyId:  joinAttrs[0]?.keyId,
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
    attrs:       KeyedAttr[];      // every attribute sourced from this dataset
    joinKa?:     KeyedAttr;        // the attribute a relationship joins on, if any
  };

  const dimDatasets: DimDatasetEntry[] = [];
  const attrsByDataset = new Map<string, KeyedAttr[]>();

  for (const ka of keyedAttrs) {
    if (!ka.datasetName) continue;
    if (!attrsByDataset.has(ka.datasetName)) attrsByDataset.set(ka.datasetName, []);
    attrsByDataset.get(ka.datasetName)!.push(ka);
  }

  for (const [datasetName, attrs] of attrsByDataset) {
    const ds = datasetsMap.get(datasetName);
    if (!ds) continue;
    dimDatasets.push({
      datasetName,
      ds,
      dsId:   attrs[0].datasetId,
      attrs,
      joinKa: joinAttrs.find((j) => j.datasetName === datasetName) ?? attrs[0],
    });
  }

  // ── Build dimensions XML ─────────────────────────────────────────────────────
  const dimensionsXml = [...refDimNames].map((dimName) => {
    const dim = dimensionsMap.get(dimName);
    if (!dim) return "";
    const dimId = genId(ns, dimName);

    const dimAttrs = keyedAttrs.filter((k) => k.dimName === dimName);

    // A dimension that declares no hierarchies still needs one, or it has no
    // browsable levels and the engine publishes nothing for it. Fall back to a
    // single hierarchy over the dimension's own level attributes.
    const declared = (dim.hierarchies ?? []).filter((h: any) => (h?.levels ?? []).length > 0);
    const hierDefs = declared.length > 0
      ? declared
      : dimAttrs.length > 0
        ? [{
            unique_name: dimName,
            label:       dim.label ?? dimName,
            levels:      dimAttrs.map((k) => ({ unique_name: k.laUniqueName })),
          }]
        : [];

    // One <hierarchy> per declared hierarchy, holding every level it declares —
    // previously each level emitted a whole duplicate <hierarchy> of its own.
    const hierarchiesXml = hierDefs.map((h: any) => {
      const levelsXml = (h.levels ?? []).map((l: any) => {
        const ka = keyedAttrByLevel.get(l.unique_name);
        if (!ka) return "";
        const secondaryXml = (secondaryByLevel.get(l.unique_name) ?? []).map((s) =>
          `\n          <keyed-attribute-ref attribute-id="${s.attrId}"></keyed-attribute-ref>`,
        ).join("");
        return `
        <level primary-attribute="${ka.attrId}">
          <properties>
            <unique-in-parent>false</unique-in-parent>
            <visible>true</visible>
          </properties>${secondaryXml}
        </level>`;
      }).filter(Boolean).join("");
      if (!levelsXml) return "";
      const hierId = genId(ns, `${dimName}.${h.unique_name}`);
      return `
      <hierarchy id="${hierId}" name="${esc(h.unique_name)}">
        <properties>
          <caption>${esc(h.label ?? h.unique_name)}</caption>
          <visible>true</visible>
          <filter-empty>Always</filter-empty>
          <default-member><all-member></all-member></default-member>
        </properties>${levelsXml}
      </hierarchy>`;
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

  const dimDatasetsXml = dimDatasets.map(({ datasetName, ds, dsId, attrs }) => {
    const tableName = ds.table ?? datasetName.replace(/\.dataset$/, "");
    const connId    = asConnectionId(ds.connection_id);
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
    <logical>${attrs.map((a) => `
      <key-ref id="${a.keyId}" unique="false" complete="true">
        <column>${esc(a.keyColumn)}</column>
      </key-ref>
      <attribute-ref id="${a.attrId}" complete="true">
        <column>${esc(a.columnName)}</column>
      </attribute-ref>`).join("")}
    </logical>
  </data-set>`;
  }).join("");

  const factDatasetsXml = [...factDatasetsMap.values()].map(({ datasetName, ds, dsId }) => {
    const tableName = ds.table ?? datasetName.replace(/\.dataset$/, "");
    const connId    = asConnectionId(ds.connection_id);
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
    // One key-ref per relationship leaving this fact dataset. Emitting only the
    // first join left every dimension after it unreachable from the cube.
    const keyRef = relationships
      .filter((r) => r.fromDataset === fde.datasetName)
      .map((r) => {
        const ka = keyedAttrByLevel.get(r.toLevel);
        if (!ka) return "";
        return `\n          <key-ref id="${ka.keyId}" unique="false" complete="false"><column>${esc(r.joinColumns[0] ?? "")}</column></key-ref>`;
      })
      .filter(Boolean)
      .join("");
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
