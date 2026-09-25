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
import { createHash } from "crypto";
import type { Logger } from "../../logging.js";

// ============================================================
// Public API
// ============================================================

export interface XmlConversionOptions {
  /** SML connection unique_name. If omitted, extracted from XML <physical><connection id="...">. */
  connectionName?: string;
  /** Optional connection type (e.g. "snowflake"). Written as comment only. */
  connectionType?: string;
  /** Override the catalog label. Defaults to schema name. */
  catalogName?: string;
  /** Database name to embed in the connection file (moves db out of individual datasets). */
  connectionDb?: string;
  /** Schema name to embed in the connection file (moves schema out of individual datasets). */
  connectionSchema?: string;
  /** Original XML filename — included in the generated README.md for traceability. */
  xmlFileName?: string;
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
  const output = new Map<string, string>();

  // ---------------------------------------------------------------
  // Conversion report accumulators
  // ---------------------------------------------------------------

  const rptDatasets: DatasetRecord[] = [];
  const rptDimensions: DimRecord[] = [];
  const rptMetrics: MetricRecord[] = [];
  const rptModels: ModelRecord[] = [];
  const rptOmissions: OmissionRecord[] = [];
  const rptUnboundByCube: CubeBindingRecord[] = [];

  // Structural omissions: check for XML features the converter doesn't handle. Perspectives
  // ARE converted (see Phase 7d, per-cube, below) — individual objects a perspective
  // couldn't resolve are still reported, but as item-level "Perspective" omissions, not a
  // blanket "not converted at all" structural one.
  const hasRoles        = arr(schemaEl.roles).length > 0 || arr((schemaEl as Record<string, unknown>)["role"]).length > 0;
  const hasTranslations = arr(schemaEl.translations).length > 0 || arr((schemaEl as Record<string, unknown>).translation).length > 0;

  if (hasRoles) {
    rptOmissions.push({
      category: "Structural",
      item: "Security Roles",
      reason: "Role and grant definitions are not converted.",
      recommendation: "Recreate security roles in the AtScale Design Center after deployment.",
    });
  }
  if (hasTranslations) {
    rptOmissions.push({
      category: "Structural",
      item: "Translations / Localization",
      reason: "Translation overrides are not converted.",
      recommendation: "Add multi-language labels manually to the SML files if localization is required.",
    });
  }

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

  // Datasets with no physical table or SQL binding (will be emitted with placeholder table name)
  const unboundDatasetNames = new Set<string>();
  for (const dsSec of arr(schemaEl["data-sets"])) {
    for (const ds of arr(dsSec["data-set"])) {
      const dsName = a(ds, "name");
      if (!dsName) continue;
      const phys = datasetNameToPhysical.get(dsName);
      if (!phys || (!phys.tableName && !phys.sql)) {
        unboundDatasetNames.add(dsName);
      }
    }
  }

  // Resolve connection name: use explicit option, else extract from XML <physical><connection id="...">, else fallback
  let connName = opts.connectionName;
  if (!connName) {
    for (const phys of datasetNameToPhysical.values()) {
      if (phys.connectionName) { connName = phys.connectionName; break; }
    }
    connName = connName ?? "connection";
  }

  // keyMap: UUID → KeyRefEntry[]
  const keyMap = new Map<string, KeyRefEntry[]>();
  // attrMap: UUID → AttrRefEntry
  const attrMap = new Map<string, AttrRefEntry>();
  // A dimension's own <keyed-attribute-ref ref-id="X"> (a cross-dimension embedded/snowflake
  // relationship) names its join not by a key-ref id directly, but by this separate "ref-path
  // id" X, which some OTHER key-ref elsewhere carries as a plain <ref-path><ref id="X"/></ref-
  // path> child — that key-ref's own id is what keyMap actually indexes. This map bridges the
  // two: ref-path id (X) → the key-ref id that declares it, so the snowflake join's dataset/
  // column pair can be looked up the normal way once the bridge is resolved.
  const refPathIdToKeyRefId = new Map<string, string>();

  function ingestLogical(logicalEl: Record<string, unknown>, datasetName: string): void {
    for (const kr of arr(logicalEl["key-ref"])) {
      const id = a(kr, "id");
      if (!id) continue;
      const complete = a(kr, "complete") ?? "true";
      const unique = a(kr, "unique") === "true";
      const columns = extractColumns(arr(kr.column));
      // Extract role_play from <ref-path><new-ref><ref-naming>Date Created.{0}</ref-naming>
      let rolePlay: string | undefined;
      const refPathEl = first(arr(kr["ref-path"])) as Record<string, unknown> | undefined;
      if (refPathEl) {
        const newRefEl = first(arr(refPathEl["new-ref"])) as Record<string, unknown> | undefined;
        if (newRefEl) {
          const refNaming = s(first(arr(newRefEl["ref-naming"])));
          if (refNaming) rolePlay = refNaming;
        }
        // A plain <ref-path><ref id="X"/></ref-path> (no <new-ref> wrapper) is how a
        // cross-dimension embedded/snowflake attribute names the key-ref that completes its
        // join — see refPathIdToKeyRefId's own comment above.
        const plainRefEl = first(arr(refPathEl.ref)) as Record<string, unknown> | undefined;
        const plainRefId = plainRefEl ? a(plainRefEl, "id") : undefined;
        if (plainRefId) refPathIdToKeyRefId.set(plainRefId, id);
      }
      if (columns.length > 0) {
        const entries = keyMap.get(id) ?? [];
        entries.push({ datasetName, columns, complete, unique, rolePlay });
        keyMap.set(id, entries);
      }
    }
    for (const ar of arr(logicalEl["attribute-ref"])) {
      const id = a(ar, "id");
      if (!id) continue;
      const cols = extractColumns(arr(ar.column));
      if (cols.length === 0) continue;
      const column = cols[0];
      const existing = attrMap.get(id);
      if (!existing) {
        attrMap.set(id, { datasetName, column });
        continue;
      }
      // The same attribute-ref id can be redeclared once per dataset/cube's own <logical>
      // section — a still-incompletely-wired source definition can leave one redeclaration
      // naming a real physical column and another naming a placeholder (often the
      // attribute's own caption text, with spaces, rather than a real snake_case column).
      // Last-write-wins would let a later, bogus redeclaration silently clobber a working
      // one purely by document order — only overwrite an already-valid entry if the
      // existing one doesn't actually verify against its own dataset's known physical
      // columns.
      const existingKnown = datasetNameToPhysical.get(existing.datasetName)?.columns;
      const existingValid = !!existingKnown?.length && existingKnown.some((c) => c.name === existing.column);
      if (existingValid) continue;
      const newKnown = datasetNameToPhysical.get(datasetName)?.columns;
      const newValid = !!newKnown?.length && newKnown.some((c) => c.name === column);
      if (newValid) attrMap.set(id, { datasetName, column });
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
      const description = props ? s(first(arr(props.description))) : undefined;
      const allowedCalcTypesEl = props
        ? (first(arr(props["allowed-calculation-types"])) as Record<string, unknown> | undefined)
        : undefined;
      const allowedCalcTypes = allowedCalcTypesEl
        ? arr(allowedCalcTypesEl["calculation-type"]).map(s).filter((t): t is string => Boolean(t))
        : undefined;
      // Custom sort order: <properties><ordering><sort-key><key-ref id="..."/></sort-key></ordering></properties>.
      // Absent (or a <value/> choice instead of <key-ref>) means "sort by the attribute's own
      // value" — i.e. no override, fall back to name_column, matching the XSD-declared default.
      const orderingEl = props ? (first(arr(props.ordering)) as Record<string, unknown> | undefined) : undefined;
      const sortKeyEl = orderingEl ? (first(arr(orderingEl["sort-key"])) as Record<string, unknown> | undefined) : undefined;
      const sortKeyRefEl = sortKeyEl ? (first(arr(sortKeyEl["key-ref"])) as Record<string, unknown> | undefined) : undefined;
      const sortKeyUuid = sortKeyRefEl ? a(sortKeyRefEl, "id") : undefined;
      attrDef.set(id, {
        name, caption, keyUuid, formatString, namedFormat, folder, visible, description,
        allowedCalcTypes: allowedCalcTypes?.length ? allowedCalcTypes : undefined,
        sortKeyUuid,
      });
    }
  }

  // Metrical attributes: schema-level plain <attribute> elements (as opposed to
  // <keyed-attribute>) — measures attached to a dimension level rather than to a cube. A
  // level links to one via a plain <attribute-ref attribute-id="..."> child (distinct from
  // <keyed-attribute-ref>, which is always a secondary attribute).
  const metricalAttrDef = new Map<string, MetricalAttrDef>();
  // A plain <attribute> can instead carry <properties><dynamic-constraint><user-constraint
  // enabled="true"/></dynamic-constraint></properties> — AtScale's row-level-security
  // binding, wiring a hidden dimension/table pair to the engine's per-user constraint
  // system rather than to a normal fact-to-dimension join. It has no measure/count/sum
  // type, so the loop below never builds a metricalAttrDef entry for it, but it is still
  // real, active content — recorded here so the schema-level dimension it's attached to
  // (checked further down, once schemaDims/referencedDimNames exist) isn't misclassified
  // as dead schema cruft just because no cube ever joins to it.
  const rlsBoundAttrIds = new Set<string>();
  function ingestMetricalAttrs(attrsEl: Record<string, unknown>): void {
    for (const attrEl of arr(attrsEl.attribute)) {
      const id = a(attrEl, "id");
      const name = a(attrEl, "name");
      if (!id || !name) continue;
      const props = first(arr((attrEl as Record<string, unknown>).properties)) as
        | Record<string, unknown>
        | undefined;
      if (!props) continue;
      const dynamicConstraintEl = first(arr(props["dynamic-constraint"])) as Record<string, unknown> | undefined;
      const userConstraintEl = dynamicConstraintEl
        ? (first(arr(dynamicConstraintEl["user-constraint"])) as Record<string, unknown> | undefined)
        : undefined;
      if (userConstraintEl && a(userConstraintEl, "enabled") !== "false") rlsBoundAttrIds.add(id);
      const typeEl = first(arr(props.type)) as Record<string, unknown> | undefined;
      if (!typeEl) continue;

      const measureEl = first(arr(typeEl.measure)) as Record<string, unknown> | undefined;
      const countDistEl = first(arr(typeEl["count-distinct"])) as Record<string, unknown> | undefined;
      const countNonNullEl = first(arr(typeEl["count-nonnull"])) as Record<string, unknown> | undefined;
      const sumDistinctEl = first(arr(typeEl["sum-distinct"])) as Record<string, unknown> | undefined;
      const quantileGroupEl = first(arr(typeEl["quantile-group"])) as Record<string, unknown> | undefined;
      const quantileInstanceEl = first(arr(typeEl["quantile-instance"])) as Record<string, unknown> | undefined;
      const isQuantile = Boolean(quantileGroupEl || quantileInstanceEl);
      if (!measureEl && !countDistEl && !countNonNullEl && !sumDistinctEl && !isQuantile) continue;

      const caption = s(first(arr(props.caption)));
      const folder = s(first(arr(props.folder)));
      const description = s(first(arr(props.description)));
      const visibleStr = s(first(arr(props.visible)));
      const visible = visibleStr !== "false";
      const fmtEl = first(arr(props.formatting)) as Record<string, unknown> | undefined;
      const formatString = fmtEl ? s(first(arr(fmtEl["format-string"]))) : undefined;
      const namedFormat = fmtEl ? s(first(arr(fmtEl["named-format"]))) : undefined;
      const isAggregatableStr = s(first(arr(props["is-aggregatable"])));
      const isAggregatable = isAggregatableStr === "false" ? false : undefined;

      let aggregation: string | undefined;
      let measureTypeEl: Record<string, unknown> | undefined;
      if (!isQuantile) {
        const countDistApprox = countDistEl ? s(first(arr(countDistEl.approximate))) === "true" : false;
        const aggText = measureEl
          ? (s(first(arr(measureEl["default-aggregation"])))?.toUpperCase() ?? "SUM")
          : countDistEl
          ? (countDistApprox ? "DISTINCT_COUNT_ESTIMATE" : "COUNT_DISTINCT")
          : sumDistinctEl
          ? "SUM_DISTINCT"
          : "COUNT";
        aggregation = mapAggregation(aggText);
        measureTypeEl = measureEl ?? countDistEl ?? countNonNullEl ?? sumDistinctEl;
      }
      const unrelatedDimensionsHandling = parseUnrelatedDimensionsHandling(measureTypeEl);
      const keyRefEl = measureTypeEl
        ? (first(arr(measureTypeEl["key-ref"])) as Record<string, unknown> | undefined)
        : undefined;
      const keyRefId = keyRefEl ? a(keyRefEl, "id") : undefined;

      metricalAttrDef.set(id, {
        id, name, caption, folder, visible, description, formatString, namedFormat,
        aggregation, isQuantile, unrelatedDimensionsHandling, isAggregatable, keyRefId,
      });
    }
  }

  // Schema-level attributes
  for (const attrsSec of arr(schemaEl.attributes)) {
    ingestKeyedAttrs(attrsSec as Record<string, unknown>);
    ingestMetricalAttrs(attrsSec as Record<string, unknown>);
  }

  // Collect cubes for processing and gather their data
  const cubeEls: Record<string, unknown>[] = [];
  for (const cubesSec of arr(schemaEl.cubes)) {
    for (const cube of arr(cubesSec.cube)) {
      cubeEls.push(cube as Record<string, unknown>);
    }
  }

  // Schema-level <perspectives><perspective cube-ref="..."> — grouped by the cube they
  // apply to, so each cube's own conversion phase (below) can resolve just its own
  // perspectives against maps (attrIdToMetricUniqueName etc.) that only exist per-cube.
  const perspectivesByCubeId = new Map<string, Record<string, unknown>[]>();
  for (const perspectivesSec of arr(schemaEl.perspectives)) {
    for (const perspectiveEl of arr(perspectivesSec.perspective)) {
      const cubeRef = a(perspectiveEl, "cube-ref");
      if (!cubeRef) continue;
      const list = perspectivesByCubeId.get(cubeRef) ?? [];
      list.push(perspectiveEl as Record<string, unknown>);
      perspectivesByCubeId.set(cubeRef, list);
    }
  }

  // Cube-level attributes and data-set-refs
  // Datasets no cube ever references are dead schema artifacts (common in migrated/legacy
  // projects) and should not be emitted — tracked here so Phase 2 can skip them.
  const referencedDatasetNames = new Set<string>();
  for (const cube of cubeEls) {
    for (const attrsSec of arr(cube.attributes)) {
      ingestKeyedAttrs(attrsSec as Record<string, unknown>);
    }
    for (const dsSec of arr(cube["data-sets"])) {
      for (const dsRef of arr(dsSec["data-set-ref"])) {
        const refId = a(dsRef, "id");
        const dsName = refId ? (datasetIdToName.get(refId) ?? refId) : undefined;
        if (!dsName) continue;
        referencedDatasetNames.add(dsName);
        for (const logSec of arr(dsRef.logical)) {
          ingestLogical(logSec as Record<string, unknown>, dsName);
        }
      }
    }
  }

  // ---------------------------------------------------------------
  // Phase 2: Emit dataset files
  // ---------------------------------------------------------------

  // Datasets without an explicit <physical> column list (e.g. fact tables meant to be
  // introspected live from the database) still need every referenced column declared in
  // SML. Collect every column any key-ref/attribute-ref points to, per dataset.
  const referencedColumnsByDataset = new Map<string, Set<string>>();
  function addReferencedColumn(datasetName: string, column: string): void {
    const set = referencedColumnsByDataset.get(datasetName) ?? new Set<string>();
    set.add(column);
    referencedColumnsByDataset.set(datasetName, set);
  }
  for (const entries of keyMap.values()) {
    for (const entry of entries) {
      for (const col of entry.columns) addReferencedColumn(entry.datasetName, col);
    }
  }
  for (const entry of attrMap.values()) {
    addReferencedColumn(entry.datasetName, entry.column);
  }
  collectMeasureColumns(cubeEls, datasetIdToName, keyMap, attrMap, datasetNameToPhysical, addReferencedColumn);

  // The actual dataset-emission loop runs after Phase 3b (dimensions), once
  // referencedDatasetNames also accounts for datasets only used by dimensions — see there.

  // ---------------------------------------------------------------
  // Phase 3: Collect dimension elements
  // ---------------------------------------------------------------

  // Two different cubes — or a cube and the shared schema — can each declare their own
  // dimension under the exact same display name for genuinely different underlying
  // attributes (e.g. one cube's own inline "Shared Dim Name" lookup table vs another
  // cube's completely separate degenerate "Shared Dim Name" bound directly to its fact
  // table). A raw name is not a safe map key across the whole file: whichever dimension
  // happened to be visited last would silently overwrite the other's entry, and the
  // survivor could end up with one dimension's type/is_degenerate paired with the other's
  // dataset binding. Every dimension element's id is resolved to a final (possibly
  // disambiguated, "_2"/"_3"-suffixed) name exactly once here, so every later lookup by id
  // — including from a different cube — agrees on the same name instead of colliding.
  const dimIdToName = new Map<string, string>();
  const dimNameClaimedBy = new Map<string, string>();
  function resolveDimName(dim: Record<string, unknown>): string | undefined {
    const rawName = a(dim, "name");
    if (!rawName) return undefined;
    const id = a(dim, "id");
    if (!id) return rawName;
    const existing = dimIdToName.get(id);
    if (existing) return existing;
    const claimant = dimNameClaimedBy.get(rawName);
    let finalName = rawName;
    if (claimant && claimant !== id) {
      let n = 2;
      while (dimNameClaimedBy.has(`${rawName}_${n}`)) n++;
      finalName = `${rawName}_${n}`;
    }
    dimNameClaimedBy.set(finalName, id);
    dimIdToName.set(id, finalName);
    return finalName;
  }

  // Schema-level shared dimensions (keyed by name)
  const schemaDims = new Map<string, Record<string, unknown>>();
  for (const dimsSec of arr(schemaEl.dimensions)) {
    for (const dim of arr(dimsSec.dimension)) {
      const name = resolveDimName(dim as Record<string, unknown>);
      if (name) schemaDims.set(name, dim as Record<string, unknown>);
    }
  }

  // Per-cube inline dimensions (emitted later, scoped to each cube)
  // Also build a global map for dimension YAML emission (all dims across all cubes)
  const allDims = new Map<string, Record<string, unknown>>(schemaDims);
  for (const cube of cubeEls) {
    for (const dimsSec of arr(cube.dimensions)) {
      for (const dim of arr(dimsSec.dimension)) {
        const name = resolveDimName(dim as Record<string, unknown>);
        if (name) allDims.set(name, dim as Record<string, unknown>);
      }
    }
  }

  // User Defined Aggregates (and perspectives, below) reference dimension attributes by
  // id, with an optional ref-path for attributes reached through a snowflake/embedded
  // relationship rather than hosted natively — resolve all these mappings once, up front,
  // for all dimensions.
  const { attrIdToDimName, refIdToHostDimName, hierarchyIdToRef, primaryAttrIdToLevelRef } =
    collectAttributeDimensionOwnership(allDims, attrDef);

  // A composite key's default name_column (below) needs to know which of its columns are
  // themselves the sole key of some OTHER level elsewhere in the schema — see
  // collectSoleKeyColumns for the reasoning.
  const soleKeyColumns = collectSoleKeyColumns(allDims, attrDef, keyMap);

  // We emit dimension YAMLs after processing cubes (so we know which dims are referenced)
  const referencedDimNames = new Set<string>();
  // A schema-level dimension whose level attaches an RLS-bound attribute (rlsBoundAttrIds,
  // above) via a plain <attribute-ref attribute-id="..."> is genuine, active content even
  // though no cube ever joins to it. Seed referencedDimNames with it up front so the
  // "Schema-level dimensions no cube joins to are excluded from output" check further down
  // treats it like any cube-referenced dimension instead of dropping it — and its backing
  // dataset — as dead schema cruft.
  if (rlsBoundAttrIds.size > 0) {
    for (const [dimName, dimEl] of schemaDims) {
      for (const hierEl of arr(dimEl.hierarchy)) {
        for (const levelEl of arr(hierEl.level)) {
          for (const aref of arr((levelEl as Record<string, unknown>)["attribute-ref"])) {
            const attrId = a(aref, "attribute-id");
            if (attrId && rlsBoundAttrIds.has(attrId)) referencedDimNames.add(dimName);
          }
        }
      }
    }
  }
  // inferRelationships already determines, per cube, whether a dimension is degenerate
  // (no relationship, attaches directly) or has a real relationship — buildDimensionYaml
  // must use that same determination for its own is_degenerate/type field rather than
  // re-deriving it independently, or the two can disagree for a multi-fact cube (a
  // dimension can be degenerate relative to one cube-bound dataset yet have a genuine
  // relationship from the cube's primary fact table via a different dataset/column).
  // A dimension used by multiple cubes with a real relationship in any of them is not
  // degenerate overall, so the relationship set takes precedence when both are present.
  const globalDegenerateDimNames = new Set<string>();
  const globalRelationshipDimNames = new Set<string>();
  // Degenerate dimensions can draw the same level from more than one fact dataset (e.g. a
  // flag column present on both a cube's primary fact table and its YTD fact table) — SML's
  // shared_degenerate_columns models exactly this. Aggregated across every cube in the file
  // (dimName -> levelName -> datasetName -> keyColumns) so buildDimensionYaml can tell a
  // single-dataset degenerate level (plain dataset/key_columns) from a shared one.
  const globalDegenerateBindings = new Map<string, Map<string, Map<string, string[]>>>();
  // Schema-level calculated members are emitted per-cube below (Phase 7) when a cube
  // references them by id; tracked here so a leftover pass after the cube loop can report
  // an omission (like the "declared but not referenced" dataset note below) for every one
  // no cube ever references, instead of it vanishing from the output with no trace.
  const emittedCalcMemberIds = new Set<string>();

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

  // Map every measure/calculated-member's original name to its final unique_name, so
  // calculation expressions referencing other metrics by name can be rewritten to match.
  const measureRefMap = buildMeasureRefMap(cubeEls, calcMemberDefs);

  // Determine, across every cube up front, which dimensions may validly use SML's
  // shared-degenerate mechanism — a decision made cube-by-cube can't see a dimension's
  // bindings in OTHER cubes, but SML's constraints (every level of the dimension sharing
  // the same set of fact datasets; every dataset's key/name column for a shared level having
  // the same physical type) can only be verified with the full picture. See
  // computeEligibleDegenerateDimensions for what disqualifies a dimension.
  const { eligible: eligibleDegenerateDimNames, rejected: rejectedDegenerateDims } =
    computeEligibleDegenerateDimensions(cubeEls, schemaDims, keyMap, attrDef, datasetIdToName, datasetNameToPhysical, dimIdToName, primaryAttrIdToLevelRef);
  for (const r of rejectedDegenerateDims) {
    rptOmissions.push({
      category: "Dimension",
      item: r.dimName,
      reason: r.reason,
      recommendation: "Review this dimension's fact-table bindings manually — some levels may need a relationship instead of a direct column, or the source data types must be reconciled before it can be modeled as a shared degenerate dimension.",
    });
  }

  // ---------------------------------------------------------------
  // Phase 4+5+Model: Process each cube
  // ---------------------------------------------------------------

  // Metric/calc-member dedup is project-wide, not per-cube — the reference converter
  // (AtScaleToML.addMetrics) checks the whole project for an existing metric with the same
  // name before creating a new one: if a later cube defines an identically-named measure
  // with the SAME definition (dataset/column/aggregation), that cube just gets a reference
  // to the existing metrics/*.yml file; only a genuinely different definition under the
  // same name gets its own distinct unique_name. Scoping this per-cube instead meant a
  // second cube reusing a common measure name silently overwrote the first cube's file.
  const seenMetricNames = new Set<string>();
  // Tracks, per emitted measure unique_name, whether its column actually resolved to a
  // declared physical column on its dataset — see the duplicate-measure handling below.
  const metricHasKnownColumn = new Map<string, boolean>();
  // Signature (dataset|column|calculation_method) of whichever definition currently backs
  // each emitted metric unique_name — used to tell "same measure reused by another cube"
  // (just add a reference) from "different measure that happens to share a name" (rename).
  const metricDefSignature = new Map<string, string>();
  // A calculated member's expression can reference another calculated member by its original
  // XML name — but that other member's final unique_name isn't settled until dedup/rename
  // resolution actually runs, which can rename it away from the naive safeName transform to
  // avoid colliding with an unrelated, differently-defined calc member whose name collapses
  // to the same string once punctuation is stripped (e.g. "Foo$" and "Foo%" both become
  // "Foo"). measureRefMap is built once, up front, before any of that resolution has
  // happened, so a formula referencing a member that later gets renamed was rewritten against
  // its stale, pre-rename target — and if that stale name happens to equal the *referencing*
  // member's own final name, the rewritten formula ends up referencing itself. Calculated-
  // member emission is deferred (pendingCalcMembers) until every cube has been processed and
  // every member's real final name is known, then rewritten using calcOriginalNameToFinalName
  // layered over the naive measureRefMap — the same reasoning as why semi-additive metrics
  // already defer past relationship inference.
  const pendingCalcMembers: Array<{
    fname: string;
    uniqueName: string;
    label: string;
    def: CalcMemberDef;
    format?: string;
    renamedFrom?: string;
  }> = [];
  const calcOriginalNameToFinalName = new Map<string, string>();

  // Each cube's model file is built once Phase 3b (below) has resolved every dimension's
  // snowflake relationships — see the comment where this is pushed to, further down.
  const pendingModels: Array<{
    cubeName: string;
    relationships: RelationshipDef[];
    cubeDimNames: string[];
    metricNames: Array<{ uniqueName: string; folder?: string }>;
    aggregates: AggregateDef[];
    perspectives: PerspectiveDef[];
    cubeVisible: boolean;
    includeDefaultDrillthrough: boolean;
    cubeBoundDatasets: string[];
  }> = [];

  for (const cube of cubeEls) {
    const cubeName = a(cube, "name") ?? schemaName;
    const cubeId = a(cube, "id");

    // Classify all dataset refs for this cube as bound or unbound
    const cubeBoundDatasets: string[] = [];
    const cubeUnboundDatasets: string[] = [];
    for (const dsSec of arr(cube["data-sets"])) {
      for (const dsRef of arr(dsSec["data-set-ref"])) {
        const refId = a(dsRef, "id");
        if (!refId) continue;
        const dsName = datasetIdToName.get(refId);
        if (!dsName) continue; // completely unknown ID — skip
        if (unboundDatasetNames.has(dsName)) {
          if (!cubeUnboundDatasets.includes(dsName)) cubeUnboundDatasets.push(dsName);
        } else {
          if (!cubeBoundDatasets.includes(dsName)) cubeBoundDatasets.push(dsName);
        }
      }
    }
    if (cubeUnboundDatasets.length > 0) {
      rptUnboundByCube.push({ cubeName, boundDatasets: cubeBoundDatasets, unboundDatasets: cubeUnboundDatasets });
    }

    // Find fact dataset name for this cube
    const factDatasetName = getFactDatasetName(cube, datasetIdToName);

    // Extract include_default_drillthrough from <actions><properties><include-default-drill-through>
    const actionsEl = first(arr(cube.actions)) as Record<string, unknown> | undefined;
    const actionPropsEl = actionsEl
      ? (first(arr(actionsEl.properties)) as Record<string, unknown> | undefined)
      : undefined;
    const includeDefaultDrillthrough = actionPropsEl
      ? s(first(arr(actionPropsEl["include-default-drill-through"]))) === "true"
      : false;

    const metricNames: Array<{ uniqueName: string; folder?: string }> = [];
    // User Defined Aggregates reference measures/calc members by attribute id — record each
    // emitted metric's id alongside its transformed unique_name so aggregate parsing (below)
    // can resolve them the same way the reference converter does.
    const attrIdToMetricUniqueName = new Map<string, string>();
    // Semi-additive measures (<additivity>) reference a dimension level via attribute-ref,
    // which only resolves to a model relationship's unique_name once Phase 5 has run — so
    // emission here is provisional and gets overwritten with the resolved semi_additive
    // block once relationships are known (see the fixup loop after inferRelationships).
    const pendingSemiAdditiveMetrics: Array<{
      fname: string;
      uniqueName: string;
      label: string;
      aggregation: string;
      measureDatasetName: string;
      column: string;
      format?: string;
      folder?: string;
      visible: boolean;
      description?: string;
      unrelatedDimensionsHandling?: string;
      isAggregatable?: boolean;
      position: string;
      attrRefIds: string[];
    }> = [];

    // AtScale represents a percentile measure as two linked attributes: a hidden
    // <quantile-group> (the base column + a compression/T-Digest setting) and one or more
    // visible <quantile-instance> attributes, each pinning a specific quantile of that
    // group. SML has no such split — a single `percentile` metric carries the column,
    // compression and quantile together — so the group defs are collected up front and
    // resolved when each instance is processed below.
    const quantileGroupDefs = new Map<string, { baseAttrId?: string; compression?: number }>();
    for (const attrsSec of arr(cube.attributes)) {
      for (const attrEl of arr((attrsSec as Record<string, unknown>).attribute)) {
        const attrId = a(attrEl, "id");
        if (!attrId) continue;
        const props = first(arr((attrEl as Record<string, unknown>).properties)) as
          | Record<string, unknown>
          | undefined;
        const typeEl = props ? (first(arr(props.type)) as Record<string, unknown> | undefined) : undefined;
        const qgEl = typeEl ? (first(arr(typeEl["quantile-group"])) as Record<string, unknown> | undefined) : undefined;
        if (!qgEl) continue;
        const baseRefEl = first(arr(qgEl["attribute-ref"])) as Record<string, unknown> | undefined;
        const compressionStr = s(first(arr(qgEl.compression)));
        quantileGroupDefs.set(attrId, {
          baseAttrId: baseRefEl ? a(baseRefEl, "id") : undefined,
          compression: compressionStr ? Number(compressionStr) : undefined,
        });
      }
    }

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
        const countNonNullEl = first(arr(typeEl["count-nonnull"])) as
          | Record<string, unknown>
          | undefined;
        const sumDistinctEl = first(arr(typeEl["sum-distinct"])) as
          | Record<string, unknown>
          | undefined;
        // AtScale represents a percentile measure as two linked attributes: a hidden
        // <quantile-group> (base column + compression) and one or more <quantile-instance>
        // attributes, each pinning a specific quantile of that group (see quantileGroupDefs
        // pre-pass above). quantileGroupEl is detected here only so its own attribute is
        // excluded from every branch below — it carries no value of its own; only
        // quantile-instance converts to a real percentile metric.
        const quantileGroupEl = first(arr(typeEl["quantile-group"])) as Record<string, unknown> | undefined;
        const quantileInstanceEl = first(arr(typeEl["quantile-instance"])) as Record<string, unknown> | undefined;
        const exprEl = s(first(arr((attrEl as Record<string, unknown>).expression)));

        const caption = s(first(arr(props.caption)));
        const folder = s(first(arr(props.folder)));
        const description = s(first(arr(props.description)));
        const visibleStr = s(first(arr(props.visible)));
        const visible = visibleStr !== "false";
        const fmtEl = first(arr(props.formatting)) as Record<string, unknown> | undefined;
        const formatString = fmtEl ? s(first(arr(fmtEl["format-string"]))) : undefined;
        const namedFormat = fmtEl ? s(first(arr(fmtEl["named-format"]))) : undefined;
        const format = resolveFormat(formatString, namedFormat);
        // <properties><is-aggregatable>false</is-aggregatable></properties> — defaults to true.
        const isAggregatableStr = s(first(arr(props["is-aggregatable"])));
        const isAggregatable = isAggregatableStr === "false" ? false : undefined;

        if (measureEl || countDistEl || countNonNullEl || sumDistinctEl) {
          // Regular measure
          // <count-distinct> defaults to exact ("count distinct") unless explicitly marked
          // <approximate>true</approximate> — mapping every count-distinct to the estimated
          // variant silently changes query precision for exact-count measures.
          const countDistApprox = countDistEl ? s(first(arr(countDistEl.approximate))) === "true" : false;
          // <unrelated-dimensions> is nested under the measure/count-distinct/count-nonnull/
          // sum-distinct element itself, as a choice of empty
          // <unrelated-dimensions-{empty,repeat,error}/>.
          const measureTypeElForUnrelated = measureEl ?? countDistEl ?? countNonNullEl ?? sumDistinctEl;
          const unrelatedDimensionsHandling = parseUnrelatedDimensionsHandling(measureTypeElForUnrelated);
          const aggText = measureEl
            ? (s(first(arr(measureEl["default-aggregation"])))?.toUpperCase() ?? "SUM")
            : countDistEl
            ? (countDistApprox ? "DISTINCT_COUNT_ESTIMATE" : "COUNT_DISTINCT")
            : sumDistinctEl
            ? "SUM_DISTINCT"
            : "COUNT";
          const aggregation = mapAggregation(aggText);

          // Resolve column: prefer the inline <key-ref id="..."> nested under <measure>/
          // <count-distinct>/<count-nonnull>/<sum-distinct> (resolved through keyMap, same
          // as dimension level attributes), then attrMap[attrId] (attribute-ref in the fact
          // dataset's logical section), then fall back to guessing the column from the
          // attribute's own name.
          const measureTypeEl = measureEl ?? countDistEl ?? countNonNullEl ?? sumDistinctEl;
          const keyRefEl = measureTypeEl
            ? (first(arr(measureTypeEl["key-ref"])) as Record<string, unknown> | undefined)
            : undefined;
          const keyRefId = keyRefEl ? a(keyRefEl, "id") : undefined;
          const keyRefEntries = keyRefId ? keyMap.get(keyRefId) ?? [] : [];
          const keyRefAuthEntry = pickAuthEntry(keyRefEntries, datasetNameToPhysical);

          const colRef = attrMap.get(attrId);
          const resolvedFromReference = keyRefAuthEntry?.columns[0] ?? colRef?.column;
          const column = resolvedFromReference ?? parseColumnFromAttrName(attrNameRaw);
          // A cube can bind multiple fact datasets (data-set-refs); factDatasetName is only
          // the first one and is a last-resort fallback for name-guessed columns with no
          // resolved reference. Whenever the key-ref/attribute-ref actually resolved, prefer
          // ITS dataset — otherwise every measure in a multi-fact cube silently gets bound to
          // the first fact table regardless of which one its own column actually lives in.
          const measureDatasetName = keyRefAuthEntry?.datasetName ?? colRef?.datasetName ?? factDatasetName;
          // An attribute with no key-ref and no attribute-ref anywhere (a genuinely
          // incomplete/orphaned definition left over in the source schema — see
          // m_MEASURE_B_sum_2 for a representative example) falls back to guessing a column
          // from the attribute's own name. When the target dataset declares its physical
          // columns and the guess doesn't match any of them, that guess is worthless —
          // without this check it manufactures a "phantom" column (string-typed, since
          // nothing else is known about it) and binds the metric to a column the real table
          // doesn't have, instead of being reported as unresolved like every other measure
          // this converter genuinely can't place.
          const knownColumns = datasetNameToPhysical.get(measureDatasetName)?.columns;
          const isUnverifiableGuess = !resolvedFromReference && !!knownColumns?.length && !knownColumns.some((c) => c.name === column);
          if (!column || !measureDatasetName || isUnverifiableGuess) {
            rptOmissions.push({
              category: "Metric",
              item: attrNameRaw,
              reason: !measureDatasetName
                ? "No fact dataset could be identified for this cube"
                : isUnverifiableGuess
                  ? `Could not resolve a real column reference for this measure (no key-ref or attribute-ref) — guessed column "${column}" from the attribute's own name, but ${measureDatasetName} has no such column`
                  : "Could not resolve the measure column reference from attribute-ref mapping",
              recommendation: "Add this measure manually to the appropriate metrics/*.yml file after verifying the fact table column name.",
            });
            continue;
          }

          // Semi-additive measures: <additivity><subspace><aggregation-function>...
          // </aggregation-function><attribute-ref id="..."/></subspace></additivity> marks
          // the dimension level(s) that should not be summarized. The attribute-ref only
          // resolves to a model relationship once Phase 5 (inferRelationships) has run, so
          // record it here and finalize via pendingSemiAdditiveMetrics below.
          let semiAdditive: { position: string; attrRefIds: string[] } | undefined;
          if (measureEl) {
            const additivityEl = first(arr(measureEl.additivity)) as Record<string, unknown> | undefined;
            const subspaceEl = additivityEl
              ? (first(arr(additivityEl.subspace)) as Record<string, unknown> | undefined)
              : undefined;
            if (subspaceEl) {
              const aggFnText = s(first(arr(subspaceEl["aggregation-function"])));
              const position = aggFnText ? mapAdditivityPosition(aggFnText) : undefined;
              const attrRefIds = arr(subspaceEl["attribute-ref"])
                .map((r) => a(r as Record<string, unknown>, "id"))
                .filter((id): id is string => !!id);
              if (position && attrRefIds.length > 0) {
                semiAdditive = { position, attrRefIds };
              } else {
                rptOmissions.push({
                  category: "Metric",
                  item: attrNameRaw,
                  reason: `Semi-additive aggregation function "${aggFnText}" has no SML equivalent, or its non-summarized attribute could not be identified — converted as a plain ${aggregation} metric instead.`,
                  recommendation: "Verify whether this measure needs a manually-added semi_additive block after conversion.",
                });
              }
            }
          }

          const label = caption ?? toTitleCase(attrNameRaw);
          // Preserve the source XML's own casing (matching how dimensions/levels already
          // behave, and the reference converter) — BI tools like Power BI/Excel/Tableau
          // bind report fields to the exact unique_name string, so force-lowercasing here
          // silently breaks every existing report built against a prior deployment.
          const uniqueName = truncateUniqueName(safeName(attrNameRaw));
          // Dedup key is case-insensitive — matching the reference converter's own
          // CASE_INSENSITIVE_ORDER qnMap — so "Sales" and "sales" collide even though
          // their unique_name strings differ, but the emitted file/unique_name still uses
          // the original casing.
          const dedupKey = uniqueName.toLowerCase();
          const isKnownColumn = datasetNameToPhysical.get(measureDatasetName)?.columns?.some((c) => c.name === column) ?? false;
          // Dedup is project-wide (see metricDefSignature above): a measure with the exact
          // same definition (dataset|column|calculation_method|visibility) already emitted
          // — by this cube or an earlier one — just gets referenced again, matching the
          // reference converter's existsExactlyInProject check; only a genuinely different
          // definition sharing the same name needs to be told apart. Visibility is part of
          // the signature so two same-named, same-bound measures that differ only in
          // visible/hidden don't silently collapse into one, discarding whichever's
          // is_hidden the second occurrence declared.
          const sig = `${measureDatasetName}|${column}|${aggregation}|${visible}`;
          if (seenMetricNames.has(dedupKey)) {
            if (metricDefSignature.get(dedupKey) === sig) {
              attrIdToMetricUniqueName.set(attrId, uniqueName);
              metricNames.push({ uniqueName, folder: folder || undefined });
              continue;
            }
            // The source XML can define the same measure name twice, bound to different
            // columns — e.g. a stale duplicate whose column was never actually declared on
            // its dataset. Silently keeping "whichever came first" can pin the measure to a
            // column SML can't type (falls back to string), breaking any calc that does
            // arithmetic with it. Prefer whichever duplicate resolves to a real declared
            // physical column, matching the reference converter's own dedup behavior.
            if (isKnownColumn && !metricHasKnownColumn.get(dedupKey)) {
              attrIdToMetricUniqueName.set(attrId, uniqueName);
              metricHasKnownColumn.set(dedupKey, true);
              metricDefSignature.set(dedupKey, sig);
              const fname = safeFilename(uniqueName);
              output.set(
                `metrics/${fname}.yml`,
                buildMetricYaml(uniqueName, label, aggregation, measureDatasetName, column, format, folder, visible, description, unrelatedDimensionsHandling, isAggregatable),
              );
              if (semiAdditive) {
                pendingSemiAdditiveMetrics.push({ fname, uniqueName, label, aggregation, measureDatasetName, column, format, folder, visible, description, unrelatedDimensionsHandling, isAggregatable, ...semiAdditive });
              }
              logger.log(`  → metrics/${fname}.yml (replacing an earlier duplicate with an unresolved column)`);
              continue;
            }
            // Different real definition under the same name (typically two different cubes
            // legitimately reusing a measure name) — give it a distinct unique_name instead
            // of silently overwriting the earlier cube's metrics/*.yml with this one's
            // definition, which would corrupt whatever already references the original name.
            const altUniqueName = truncateUniqueName(`${safeName(attrNameRaw)}_${safeName(cubeName)}`);
            const altDedupKey = altUniqueName.toLowerCase();
            if (!seenMetricNames.has(altDedupKey)) {
              seenMetricNames.add(altDedupKey);
              metricHasKnownColumn.set(altDedupKey, isKnownColumn);
              metricDefSignature.set(altDedupKey, sig);
              attrIdToMetricUniqueName.set(attrId, altUniqueName);
              const fname = safeFilename(altUniqueName);
              output.set(
                `metrics/${fname}.yml`,
                buildMetricYaml(altUniqueName, label, aggregation, measureDatasetName, column, format, folder, visible, description, unrelatedDimensionsHandling, isAggregatable),
              );
              if (semiAdditive) {
                pendingSemiAdditiveMetrics.push({ fname, uniqueName: altUniqueName, label, aggregation, measureDatasetName, column, format, folder, visible, description, unrelatedDimensionsHandling, isAggregatable, ...semiAdditive });
              }
              logger.log(`  → metrics/${fname}.yml (renamed — "${uniqueName}" already denotes a different measure elsewhere)`);
              metricNames.push({ uniqueName: altUniqueName, folder: folder || undefined });
              rptMetrics.push({ name: altUniqueName, label, file: `metrics/${fname}.yml`, metricType: "measure", aggregation, folder: folder || undefined, isHidden: !visible });
            } else {
              rptOmissions.push({
                category: "Metric",
                item: attrNameRaw,
                reason: `Duplicate measure name (unique_name "${uniqueName}") with a different definition than the one already emitted elsewhere in the project — excluded to avoid corrupting the existing metrics/*.yml file.`,
                recommendation: "Rename one of the source measures in the XML so they produce distinct unique_names.",
              });
            }
            continue;
          }
          seenMetricNames.add(dedupKey);
          metricHasKnownColumn.set(dedupKey, isKnownColumn);
          metricDefSignature.set(dedupKey, sig);
          attrIdToMetricUniqueName.set(attrId, uniqueName);
          const fname = safeFilename(uniqueName);
          output.set(
            `metrics/${fname}.yml`,
            buildMetricYaml(uniqueName, label, aggregation, measureDatasetName, column, format, folder, visible, description, unrelatedDimensionsHandling, isAggregatable),
          );
          if (semiAdditive) {
            pendingSemiAdditiveMetrics.push({ fname, uniqueName, label, aggregation, measureDatasetName, column, format, folder, visible, description, unrelatedDimensionsHandling, isAggregatable, ...semiAdditive });
          }
          logger.log(`  → metrics/${fname}.yml`);
          metricNames.push({ uniqueName, folder: folder || undefined });
          rptMetrics.push({ name: uniqueName, label, file: `metrics/${fname}.yml`, metricType: "measure", aggregation, folder: folder || undefined, isHidden: !visible });
        } else if (quantileGroupEl) {
          // Hidden plumbing — see the quantileGroupDefs pre-pass and the quantile-instance
          // branch below, which is what actually converts to a percentile metric. This
          // attribute carries no value of its own.
        } else if (quantileInstanceEl) {
          // Percentile measure (see the quantile-group pre-pass above for context).
          const groupRefEl = first(arr(quantileInstanceEl["quantile-group-ref"])) as
            | Record<string, unknown>
            | undefined;
          const groupRefId = groupRefEl ? a(groupRefEl, "id") : undefined;
          const groupDef = groupRefId ? quantileGroupDefs.get(groupRefId) : undefined;
          const quantileValStr = s(first(arr(quantileInstanceEl["quantile-val"])));
          const quantileVal = quantileValStr !== undefined ? Number(quantileValStr) : undefined;
          const baseColRef = groupDef?.baseAttrId ? attrMap.get(groupDef.baseAttrId) : undefined;
          const column = baseColRef?.column;
          const measureDatasetName = baseColRef?.datasetName ?? factDatasetName;

          if (!groupDef || quantileVal === undefined || Number.isNaN(quantileVal) || !column || !measureDatasetName) {
            rptOmissions.push({
              category: "Metric",
              item: attrNameRaw,
              reason: "Could not resolve this percentile (quantile) measure's base column or its quantile-group definition",
              recommendation: "Add this measure manually to metrics/*.yml with calculation_method: percentile.",
            });
            continue;
          }

          const label = caption ?? toTitleCase(attrNameRaw);
          const uniqueName = truncateUniqueName(safeName(attrNameRaw));
          const dedupKey = uniqueName.toLowerCase();
          // Same project-wide dedup pattern as regular measures above (visibility included,
          // see the comment there): a percentile metric with the exact same definition
          // already emitted just gets referenced again; a different definition (including a
          // different visibility) under the same name gets its own distinct unique_name.
          const sig = `${measureDatasetName}|${column}|percentile|${visible}`;
          if (seenMetricNames.has(dedupKey)) {
            if (metricDefSignature.get(dedupKey) === sig) {
              attrIdToMetricUniqueName.set(attrId, uniqueName);
              metricNames.push({ uniqueName, folder: folder || undefined });
              continue;
            }
            const altUniqueName = truncateUniqueName(`${safeName(attrNameRaw)}_${safeName(cubeName)}`);
            const altDedupKey = altUniqueName.toLowerCase();
            if (!seenMetricNames.has(altDedupKey)) {
              seenMetricNames.add(altDedupKey);
              metricDefSignature.set(altDedupKey, sig);
              attrIdToMetricUniqueName.set(attrId, altUniqueName);
              const fname = safeFilename(altUniqueName);
              output.set(
                `metrics/${fname}.yml`,
                buildPercentileMetricYaml(altUniqueName, label, measureDatasetName, column, groupDef.compression, quantileVal, format, folder, visible, description),
              );
              logger.log(`  → metrics/${fname}.yml (renamed — "${uniqueName}" already denotes a different measure elsewhere)`);
              metricNames.push({ uniqueName: altUniqueName, folder: folder || undefined });
              rptMetrics.push({ name: altUniqueName, label, file: `metrics/${fname}.yml`, metricType: "measure", aggregation: "percentile", folder: folder || undefined, isHidden: !visible });
            } else {
              rptOmissions.push({
                category: "Metric",
                item: attrNameRaw,
                reason: `Duplicate measure name (unique_name "${uniqueName}") with a different definition than the one already emitted elsewhere in the project — excluded to avoid an invalid duplicate entry in the model's metrics list.`,
                recommendation: "Rename one of the source measures in the XML so they produce distinct unique_names.",
              });
            }
            continue;
          }
          seenMetricNames.add(dedupKey);
          metricDefSignature.set(dedupKey, sig);
          attrIdToMetricUniqueName.set(attrId, uniqueName);
          const fname = safeFilename(uniqueName);
          output.set(
            `metrics/${fname}.yml`,
            buildPercentileMetricYaml(uniqueName, label, measureDatasetName, column, groupDef.compression, quantileVal, format, folder, visible, description),
          );
          logger.log(`  → metrics/${fname}.yml`);
          metricNames.push({ uniqueName, folder: folder || undefined });
          rptMetrics.push({ name: uniqueName, label, file: `metrics/${fname}.yml`, metricType: "measure", aggregation: "percentile", folder: folder || undefined, isHidden: !visible });
        } else if (exprEl) {
          // Inline expression (calculated measure on attribute element)
          const label = caption ?? toTitleCase(attrNameRaw);
          const uniqueName = truncateUniqueName(safeName(attrNameRaw));
          const dedupKey = uniqueName.toLowerCase();
          if (seenMetricNames.has(dedupKey)) {
            if (metricDefSignature.get(dedupKey) === attrId) {
              // Same attribute (by id), reused by another cube — just reference it.
              attrIdToMetricUniqueName.set(attrId, uniqueName);
              metricNames.push({ uniqueName, folder: folder || undefined });
              continue;
            }
            // Different real definition under the same name — Java always renames a colliding
            // calculated member (via recordQueryNameOverrides) rather than dropping it, so
            // give this one a distinct unique_name too instead of losing it entirely.
            const altUniqueName = truncateUniqueName(`${safeName(attrNameRaw)}_${safeName(cubeName)}`);
            const altDedupKey = altUniqueName.toLowerCase();
            if (!seenMetricNames.has(altDedupKey)) {
              seenMetricNames.add(altDedupKey);
              metricDefSignature.set(altDedupKey, attrId);
              attrIdToMetricUniqueName.set(attrId, altUniqueName);
              const fname = safeFilename(altUniqueName);
              output.set(
                `metrics/${fname}.yml`,
                buildCalcMemberYaml(altUniqueName, label, rewriteMeasureRefs(unescapeHtml(exprEl), measureRefMap), format, folder, visible, description),
              );
              logger.log(`  → metrics/${fname}.yml (renamed — "${uniqueName}" already denotes a different measure elsewhere)`);
              metricNames.push({ uniqueName: altUniqueName, folder: folder || undefined });
              rptMetrics.push({ name: altUniqueName, label, file: `metrics/${fname}.yml`, metricType: "calculated_measure", folder: folder || undefined, isHidden: !visible });
            } else {
              rptOmissions.push({
                category: "Metric",
                item: attrNameRaw,
                reason: `Duplicate measure name (unique_name "${uniqueName}") with a different definition than the one already emitted elsewhere in the project — excluded to avoid an invalid duplicate entry in the model's metrics list.`,
                recommendation: "Rename one of the source measures in the XML so they produce distinct unique_names.",
              });
            }
            continue;
          }
          seenMetricNames.add(dedupKey);
          metricDefSignature.set(dedupKey, attrId);
          attrIdToMetricUniqueName.set(attrId, uniqueName);
          const fname = safeFilename(uniqueName);
          // The reference converter has no "calculated measure inline on a cube attribute"
          // shape distinct from a schema-level <calculated-member> — both always become an
          // SML metric_calc (object_type: metric_calc, expression:), never a plain metric
          // with an unrecognized "formula" key.
          output.set(
            `metrics/${fname}.yml`,
            buildCalcMemberYaml(uniqueName, label, rewriteMeasureRefs(unescapeHtml(exprEl), measureRefMap), format, folder, visible, description),
          );
          logger.log(`  → metrics/${fname}.yml`);
          metricNames.push({ uniqueName, folder: folder || undefined });
          rptMetrics.push({ name: uniqueName, label, file: `metrics/${fname}.yml`, metricType: "calculated_measure", folder: folder || undefined, isHidden: !visible });
        }
      }
    }

    // Phase 7: Emit calculated members referenced by this cube
    for (const cmSec of arr(cube["calculated-members"])) {
      for (const cmRef of arr(cmSec["calculated-member-ref"])) {
        const refId = a(cmRef, "id");
        const def = refId ? calcMemberDefs.get(refId) : undefined;
        if (!def) continue;
        emittedCalcMemberIds.add(refId!);
        const label = def.caption ?? def.name;
        const uniqueName = truncateUniqueName(safeName(def.name));
        const dedupKey = uniqueName.toLowerCase();
        if (seenMetricNames.has(dedupKey)) {
          if (metricDefSignature.get(dedupKey) === refId) {
            // Same calculated member (by id), shared across multiple cubes — just reference it.
            attrIdToMetricUniqueName.set(refId!, uniqueName);
            metricNames.push({ uniqueName, folder: def.folder || undefined });
            continue;
          }
          // Different real definition under the same name — Java always renames a colliding
          // calculated member (via recordQueryNameOverrides) rather than dropping it.
          const altUniqueName = truncateUniqueName(`${safeName(def.name)}_${safeName(cubeName)}`);
          const altDedupKey = altUniqueName.toLowerCase();
          if (!seenMetricNames.has(altDedupKey)) {
            seenMetricNames.add(altDedupKey);
            metricDefSignature.set(altDedupKey, refId!);
            attrIdToMetricUniqueName.set(refId!, altUniqueName);
            calcOriginalNameToFinalName.set(def.name.toLowerCase(), altUniqueName);
            const format = resolveFormat(def.formatString, def.namedFormat);
            const fname = safeFilename(altUniqueName);
            pendingCalcMembers.push({ fname, uniqueName: altUniqueName, label, def, format, renamedFrom: uniqueName });
            metricNames.push({ uniqueName: altUniqueName, folder: def.folder || undefined });
            rptMetrics.push({ name: altUniqueName, label, file: `calculations/${fname}.yml`, metricType: "calculated_member", folder: def.folder || undefined, isHidden: !def.visible });
          } else {
            rptOmissions.push({
              category: "Calculated Member",
              item: def.name,
              reason: `Duplicate calculated member name (unique_name "${uniqueName}") with a different definition than the one already emitted elsewhere in the project — excluded to avoid an invalid duplicate entry in the model's metrics list.`,
              recommendation: "Rename one of the source calculated members in the XML so they produce distinct unique_names.",
            });
          }
          continue;
        }
        seenMetricNames.add(dedupKey);
        metricDefSignature.set(dedupKey, refId!);
        attrIdToMetricUniqueName.set(refId!, uniqueName);
        calcOriginalNameToFinalName.set(def.name.toLowerCase(), uniqueName);
        const format = resolveFormat(def.formatString, def.namedFormat);
        const fname = safeFilename(uniqueName);
        pendingCalcMembers.push({ fname, uniqueName, label, def, format });
        metricNames.push({ uniqueName, folder: def.folder || undefined });
        rptMetrics.push({ name: uniqueName, label, file: `calculations/${fname}.yml`, metricType: "calculated_member", folder: def.folder || undefined, isHidden: !def.visible });
      }
    }

    // Phase 7d: Perspectives — schema-level <perspectives><perspective cube-ref="..."> whose
    // cube-ref names this cube.
    //
    // Each perspective is a "hide list": a <flat-attributes> section listing individual
    // secondary attributes/levels/measures to hide (by attribute id, resolved the same way
    // Phase 8's aggregates resolve one below), a <calculated-members> section listing
    // calculated members to hide (by id, via attrIdToMetricUniqueName), and a nested
    // <flat-dimensions><flat-dimension-ref>/<flat-hierarchy-ref>/<flat-level-ref> tree that
    // hides a whole dimension, a whole hierarchy, or a level (and everything below it) —
    // matching SML's own dimensions[].hierarchies[].level hide semantics closely enough that
    // the three nesting depths translate directly. Every <properties><visible> defaults to
    // true (not hidden) when absent, same convention used for cube/dimension visibility
    // elsewhere in this file.
    const perspectives: PerspectiveDef[] = [];
    for (const perspectiveEl of cubeId ? perspectivesByCubeId.get(cubeId) ?? [] : []) {
      const perspectiveName = a(perspectiveEl, "name");
      if (!perspectiveName) continue;
      const uniqueName = truncateUniqueName(safeName(perspectiveName));
      const hiddenMetrics: string[] = [];
      const hiddenDimensions = new Map<string, PerspectiveDimensionDef>();

      const getDimEntry = (dimName: string): PerspectiveDimensionDef => {
        let entry = hiddenDimensions.get(dimName);
        if (!entry) {
          entry = { wholeDimensionHidden: false, hiddenHierarchies: new Map(), hiddenSecondaryAttributes: new Set() };
          hiddenDimensions.set(dimName, entry);
        }
        return entry;
      };

      // <flat-dimensions><flat-dimension-ref id>[<flat-hierarchy-ref id>[<flat-level-ref
      // primary-attribute>]]> — a nesting depth of dimension → hierarchy → level, each with
      // its own visible flag; only the deepest explicitly-hidden node in a branch matters.
      for (const fdSec of arr(perspectiveEl["flat-dimensions"])) {
        for (const fdRef of arr((fdSec as Record<string, unknown>)["flat-dimension-ref"])) {
          const dimId = a(fdRef, "id");
          const dimName = dimId ? dimIdToName.get(dimId) : undefined;
          if (!dimName) {
            rptOmissions.push({
              category: "Perspective",
              item: `Dimension ${dimId ?? "?"} in perspective "${perspectiveName}"`,
              reason: "Could not resolve this flat-dimension-ref id to a known dimension.",
              recommendation: "Verify the perspective manually and hide the equivalent dimension in the converted model.",
            });
            continue;
          }
          if (isExplicitlyHidden(fdRef)) {
            getDimEntry(dimName).wholeDimensionHidden = true;
            continue;
          }
          for (const fhRef of arr((fdRef as Record<string, unknown>)["flat-hierarchy-ref"])) {
            const hierId = a(fhRef, "id");
            const hierRef = hierId ? hierarchyIdToRef.get(hierId) : undefined;
            if (!hierRef) {
              rptOmissions.push({
                category: "Perspective",
                item: `Hierarchy ${hierId ?? "?"} in perspective "${perspectiveName}"`,
                reason: "Could not resolve this flat-hierarchy-ref id to a known hierarchy.",
                recommendation: "Verify the perspective manually and hide the equivalent hierarchy in the converted model.",
              });
              continue;
            }
            if (isExplicitlyHidden(fhRef)) {
              getDimEntry(dimName).hiddenHierarchies.set(hierRef.hierUniqueName, undefined);
              continue;
            }
            for (const flRef of arr((fhRef as Record<string, unknown>)["flat-level-ref"])) {
              const primaryAttrId = a(flRef, "primary-attribute");
              const levelRef = primaryAttrId ? primaryAttrIdToLevelRef.get(primaryAttrId) : undefined;
              if (!levelRef) {
                rptOmissions.push({
                  category: "Perspective",
                  item: `Level ${primaryAttrId ?? "?"} in perspective "${perspectiveName}"`,
                  reason: "Could not resolve this flat-level-ref id to a known level.",
                  recommendation: "Verify the perspective manually and hide the equivalent level in the converted model.",
                });
                continue;
              }
              if (isExplicitlyHidden(flRef)) {
                getDimEntry(dimName).hiddenHierarchies.set(levelRef.hierUniqueName, levelRef.levelUniqueName);
              }
            }
          }
        }
      }

      // <flat-attributes><flat-attribute-ref id> — hides one measure, level, or secondary
      // attribute by attribute id, resolved the same way Phase 8's aggregate attributes are.
      for (const faSec of arr(perspectiveEl["flat-attributes"])) {
        for (const faRef of arr((faSec as Record<string, unknown>)["flat-attribute-ref"])) {
          const attrId = a(faRef, "id");
          if (!attrId || !isExplicitlyHidden(faRef)) continue;

          const metricName = attrIdToMetricUniqueName.get(attrId);
          if (metricName) {
            hiddenMetrics.push(metricName);
            continue;
          }
          const levelRef = primaryAttrIdToLevelRef.get(attrId);
          if (levelRef) {
            getDimEntry(levelRef.dimName).hiddenHierarchies.set(levelRef.hierUniqueName, levelRef.levelUniqueName);
            continue;
          }
          const kaDef = attrDef.get(attrId);
          const secondaryDimName = attrIdToDimName.get(attrId);
          if (kaDef && secondaryDimName) {
            getDimEntry(secondaryDimName).hiddenSecondaryAttributes.add(truncateUniqueName(safeName(kaDef.name)));
            continue;
          }
          rptOmissions.push({
            category: "Perspective",
            item: `Attribute ${attrId} in perspective "${perspectiveName}"`,
            reason: "Could not resolve this flat-attribute-ref id to a known measure, level, or secondary attribute.",
            recommendation: "Verify the perspective manually and hide the equivalent object in the converted model.",
          });
        }
      }

      // <calculated-members><calculated-member-ref id> — same hide-list shape as
      // flat-attribute-ref, but always resolves through attrIdToMetricUniqueName.
      for (const cmSec of arr(perspectiveEl["calculated-members"])) {
        for (const cmRef of arr((cmSec as Record<string, unknown>)["calculated-member-ref"])) {
          const refId = a(cmRef, "id");
          if (!refId || !isExplicitlyHidden(cmRef)) continue;
          const metricName = attrIdToMetricUniqueName.get(refId);
          if (metricName) {
            hiddenMetrics.push(metricName);
          } else {
            rptOmissions.push({
              category: "Perspective",
              item: `Calculated member ${refId} in perspective "${perspectiveName}"`,
              reason: "Could not resolve this calculated-member-ref id to a known calculated member.",
              recommendation: "Verify the perspective manually and hide the equivalent calculation in the converted model.",
            });
          }
        }
      }

      perspectives.push({ uniqueName, label: perspectiveName, hiddenMetrics, hiddenDimensions });
    }

    // Phase 8: User Defined Aggregates (hinted aggregate tables)
    //
    // <cube><aggregates><aggregate id name><attributes><attribute-ref id>[<ref-path><ref id>]>
    // mixes dimension attributes and measures in the same <attributes> list — there is no
    // separate <metrics> element in the source XML. Each attribute-ref id is resolved
    // against whatever this cube already emitted/knows about: a measure/calc-member id
    // (attrIdToMetricUniqueName) routes to the aggregate's metrics: list; a dimension
    // keyed-attribute id (attrIdToDimName) routes to attributes: as {name, dimension}. A
    // ref-path present on the attribute-ref means the attribute is reached through a
    // snowflake/embedded relationship rather than hosted natively — its host dimension is
    // looked up via refIdToHostDimName and combined into relationships_path.
    const aggregates: AggregateDef[] = [];
    for (const aggsSec of arr(cube.aggregates)) {
      for (const aggEl of arr((aggsSec as Record<string, unknown>).aggregate)) {
        const aggName = a(aggEl, "name");
        if (!aggName) continue;

        // <properties><name>...</name><caching/></properties> — the aggregate's own display
        // label (distinct from its XML "name" attribute, which is really an id/technical
        // name) and whether it's pinned in the engine's local cache.
        const aggPropsEl = first(arr((aggEl as Record<string, unknown>).properties)) as
          | Record<string, unknown>
          | undefined;
        const aggLabel = aggPropsEl ? s(first(arr(aggPropsEl.name))) : undefined;
        const aggCaching = aggPropsEl && arr(aggPropsEl.caching).length > 0 ? "engine-memory" : undefined;

        const attributes: AggregateDef["attributes"] = [];
        const metrics: string[] = [];

        for (const attrsWrap of arr((aggEl as Record<string, unknown>).attributes)) {
          for (const attrRef of arr((attrsWrap as Record<string, unknown>)["attribute-ref"])) {
            const refAttrId = a(attrRef, "id");
            if (!refAttrId) continue;

            // An aggregate can name a percentile measure's hidden <quantile-group> attribute
            // directly (the base-column definition a <quantile-instance> pins a specific
            // quantile of — see quantileGroupDefs above) rather than the visible metric it
            // backs. The quantile-group attribute itself was never emitted as its own metric,
            // so resolve through to its base attribute's metric before giving up.
            const resolvedAttrId = quantileGroupDefs.get(refAttrId)?.baseAttrId ?? refAttrId;
            const metricUniqueName = attrIdToMetricUniqueName.get(resolvedAttrId);
            if (metricUniqueName) {
              metrics.push(metricUniqueName);
              continue;
            }

            const kaDef = attrDef.get(refAttrId);
            const targetDimName = attrIdToDimName.get(refAttrId);
            if (!kaDef || !targetDimName) {
              rptOmissions.push({
                category: "User Defined Aggregate",
                item: `${aggName} → ${refAttrId}`,
                reason: "Could not resolve this attribute-ref to a known measure or dimension attribute — the id may point at a schema element this converter does not yet parse.",
                recommendation: `Verify attribute id ${refAttrId} manually and add it to models/*.yml aggregates[].attributes or .metrics if needed.`,
              });
              continue;
            }

            // Must match the level's own unique_name convention (safeName + truncate — see
            // levelUniqueNameFor), not just the raw attribute name: the level this aggregate
            // references was itself emitted with spaces replaced (e.g. "Foo_Bar"), so
            // referencing it here with the raw spaced name ("Foo Bar") points at an object
            // that doesn't exist, even though the dimension itself legitimately keeps spaces
            // in its own name.
            const attrOut: AggregateDef["attributes"][number] = {
              name: primaryAttrIdToLevelRef.get(refAttrId)?.levelUniqueName ?? levelUniqueNameFor(kaDef.name),
              dimension: targetDimName,
            };

            const refPathEl = first(arr((attrRef as Record<string, unknown>)["ref-path"])) as
              | Record<string, unknown>
              | undefined;
            const pathRefId = refPathEl ? a(first(arr(refPathEl.ref)) as Record<string, unknown> | undefined ?? {}, "id") : undefined;
            if (pathRefId) {
              const hostDimName = refIdToHostDimName.get(pathRefId);
              if (hostDimName) {
                attrOut.relationshipsPath = [
                  `${hostDimName.replace(/\s+/g, "")}_${targetDimName.replace(/\s+/g, "")}`,
                ];
              }
            }

            attributes.push(attrOut);
          }
        }

        if (attributes.length === 0 && metrics.length === 0) continue;
        aggregates.push({ uniqueName: aggName, label: aggLabel ?? aggName, attributes, metrics, caching: aggCaching });
      }
    }

    // Cube-level structural omission checks (run once per cube)
    if (arr(cube["named-sets"]).length > 0 || arr((cube as Record<string, unknown>)["named-set"]).length > 0) {
      if (!rptOmissions.some((o) => o.item === "Named Sets")) {
        rptOmissions.push({
          category: "Structural",
          item: "Named Sets",
          reason: "Named set definitions (cube-level) are not converted — no direct SML equivalent.",
          recommendation: "Recreate named sets as saved filters or query parameters in the consuming BI tool.",
        });
      }
    }
    if (arr(cube.kpis).length > 0 || arr((cube as Record<string, unknown>).kpi).length > 0) {
      if (!rptOmissions.some((o) => o.item === "KPIs")) {
        rptOmissions.push({
          category: "Structural",
          item: "KPIs",
          reason: "KPI definitions are not converted — no direct SML equivalent.",
          recommendation: "Recreate KPI targets and statuses as calculated metrics or in the BI tool layer.",
        });
      }
    }

    // Build per-cube relevant dims: this cube's inline dims + schema-level shared dims
    const relevantDims = buildRelevantDims(cube, schemaDims, dimIdToName);

    // Phase 5: Infer relationships
    const { relationships, degenerateDimNames, degenerateBindings } = inferRelationships(cube, factDatasetName, keyMap, attrDef, relevantDims, datasetIdToName, eligibleDegenerateDimNames, primaryAttrIdToLevelRef);

    // Resolve semi-additive measures deferred from Phase 4: each attribute-ref names a
    // dimension level (via attrDef), which is matched against this cube's own relationships
    // by (fromDataset, toLevel) to find the relationship unique_name semi_additive.relationships
    // needs. A level with no matching relationship (e.g. a degenerate dimension, which SML
    // would instead require via semi_additive.degenerate_dimensions) is reported rather than
    // silently emitted with an empty/wrong relationships list.
    for (const pm of pendingSemiAdditiveMetrics) {
      const resolvedRelationshipNames: string[] = [];
      const resolvedDegenerateDims: Array<{ name: string; level: string }> = [];
      let ambiguous = false;
      for (const refId of pm.attrRefIds) {
        const levelDef = attrDef.get(refId);
        // A role-played dimension (e.g. "Order Date"/"Ship Date" both pointing at the same
        // Date level from this fact dataset) can produce MORE THAN ONE relationship matching
        // (fromDataset, toLevel) — picking the first arbitrarily would silently attach
        // semi-additivity to the wrong role. There's no reliable way to resolve which
        // specific role a semi-additive <attribute-ref>'s <ref-path> names (it's an id-path
        // through existing keyed-attribute-refs, not the ref-naming string relationships are
        // keyed by), so a genuine ambiguity is reported instead of guessed.
        const levelUniqueName = primaryAttrIdToLevelRef.get(refId)?.levelUniqueName ?? (levelDef ? levelUniqueNameFor(levelDef.name) : undefined);
        const matches = levelUniqueName
          ? relationships.filter((r) => r.fromDataset === pm.measureDatasetName && r.toLevel === levelUniqueName)
          : [];
        if (matches.length > 1) {
          ambiguous = true;
          continue;
        }
        if (matches.length === 1) {
          resolvedRelationshipNames.push(matches[0].uniqueName);
          continue;
        }
        // No relationship at all — the level may belong to a degenerate dimension on this
        // cube, which SML expresses via semi_additive.degenerate_dimensions instead of a
        // relationship reference.
        const dimName = attrIdToDimName.get(refId);
        if (dimName && degenerateDimNames.includes(dimName) && levelUniqueName) {
          resolvedDegenerateDims.push({ name: dimName, level: levelUniqueName });
        }
      }
      if (ambiguous) {
        rptOmissions.push({
          category: "Metric",
          item: pm.uniqueName,
          reason: "Semi-additive metric's non-summarized dimension level matches more than one relationship in this cube (likely a role-played dimension) — which specific role was intended can't be determined, so it was converted without a semi_additive block rather than risk attaching it to the wrong one.",
          recommendation: `Manually add a semi_additive block (position: ${pm.position}) to metrics/${pm.fname}.yml, choosing the correct role-played relationship.`,
        });
        continue;
      }
      if (resolvedRelationshipNames.length === 0 && resolvedDegenerateDims.length === 0) {
        rptOmissions.push({
          category: "Metric",
          item: pm.uniqueName,
          reason: "Semi-additive metric's non-summarized dimension level could not be resolved to a model relationship or a degenerate dimension — converted without a semi_additive block.",
          recommendation: `Manually add a semi_additive block (position: ${pm.position}) to metrics/${pm.fname}.yml, using relationships or degenerate_dimensions as appropriate.`,
        });
        continue;
      }
      output.set(
        `metrics/${pm.fname}.yml`,
        buildMetricYaml(
          pm.uniqueName,
          pm.label,
          pm.aggregation,
          pm.measureDatasetName,
          pm.column,
          pm.format,
          pm.folder,
          pm.visible,
          pm.description,
          pm.unrelatedDimensionsHandling,
          pm.isAggregatable,
          {
            position: pm.position,
            relationships: resolvedRelationshipNames.length ? resolvedRelationshipNames : undefined,
            degenerateDimensions: resolvedDegenerateDims.length ? resolvedDegenerateDims : undefined,
          },
        ),
      );
    }

    // The model's flat dimensions: list only holds dimensions with no relationship (they
    // attach directly via is_degenerate) — degenerate schema/cube dims. Dimensions with a
    // relationship are referenced solely via relationships[].to.dimension and must not
    // also appear here, or the two representations contradict each other. A cube-level
    // dim (inline, or via <dimension-ref>) matching neither category has no possible join
    // in this cube at all (e.g. its dataset is never bound to any data-set-ref) and is
    // excluded entirely, rather than forced into dimensions: with no real attachment.
    const cubeDimNames: string[] = [...new Set(degenerateDimNames)];
    // Dimension YAML files still need to be emitted for every dimension actually used by
    // this cube, whether degenerate (flat dimensions: list) or joined via a relationship.
    for (const n of cubeDimNames) referencedDimNames.add(n);
    for (const rel of relationships) referencedDimNames.add(rel.toDimension);
    for (const n of degenerateDimNames) globalDegenerateDimNames.add(n);
    for (const rel of relationships) globalRelationshipDimNames.add(rel.toDimension);
    for (const b of degenerateBindings) {
      const byLevel = globalDegenerateBindings.get(b.dimName) ?? new Map<string, Map<string, string[]>>();
      const byDataset = byLevel.get(b.toLevel) ?? new Map<string, string[]>();
      if (!byDataset.has(b.dataset)) byDataset.set(b.dataset, b.keyColumns);
      byLevel.set(b.toLevel, byDataset);
      globalDegenerateBindings.set(b.dimName, byLevel);
    }

    // Cube visibility
    const cubeProps = first(arr(cube.properties)) as Record<string, unknown> | undefined;
    const cubeVisible = cubeProps ? s(first(arr(cubeProps.visible))) !== "false" : true;

    // Model emission (and the aggregate-dimension validity filter that must precede it) is
    // deferred to Phase 8b, after every dimension — and every snowflake relationship a
    // dimension discovers to ANOTHER dimension — is known (Phase 3b, below, hasn't even run
    // yet at this point in the per-cube loop). Filtering now would wrongly treat a dimension
    // reachable only via such a snowflake join as unreferenced.
    pendingModels.push({
      cubeName,
      relationships,
      cubeDimNames,
      metricNames,
      aggregates,
      perspectives,
      cubeVisible,
      includeDefaultDrillthrough,
      cubeBoundDatasets,
    });
  }

  // ---------------------------------------------------------------
  // Phase 7b: Report schema-level calculated members no cube references
  // ---------------------------------------------------------------
  // A calculated member defined in the schema's shared library but never wired into any
  // cube via a <calculated-member-ref> is excluded from output — same policy as the
  // schema-level dimension check above and the "declared but not referenced" dataset
  // check below — but still worth a note rather than vanishing with no trace.
  for (const [id, def] of calcMemberDefs) {
    if (emittedCalcMemberIds.has(id)) continue;
    rptOmissions.push({
      category: "Calculated Member",
      item: def.name,
      reason: "Declared in the schema's calculated-member library but no cube references it via a calculated-member-ref — excluded from output.",
      recommendation: "If this calculated member is actually needed, add it manually to calculations/*.yml and reference it from the relevant model.",
    });
  }

  // ---------------------------------------------------------------
  // Phase 7c: Emit deferred calculated members, now that every cube has been processed and
  // every calc member's real final (collision-resolved) unique_name is known — see
  // pendingCalcMembers/calcOriginalNameToFinalName above for why this can't happen inline.
  // ---------------------------------------------------------------
  const calcAwareRefMap = new Map(measureRefMap);
  for (const [origName, finalName] of calcOriginalNameToFinalName) calcAwareRefMap.set(origName, finalName);
  for (const pc of pendingCalcMembers) {
    output.set(
      `calculations/${pc.fname}.yml`,
      buildCalcMemberYaml(
        pc.uniqueName,
        pc.label,
        rewriteMeasureRefs(pc.def.expression, calcAwareRefMap),
        pc.format,
        pc.def.folder,
        pc.def.visible,
        pc.def.description,
        pc.def.mdxAggregateFunction,
        pc.def.dimension,
      ),
    );
    logger.log(
      pc.renamedFrom
        ? `  → calculations/${pc.fname}.yml (renamed — "${pc.renamedFrom}" already denotes a different calculated member elsewhere)`
        : `  → calculations/${pc.fname}.yml`,
    );
  }

  // ---------------------------------------------------------------
  // Phase 3b: Emit dimension YAML files for all referenced dims
  // ---------------------------------------------------------------

  // Every dimension a snowflake relationship (discovered below) reaches from another
  // dimension — consulted by the aggregate-attribute filter (Phase 8b, after this loop) so a
  // dimension reachable only via a snowflake join, not a direct cube relationship, still
  // counts as "used" by the cube that joins to its host.
  const dimSnowflakeTargets = new Map<string, string[]>();

  for (const dimName of referencedDimNames) {
    const dimEl = allDims.get(dimName);
    if (!dimEl) continue;
    // Calculation groups (a dimension-level construct, e.g. time-intelligence YTD/QTD member
    // templates) have no conversion support at all — surface it the same way KPIs/Named Sets
    // are, rather than letting every calc-group member vanish with zero trace.
    if (arr((dimEl as Record<string, unknown>)["calculation-group"]).length > 0) {
      rptOmissions.push({
        category: "Structural",
        item: `Calculation Group in dimension "${dimName}"`,
        reason: "Dimension-level calculation groups are not converted — no direct SML equivalent implemented.",
        recommendation: "Recreate the calculation group's member templates as calculated members manually after conversion.",
      });
    }
    // A real relationship anywhere wins over a degenerate determination elsewhere — a
    // dimension used by multiple cubes could be degenerate in one and properly joined
    // in another.
    const isDegenerate = globalDegenerateDimNames.has(dimName) && !globalRelationshipDimNames.has(dimName);
    const degenerateBindingsForDim = globalDegenerateBindings.get(dimName);
    const { yaml: dimYaml, meta: dimMeta } = buildDimensionYaml(dimEl, dimName, attrDef, keyMap, attrMap, isDegenerate, soleKeyColumns, datasetNameToPhysical, metricalAttrDef, degenerateBindingsForDim, attrIdToDimName, refPathIdToKeyRefId, hierarchyIdToRef, primaryAttrIdToLevelRef);
    const fname = safeFilename(dimName);
    output.set(`dimensions/${fname}.yml`, dimYaml);
    logger.log(`  → dimensions/${fname}.yml`);

    rptDimensions.push({
      name: dimName,
      file: `dimensions/${fname}.yml`,
      type: dimMeta.type,
      hierarchyCount: dimMeta.hierarchyCount,
      levelCount: dimMeta.levelCount,
      hasDefaultMembers: dimMeta.hasDefaultMembers,
    });
    for (const skipped of dimMeta.skippedCrossDimRefs) {
      rptOmissions.push({
        category: "Secondary Attribute",
        item: `attribute ${skipped.attrId} in dimension "${skipped.dimName}"`,
        reason: "Cross-dimension embedded relationship (ref-id) cannot be represented as a secondary attribute in SML",
        recommendation: "Verify that the dimension-to-dimension relationship is covered by a model relationship, or add it manually as a secondary attribute referencing the correct dataset.",
      });
    }
    for (const name of dimMeta.skippedMetricalQuantiles) {
      rptOmissions.push({
        category: "Metric",
        item: `metrical attribute "${name}" in dimension "${dimName}"`,
        reason: "Quantile/percentile metrical attributes are not yet converted (no calculation_method: percentile support).",
        recommendation: "Add this metric manually to the dimension's level metrics after verifying the quantile configuration.",
      });
    }
    for (const name of dimMeta.skippedMetricalUnresolved) {
      rptOmissions.push({
        category: "Metric",
        item: `metrical attribute "${name}" in dimension "${dimName}"`,
        reason: "Could not resolve the metrical attribute's column/dataset reference.",
        recommendation: "Add this metric manually to the dimension's level metrics after verifying the source column.",
      });
    }
    for (const dropped of dimMeta.droppedSecondaryAttrsForSharedDegenerate) {
      rptOmissions.push({
        category: "Secondary Attribute",
        item: `${dropped.secondaryAttrName} on level "${dropped.level}" in dimension "${dimName}"`,
        reason: "This level is bound to more than one fact dataset (shared_degenerate_columns) — the engine does not allow secondary attributes on a level shaped that way.",
        recommendation: "Add this attribute as its own separate degenerate dimension, or as a level metric, if it's still needed.",
      });
    }
    if (dimMeta.snowflakeRelationships.length > 0) {
      dimSnowflakeTargets.set(dimName, dimMeta.snowflakeRelationships.map((r) => r.toDimension));
      // A snowflake-joined dimension is "used" precisely because this dimension reaches it —
      // add it to the same set this very loop is iterating so its own file gets emitted too
      // (Set iteration visits entries added during iteration, so this is safe mid-loop).
      for (const r of dimMeta.snowflakeRelationships) referencedDimNames.add(r.toDimension);
    }
  }

  // ---------------------------------------------------------------
  // Phase 8b: Filter aggregate dimension references, then emit each cube's model file
  // ---------------------------------------------------------------
  // Deferred until now (rather than done inline in the per-cube loop above) because it needs
  // dimSnowflakeTargets, which Phase 3b — just above — is what actually discovers.
  for (const pm of pendingModels) {
    const cubeReferencedDimNames = new Set(pm.cubeDimNames);
    for (const rel of pm.relationships) cubeReferencedDimNames.add(rel.toDimension);
    // Expand transitively: a dimension reached via a snowflake relationship from anything
    // already in the set counts as used too (and so does whatever ITS OWN snowflake
    // relationships reach, and so on) — a plain BFS over dimSnowflakeTargets.
    const queue = [...cubeReferencedDimNames];
    while (queue.length > 0) {
      const next = queue.shift()!;
      for (const target of dimSnowflakeTargets.get(next) ?? []) {
        if (!cubeReferencedDimNames.has(target)) {
          cubeReferencedDimNames.add(target);
          queue.push(target);
        }
      }
    }

    // Some User Defined Aggregates (Phase 8, above) resolve an attribute-ref to a dimension
    // that never ends up joined to this cube — no relationship, not degenerate, not reached
    // via a snowflake join either — e.g. the aggregate pre-joins a dimension purely for its
    // own acceleration, with no corresponding fact-to-dimension relationship declared
    // anywhere else in the XML. SML requires every aggregate attribute's dimension to already
    // be one the model can actually reach; a dangling one isn't merely incomplete, it's
    // invalid — the engine rejects the relationship_path as non-existent — so it's filtered
    // out and reported here rather than passed through broken.
    for (const agg of pm.aggregates) {
      agg.attributes = agg.attributes.filter((attrOut) => {
        if (cubeReferencedDimNames.has(attrOut.dimension)) return true;
        rptOmissions.push({
          category: "User Defined Aggregate",
          item: `${agg.uniqueName} → ${attrOut.name}`,
          reason: `References dimension "${attrOut.dimension}", which has no relationship, degenerate, or snowflake binding to this cube — the aggregate would otherwise point at a non-existent relationship_path.`,
          recommendation: "Add a relationship (or degenerate binding) for this dimension to the model, or remove this attribute from the aggregate manually.",
        });
        return false;
      });
    }
    // An aggregate left with nothing to aggregate after that filtering has no reason to exist.
    for (let i = pm.aggregates.length - 1; i >= 0; i--) {
      if (pm.aggregates[i].attributes.length === 0 && pm.aggregates[i].metrics.length === 0) {
        rptOmissions.push({
          category: "User Defined Aggregate",
          item: pm.aggregates[i].uniqueName,
          reason: "Every attribute/metric this aggregate referenced was excluded — nothing left to aggregate.",
          recommendation: "Recreate this aggregate manually once its referenced dimensions/measures are available in the model.",
        });
        pm.aggregates.splice(i, 1);
      }
    }

    // Same reasoning as the aggregate-attribute filter above: a perspective can only hide a
    // dimension this cube's model can actually reach.
    for (const perspective of pm.perspectives) {
      for (const dimName of [...perspective.hiddenDimensions.keys()]) {
        if (cubeReferencedDimNames.has(dimName)) continue;
        rptOmissions.push({
          category: "Perspective",
          item: `${perspective.label} → ${dimName}`,
          reason: `References dimension "${dimName}", which has no relationship, degenerate, or snowflake binding to this cube.`,
          recommendation: "Verify the perspective manually and hide the equivalent dimension in the converted model.",
        });
        perspective.hiddenDimensions.delete(dimName);
      }
    }

    const modelYaml = buildModelYaml(pm.cubeName, pm.relationships, pm.cubeDimNames, pm.metricNames, pm.aggregates, pm.perspectives, !pm.cubeVisible, pm.includeDefaultDrillthrough);
    const fname = safeFilename(pm.cubeName);
    output.set(`models/${fname}.yml`, modelYaml);
    logger.log(`  → models/${fname}.yml`);

    // Dimension datasets: datasets backing this cube's dimensions (not the fact tables)
    const dimDsSet = new Set<string>();
    for (const rel of pm.relationships) {
      if (rel.dimensionDataset && !pm.cubeBoundDatasets.includes(rel.dimensionDataset)) {
        dimDsSet.add(rel.dimensionDataset);
      }
    }

    rptModels.push({
      name: pm.cubeName,
      file: `models/${fname}.yml`,
      relationships: pm.relationships,
      relationshipCount: pm.relationships.length,
      dimensionCount: pm.cubeDimNames.length,
      metricCount: pm.metricNames.length,
      aggregateCount: pm.aggregates.length,
      hasDefaultDrillthrough: pm.includeDefaultDrillthrough,
      isHidden: !pm.cubeVisible,
      factDatasets: pm.cubeBoundDatasets,
      dimensionDatasets: [...dimDsSet],
    });
  }

  // Schema-level dimensions no cube joins to are excluded from output (matching how an
  // unreferenced dataset is excluded below), rather than silently vanishing with no trace.
  for (const dimName of schemaDims.keys()) {
    if (referencedDimNames.has(dimName)) continue;
    rptOmissions.push({
      category: "Dimension",
      item: dimName,
      reason: "Declared in the schema but no cube joins to it (no relationship and not used as a degenerate dimension) — excluded from output.",
      recommendation: "If this dimension is actually needed, add it manually to dimensions/ and wire it into the relevant model's relationships.",
    });
  }

  // ---------------------------------------------------------------
  // Phase 2: Emit dataset files
  // ---------------------------------------------------------------

  // Schema-level dimensions never appear in a cube's own data-set-ref list — they're
  // pulled in via keyed-attribute key-refs instead — so datasets they use only show up
  // here, once the dimension YAML (built above) is available to scan.
  for (const [key, dimYaml] of output) {
    if (!key.startsWith("dimensions/")) continue;
    // Dataset names can contain spaces (e.g. "SOME DATASET NAME") — anchor to the
    // trailing ".dataset" at end of line rather than a non-whitespace-only match, which
    // would incorrectly capture just the last word of a multi-word name.
    for (const m of dimYaml.matchAll(/^\s*dataset:\s*(.+)\.dataset\s*$/gm)) {
      referencedDatasetNames.add(m[1]);
    }
  }

  // Without an explicit --connection-db/--connection-schema override, datasets can
  // legitimately span multiple database/schema pairs under one AtScale connection (e.g.
  // several schemas in the same warehouse). Represent each distinct pair as its own
  // connection — matching AtScale's own reference converter — instead of a nested
  // `table: {db, schema, name}` object, which the live engine rejects even though it's
  // schema-valid. The first distinct pair encountered keeps the base connection name;
  // every other pair gets a `_<schema>` suffix.
  const connectionIdByDataset = new Map<string, string>(); // dataset name -> connection unique_name
  const connectionDbSchema = new Map<string, { db?: string; schema?: string }>(); // connection unique_name -> its db/schema
  if (!opts.connectionDb && !opts.connectionSchema) {
    // A <table> can name a <schema> without a <database> — that means "use whichever
    // database the rest of this schema's tables use," not "a genuinely database-less
    // location." Resolving each schema's database in its own pass first (preferring any
    // dataset that does specify one) means such a table joins the schema's one real
    // connection instead of splitting off a second, broken one with no database — the live
    // engine requires a table-backed connection to declare a database.
    const schemaToDb = new Map<string, string>();
    for (const dsName of referencedDatasetNames) {
      const phys = datasetNameToPhysical.get(dsName);
      if (phys?.schema && phys.db && !schemaToDb.has(phys.schema)) {
        schemaToDb.set(phys.schema, phys.db);
      }
    }

    const pairToConnId = new Map<string, string>();
    for (const dsName of referencedDatasetNames) {
      const phys = datasetNameToPhysical.get(dsName);
      if (!phys?.db && !phys?.schema) continue;
      const resolvedDb = phys.db ?? (phys.schema ? schemaToDb.get(phys.schema) : undefined);
      const pairKey = `${resolvedDb ?? ""}|${phys.schema ?? ""}`;
      let connId = pairToConnId.get(pairKey);
      if (!connId) {
        connId = pairToConnId.size === 0 ? connName : `${connName}_${phys.schema ?? resolvedDb}`;
        pairToConnId.set(pairKey, connId);
        connectionDbSchema.set(connId, { db: resolvedDb, schema: phys.schema });
      }
      connectionIdByDataset.set(dsName, connId);
    }
  }

  // Aggregate-eligibility flags (from each <data-set>'s <properties>) keyed by the emitted
  // dataset's unique_name — these have no home on the dataset object itself (see
  // parseDatasetPhysical), so they're collected here and written onto catalog.yml's
  // repository-wide `dataset_properties` map instead.
  const datasetAggPropsByUniqueName = new Map<string, Record<string, boolean>>();

  for (const dsSec of arr(schemaEl["data-sets"])) {
    for (const ds of arr(dsSec["data-set"])) {
      const dsName = a(ds, "name");
      if (!dsName) continue;
      if (!referencedDatasetNames.has(dsName)) {
        rptOmissions.push({
          category: "Dataset",
          item: dsName,
          reason: "Declared in the schema but not referenced by any cube's data-set-ref or dimension — excluded from output.",
          recommendation: "If this dataset is actually needed, add it manually to datasets/ and reference it from the relevant model or dimension.",
        });
        continue;
      }
      const dsYaml = buildDatasetYaml(
        ds as Record<string, unknown>, dsName,
        connectionIdByDataset.get(dsName) ?? connName,
        referencedColumnsByDataset.get(dsName),
      );
      const fname = safeFilename(dsName);
      output.set(`datasets/${fname}.yml`, dsYaml);
      logger.log(`  → datasets/${fname}.yml`);

      // Report tracking
      const physRpt = parseDatasetPhysical(ds as Record<string, unknown>);
      const allColumnNames = new Set(physRpt?.columns?.map((c) => c.name) ?? []);
      for (const col of referencedColumnsByDataset.get(dsName) ?? []) allColumnNames.add(col);

      const aggProps: Record<string, boolean> = {};
      if (physRpt?.allowAggregates !== undefined) aggProps.allow_aggregates = physRpt.allowAggregates;
      if (physRpt?.allowLocalAggs !== undefined) aggProps.allow_local_aggs = physRpt.allowLocalAggs;
      if (physRpt?.allowPeerAggs !== undefined) aggProps.allow_peer_aggs = physRpt.allowPeerAggs;
      if (physRpt?.allowPreferredAggs !== undefined) aggProps.allow_preferred_aggs = physRpt.allowPreferredAggs;
      if (Object.keys(aggProps).length) datasetAggPropsByUniqueName.set(`${dsName}.dataset`, aggProps);

      rptDatasets.push({
        name: dsName,
        file: `datasets/${fname}.yml`,
        type: physRpt?.sql ? "sql" : "table",
        columnCount: allColumnNames.size,
        isImmutable: physRpt?.immutable ?? false,
        isUnbound: unboundDatasetNames.has(dsName),
      });
    }
  }

  // ---------------------------------------------------------------
  // Phase 6: Catalog and connection
  // ---------------------------------------------------------------

  output.set("catalog.yml", buildCatalogYaml(catalogName, datasetAggPropsByUniqueName));

  // Always emit the default connection, plus one per extra db/schema pair discovered
  // above (all variants of the same underlying AtScale-registered connection).
  const allConnectionIds = new Set<string>([connName, ...connectionDbSchema.keys()]);
  for (const connId of allConnectionIds) {
    const dbSchema = connectionDbSchema.get(connId);
    output.set(
      `connections/${safeFilename(connId)}.yml`,
      buildConnectionYaml(
        connId, opts.connectionType,
        dbSchema?.db ?? opts.connectionDb, dbSchema?.schema ?? opts.connectionSchema,
        connName,
      ),
    );
    logger.log(`  → connections/${safeFilename(connId)}.yml`);
  }
  logger.log(`  → catalog.yml`);

  // ---------------------------------------------------------------
  // Phase 7e: Truncated-identifier report — every source name long enough to need
  // truncateUniqueName's interior-hash shortening, logged so the original name is always
  // discoverable without decoding the hash (see truncateUniqueName's own docs for why the
  // hash lives in the middle of the name rather than at the end).
  // ---------------------------------------------------------------
  const rptTruncatedNames: TruncatedNameRecord[] = [];
  for (const def of attrDef.values()) {
    const safe = safeName(def.name);
    if (safe.length > MAX_UNIQUE_NAME_LENGTH) {
      rptTruncatedNames.push({ category: "Attribute", original: def.name, truncated: truncateUniqueName(safe) });
    }
  }
  for (const def of calcMemberDefs.values()) {
    const safe = safeName(def.name);
    if (safe.length > MAX_UNIQUE_NAME_LENGTH) {
      rptTruncatedNames.push({ category: "Calculated Member", original: def.name, truncated: truncateUniqueName(safe) });
    }
  }
  for (const dimEl of allDims.values()) {
    for (const hierEl of arr(dimEl.hierarchy)) {
      const hierName = a(hierEl, "name");
      const safe = hierName ? safeName(hierName) : "";
      if (hierName && safe.length > MAX_UNIQUE_NAME_LENGTH) {
        rptTruncatedNames.push({ category: "Hierarchy", original: hierName, truncated: truncateUniqueName(safe) });
      }
    }
  }

  // ---------------------------------------------------------------
  // Phase 8: Generate README.md conversion report
  // ---------------------------------------------------------------

  const readme = buildReadme(
    catalogName, connName, opts.xmlFileName,
    rptDatasets, rptDimensions, rptMetrics, rptModels, rptOmissions, rptUnboundByCube,
    rptTruncatedNames,
  );
  output.set("README.md", readme);
  logger.log(`  → README.md`);

  return output;
}

// ============================================================
// Internal types
// ============================================================

interface KeyRefEntry {
  datasetName: string;
  columns: string[];
  complete: string; // "true" | "false" | "partial"
  unique?: boolean;
  rolePlay?: string;
}

/**
 * Pick the authoritative entry when a key-ref/attribute-ref id is redeclared more than
 * once (once per dataset/cube's own <logical> section) with none marked complete="true" —
 * a still-partially-wired source definition can leave one redeclaration naming a real
 * physical column and another naming a placeholder (often the attribute's own caption
 * text, not a real column), and which one comes first in document order is incidental.
 * Falls back to entries[0] — the prior, order-dependent behavior — only when no entry's
 * columns can be verified against its own dataset's known physical columns (i.e. every
 * candidate is equally unverifiable, so there's no positive signal to prefer one).
 */
function pickAuthEntry<T extends { complete: string; columns: string[]; datasetName: string }>(
  entries: T[],
  datasetNameToPhysical: Map<string, DatasetPhysical>,
): T {
  const complete = entries.find((e) => e.complete === "true");
  if (complete) return complete;
  const valid = entries.find((e) => {
    const knownColumns = datasetNameToPhysical.get(e.datasetName)?.columns;
    return !!knownColumns?.length && e.columns.every((col) => knownColumns.some((c) => c.name === col));
  });
  return valid ?? entries[0];
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
  description?: string;
  allowedCalcTypes?: string[];
  /** id of the <key-ref> named in this attribute's own <properties><ordering><sort-key><key-ref id="..."/>. */
  sortKeyUuid?: string;
}

/** A schema-level plain <attribute> ("metrical attribute") — a measure attached to a dimension level. */
interface MetricalAttrDef {
  id: string;
  name: string;
  caption?: string;
  folder?: string;
  visible: boolean;
  description?: string;
  formatString?: string;
  namedFormat?: string;
  /** SML calculation_method, or undefined for a quantile/percentile type (not yet supported). */
  aggregation?: string;
  isQuantile: boolean;
  unrelatedDimensionsHandling?: string;
  isAggregatable?: boolean;
  /** id of the <key-ref> nested under this attribute's measure/count-distinct/etc element, for column resolution. */
  keyRefId?: string;
}

interface CalcMemberDef {
  name: string;
  caption?: string;
  folder?: string;
  visible: boolean;
  formatString?: string;
  namedFormat?: string;
  expression: string;
  description?: string;
  mdxAggregateFunction?: string;
  dimension?: string;
}

interface DatasetPhysical {
  db?: string;
  schema?: string;
  tableName?: string;
  sql?: string;
  /** Per-dialect overrides of `sql` (e.g. Snowflake vs. Postgres variants of the same query). */
  dialects?: Array<{ dialect: string; sql: string }>;
  connectionName?: string;
  columns?: Array<{
    name: string;
    /** Optional because a <map-column> itself carries no data_type — SML requires one unless the column is a map. */
    dataType?: string;
    sql?: string;
    /** Per-dialect overrides of a computed column's `sql`. */
    dialects?: Array<{ dialect: string; sql: string }>;
    /** A semi-structured MAP-typed physical column (e.g. Hive MAP<string,string>). */
    map?: { fieldTerminator: string; keyTerminator: string; keyType: string; valueType: string; isPrefixed?: boolean };
    /** For a map's sub-column: the name of the <map-column> it's projected out of. */
    parentColumn?: string;
  }>;
  immutable?: boolean;
  /**
   * Aggregate-eligibility flags from the dataset's sibling `<properties>` element (a peer
   * of `<physical>`, not nested inside it). SML has no equivalent property on the dataset
   * object itself — these are repository-wide overrides that belong on catalog.yml's
   * `dataset_properties`, keyed by the dataset's unique_name (see buildCatalogYaml).
   */
  allowAggregates?: boolean;
  allowLocalAggs?: boolean;
  allowPeerAggs?: boolean;
  allowPreferredAggs?: boolean;
}

// ============================================================
// Conversion report types
// ============================================================

interface DatasetRecord {
  name: string;
  file: string;
  type: "table" | "sql";
  columnCount: number;
  isImmutable: boolean;
  /** True when the source XML has no physical table or SQL binding for this dataset. */
  isUnbound: boolean;
}

interface CubeBindingRecord {
  cubeName: string;
  /** Datasets fully bound (have a physical table or SQL in the XML). */
  boundDatasets: string[];
  /** Datasets referenced by this cube but with no physical binding — need to be created/bound. */
  unboundDatasets: string[];
}

interface DimRecord {
  name: string;
  file: string;
  type: "time" | "standard" | "degenerate";
  hierarchyCount: number;
  levelCount: number;
  hasDefaultMembers: boolean;
}

interface MetricRecord {
  name: string;
  label: string;
  file: string;
  metricType: "measure" | "calculated_measure" | "calculated_member";
  aggregation?: string;
  folder?: string;
  isHidden: boolean;
}

interface ModelRecord {
  name: string;
  file: string;
  relationships: RelationshipDef[];
  relationshipCount: number;
  dimensionCount: number;
  metricCount: number;
  aggregateCount: number;
  hasDefaultDrillthrough: boolean;
  isHidden: boolean;
  /** Datasets explicitly bound to this cube as fact tables (cube data-set-refs). */
  factDatasets: string[];
  /** Datasets used by the model's dimensions but not listed as cube fact tables. */
  dimensionDatasets: string[];
}

/** A User Defined Aggregate (hinted aggregate table) declared on a cube. */
interface AggregateDef {
  uniqueName: string;
  label: string;
  attributes: Array<{ name: string; dimension: string; relationshipsPath?: string[] }>;
  metrics: string[];
  caching?: string;
}

/** A single dimension's hidden hierarchies/levels/secondary attributes within a perspective. */
interface PerspectiveDimensionDef {
  wholeDimensionHidden: boolean;
  /** hierarchy unique_name -> level unique_name to hide from (undefined = hide the whole hierarchy). */
  hiddenHierarchies: Map<string, string | undefined>;
  hiddenSecondaryAttributes: Set<string>;
}

interface PerspectiveDef {
  uniqueName: string;
  label: string;
  hiddenMetrics: string[];
  hiddenDimensions: Map<string, PerspectiveDimensionDef>;
}

interface OmissionRecord {
  category: string;
  item: string;
  reason: string;
  recommendation: string;
}

/** An identifier long enough to need truncateUniqueName's interior-hash shortening — logged
 *  so the original name is always discoverable from the report without decoding the hash. */
interface TruncatedNameRecord {
  category: string;
  original: string;
  truncated: string;
}

/** Metadata extracted alongside YAML during dimension conversion. */
interface DimMeta {
  type: "time" | "standard" | "degenerate";
  hierarchyCount: number;
  levelCount: number;
  hasDefaultMembers: boolean;
  /** Secondary attribute refs skipped because they carried a cross-dimension ref-id. */
  skippedCrossDimRefs: Array<{ dimName: string; attrId: string }>;
  /** Cross-dimension embedded refs successfully resolved into a snowflake relationship —
   *  emitted on this dimension's own YAML (obj.relationships) and reported back to the
   *  caller so the target dimension gets marked referenced (and its own file emitted). */
  snowflakeRelationships: Array<{
    uniqueName: string;
    fromDataset: string;
    fromColumns: string[];
    toDimension: string;
    toLevel: string;
  }>;
  /** Metrical attribute names skipped because they're a quantile/percentile type (unsupported). */
  skippedMetricalQuantiles: string[];
  /** Metrical attribute names skipped because their column/dataset couldn't be resolved. */
  skippedMetricalUnresolved: string[];
  /** Secondary attributes dropped from a level that ended up using shared_degenerate_columns
   *  (multi-dataset) — the engine disallows secondary attributes there entirely. */
  droppedSecondaryAttrsForSharedDegenerate: Array<{ level: string; secondaryAttrName: string }>;
}

/** A metrical attribute (dimension-level metric) resolved for one hierarchy level. */
interface MetricalAttrOut {
  uniqueName: string;
  label: string;
  dataset: string;
  column: string;
  calculationMethod: string;
  format?: string;
  folder?: string;
  description?: string;
  isHidden?: boolean;
  unrelatedDimensionsHandling?: string;
  isAggregatable?: boolean;
}

interface RelationshipDef {
  uniqueName: string;
  fromDataset: string;
  fromColumns: string[];
  toDimension: string;
  toLevel: string;
  rolePlay?: string;
  /** Dataset that backs the dimension key (complete=true side of the join). */
  dimensionDataset?: string;
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

/** Whether an element's own <properties><visible> is explicitly "false" (absent = visible). */
function isExplicitlyHidden(el: Record<string, unknown>): boolean {
  const props = first(arr(el.properties)) as Record<string, unknown> | undefined;
  return (props ? s(first(arr(props.visible))) : undefined) === "false";
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
    // Spell out comparison operators before the generic strip below turns them into an
    // indistinguishable "_" — otherwise "X > 1M" and "X < 1M" collapse toward the same
    // unique_name and the direction of the comparison is lost from the identifier entirely
    // (the human-readable label still has it, but unique_name is what's used for lookups).
    .replace(/<=/g, "_le_")
    .replace(/>=/g, "_ge_")
    .replace(/</g, "_lt_")
    .replace(/>/g, "_gt_")
    .replace(/[^a-zA-Z0-9_\-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_|_$/g, "");
}

/** SML unique_name values must not exceed this length. */
const MAX_UNIQUE_NAME_LENGTH = 63;

/**
 * Deterministically shorten a unique_name to fit SML's 63-character limit, keeping both a
 * head and a tail fragment around an interior hash rather than cutting the name off after a
 * fixed prefix. Two long names that only differ near the end (e.g. "...ASSETS_ANY_IND" vs
 * "...ASSETS_ONLY_IND") previously collapsed to an identical head-only prefix, leaving the
 * hash suffix as the only (unreadable) distinguishing feature. Splitting the surviving budget
 * between head and tail keeps the distinguishing text legible in the common case where the
 * difference between two colliding names is near the front, the back, or both.
 */
function truncateUniqueName(name: string): string {
  if (name.length <= MAX_UNIQUE_NAME_LENGTH) return name;
  const hash = createHash("sha1").update(name).digest("hex").slice(0, 8);
  const budget = MAX_UNIQUE_NAME_LENGTH - hash.length - 2; // 2 underscore separators
  const headLen = Math.ceil(budget * 0.55);
  const tailLen = budget - headLen;
  return `${name.slice(0, headLen)}_${hash}_${name.slice(name.length - tailLen)}`;
}

/**
 * A dimension level's unique_name, exactly as buildDimensionYaml, findCubeMatchingLevels,
 * and the semi-additive resolution loop each independently derive it — sanitized (illegal
 * characters replaced, matching every other unique_name in this file) and truncated to
 * SML's 63-char limit. Centralized so all three call sites always agree; a mismatch here
 * silently breaks relationships[].to.level, semi_additive.degenerate_dimensions[].level, and
 * the shared-degenerate-bindings lookup.
 */
function levelUniqueNameFor(name: string): string {
  return truncateUniqueName(safeName(name));
}

/**
 * Build a map from every measure/calculated-member's original XML name to its final
 * (safeName + truncated) unique_name. Calculation expressions reference other metrics
 * by their original name (e.g. "[Measures].[Some Measure-Prev]"), but the output uses
 * the transformed unique_name — this map lets those references be rewritten to match.
 */
function buildMeasureRefMap(
  cubeEls: Record<string, unknown>[],
  calcMemberDefs: Map<string, CalcMemberDef>,
): Map<string, string> {
  // Keyed case-insensitively — a calc formula's own [Measures].[Name] reference doesn't
  // always match the target's declared name byte-for-byte (e.g. this schema references
  // "Number of Days" for an attribute actually named "Number Of Days"); MDX member name
  // resolution isn't case-sensitive, and the reference converter's own name-collision
  // tracking already treats names this way for the same reason (see the dedupKey comment
  // in the Phase 4 measure loop below).
  const map = new Map<string, string>();
  for (const def of calcMemberDefs.values()) {
    map.set(def.name.toLowerCase(), truncateUniqueName(safeName(def.name)));
  }
  for (const cube of cubeEls) {
    for (const attrsSec of arr(cube.attributes)) {
      for (const attrEl of arr((attrsSec as Record<string, unknown>).attribute)) {
        const attrNameRaw = a(attrEl, "name");
        if (!attrNameRaw) continue;
        const props = first(arr((attrEl as Record<string, unknown>).properties)) as
          | Record<string, unknown>
          | undefined;
        if (!props) continue;
        const typeEl = first(arr(props.type)) as Record<string, unknown> | undefined;
        if (!typeEl) continue;
        const isMeasure =
          arr(typeEl.measure).length > 0 ||
          arr(typeEl["count-distinct"]).length > 0 ||
          arr(typeEl["count-nonnull"]).length > 0 ||
          arr(typeEl["quantile-instance"]).length > 0;
        const hasExpr = arr((attrEl as Record<string, unknown>).expression).length > 0;
        if (!isMeasure && !hasExpr) continue;
        map.set(attrNameRaw.toLowerCase(), truncateUniqueName(safeName(attrNameRaw)));
      }
    }
  }
  return map;
}

/** Rewrite "[Measures].[Original Name]" references to match transformed unique_names. */
function rewriteMeasureRefs(text: string, nameMap: Map<string, string>): string {
  // MDX allows the "Measures" dimension name unbracketed when it's unambiguous
  // (Measures.[Number of Days ESTIMATE], not just [Measures].[Number of Days ESTIMATE]) —
  // both forms appear in this same source file. Matching only the fully-bracketed form left
  // every unbracketed reference untouched, so its original (pre-safeName) spaced-out name
  // never got rewritten to the transformed unique_name the target metric actually has,
  // producing a calc formula that references a metric name nothing in the model has.
  return text.replace(/\[?Measures\]?\.\[([^\]]+)\]/g, (full, name) => {
    // nameMap is keyed case-insensitively (see buildMeasureRefMap/calcOriginalNameToFinalName)
    // — a formula's own reference doesn't always match the target's declared name byte-for-
    // byte, and MDX member name resolution isn't case-sensitive either.
    const mapped = nameMap.get(name.toLowerCase());
    return mapped ? `[Measures].[${mapped}]` : full;
  });
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
/**
 * Reads a measure/count-distinct/count-nonnull element's <unrelated-dimensions> child,
 * a choice of empty <unrelated-dimensions-{empty,repeat,error}/> elements, into the SML
 * `unrelated_dimensions_handling` enum token.
 */
function parseUnrelatedDimensionsHandling(typeChildEl: Record<string, unknown> | undefined): string | undefined {
  if (!typeChildEl) return undefined;
  const udEl = first(arr(typeChildEl["unrelated-dimensions"])) as Record<string, unknown> | undefined;
  if (!udEl) return undefined;
  if (arr(udEl["unrelated-dimensions-repeat"]).length > 0) return "repeat";
  if (arr(udEl["unrelated-dimensions-error"]).length > 0) return "error";
  if (arr(udEl["unrelated-dimensions-empty"]).length > 0) return "empty";
  return undefined;
}

function mapAggregation(raw: string): string {
  switch (raw.toUpperCase()) {
    case "SUM":            return "sum";
    case "AVG":            return "average";
    case "MIN":            return "minimum";
    case "MAX":            return "maximum";
    case "COUNT":          return "count non-null";
    case "COUNT_DISTINCT":                return "count distinct";
    case "DISTINCT_COUNT_ESTIMATE":
    case "DISTINCTCOUNTESTIMATE":         return "estimated count distinct";
    case "SUM_DISTINCT":                  return "sum distinct";
    default:               return "sum";
  }
}

/** Map XML <additivity><subspace><aggregation-function> → SML semi_additive.position. Returns
 *  undefined for XMLA aggregation functions (e.g. ByAccount, AverageOfChildren, None) that have
 *  no SML equivalent, so the caller can fall back to a plain (fully-additive) metric. */
function mapAdditivityPosition(raw: string): string | undefined {
  switch (raw) {
    case "LastNonEmpty":  return "last";
    case "FirstNonEmpty": return "first";
    case "LastChild":     return "last_child";
    case "FirstChild":    return "first_child";
    default:              return undefined;
  }
}

/** Normalize a named format keyword (e.g. "General Number", "Short Date") to a lowercase SML format token. */
function normalizeNamedFormat(named: string): string {
  switch (named.toLowerCase()) {
    case "percent":  return "percent:1";
    case "standard": return "decimal:2";
    case "currency": return "currency:0";
    default:         return named.toLowerCase(); // pass through (e.g. "short date")
  }
}

/** Map XML format-string or named-format → SML format. */
function resolveFormat(formatString?: string, namedFormat?: string): string | undefined {
  if (namedFormat) {
    return normalizeNamedFormat(namedFormat);
  }
  if (formatString) {
    switch (formatString) {
      case "#,##0":     return "#,##0";
      case "#,##0.00":  return "#,##0.00";
      case "0%":        return "0%";
      case "#,##0.0%":  return "#,##0.0%";
      case "$#,##0":    return "$#,##0";
      case "#,##0%":    return "#,##0%";
      default:
        // format-string can also hold a named format (e.g. "General Number") rather than a numeric pattern
        return /[a-zA-Z]/.test(formatString) ? normalizeNamedFormat(formatString) : formatString;
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
  // Strip trailing _sum / _avg / _min / _max / _count / _distinct, optionally followed by a
  // "_2"/"_3"/... disambiguation suffix — the same collision-numbering scheme source schemas
  // use for duplicate measure *names* (e.g. m_MEASURE_A_sum / m_MEASURE_A_sum_2 as two
  // distinct attributes) shows up here too on attributes with no real key-ref/attribute-ref
  // at all, where it's not part of the column name (e.g. m_MEASURE_B_sum_2 is just
  // a second, differently-labeled attribute over the same MEASURE_B column).
  return withoutPrefix.replace(/_(sum|avg|min|max|count|distinct|average|minimum|maximum)(_\d+)?$/i, "");
}

/** The fact dataset for a cube is the first <data-set-ref> listed under its <data-sets>. */
function getFactDatasetName(
  cube: Record<string, unknown>,
  datasetIdToName: Map<string, string>,
): string | undefined {
  for (const dsSec of arr(cube["data-sets"])) {
    for (const dsRef of arr(dsSec["data-set-ref"])) {
      const refId = a(dsRef, "id");
      if (refId) return datasetIdToName.get(refId) ?? refId;
    }
  }
  return undefined;
}

/**
 * Resolve every cube measure's column using the same priority order as the real emission
 * logic (inline key-ref, then attribute-ref, then a name-based guess) and record it against
 * its fact dataset — including fallback name-guessed columns, which otherwise never get
 * declared in the dataset's columns: list even though the metric YAML ends up referencing them.
 */
function collectMeasureColumns(
  cubeEls: Record<string, unknown>[],
  datasetIdToName: Map<string, string>,
  keyMap: Map<string, KeyRefEntry[]>,
  attrMap: Map<string, AttrRefEntry>,
  datasetNameToPhysical: Map<string, DatasetPhysical>,
  addReferencedColumn: (datasetName: string, column: string) => void,
): void {
  for (const cube of cubeEls) {
    const factDatasetName = getFactDatasetName(cube, datasetIdToName);
    if (!factDatasetName) continue;

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
        const countDistEl = first(arr(typeEl["count-distinct"])) as Record<string, unknown> | undefined;
        const countNonNullEl = first(arr(typeEl["count-nonnull"])) as Record<string, unknown> | undefined;
        if (!measureEl && !countDistEl && !countNonNullEl) continue;

        const measureTypeEl = measureEl ?? countDistEl ?? countNonNullEl;
        const keyRefEl = measureTypeEl
          ? (first(arr(measureTypeEl["key-ref"])) as Record<string, unknown> | undefined)
          : undefined;
        const keyRefId = keyRefEl ? a(keyRefEl, "id") : undefined;
        const keyRefEntries = keyRefId ? keyMap.get(keyRefId) ?? [] : [];
        const keyRefAuthEntry = pickAuthEntry(keyRefEntries, datasetNameToPhysical);

        const colRef = attrMap.get(attrId);
        const resolvedFromReference = keyRefAuthEntry?.columns[0] ?? colRef?.column;
        const column = resolvedFromReference ?? parseColumnFromAttrName(attrNameRaw);
        // Mirror the dataset resolution used at emission time (see the Phase 4 measure
        // loop) — otherwise a multi-fact cube's measures get their referenced columns
        // recorded against the wrong dataset, which manufactures a "phantom" column on
        // the cube's first fact dataset instead of the one the measure actually lives on.
        const measureDatasetName = keyRefAuthEntry?.datasetName ?? colRef?.datasetName ?? factDatasetName;
        // A name-guessed column (no real key-ref/attribute-ref backing it at all) is only
        // trustworthy when it actually matches a column the dataset declares. Recording an
        // unverifiable guess here manufactures a phantom column (defaulted to a "string"
        // data_type, since nothing else is known about it) that the real table doesn't have
        // — Phase 4 independently rejects the same measure as unresolved, so it shouldn't
        // leave this phantom column behind for it.
        const knownColumns = datasetNameToPhysical.get(measureDatasetName)?.columns;
        const isUnverifiableGuess = !resolvedFromReference && !!knownColumns?.length && !knownColumns.some((c) => c.name === column);
        if (column && !isUnverifiableGuess) addReferencedColumn(measureDatasetName, column);
      }
    }
  }
}

/** Map XML dimension-type/level-type to SML time_unit. */
function mapLevelType(xmlLevelType: string | undefined): string | undefined {
  if (!xmlLevelType) return undefined;
  switch (xmlLevelType) {
    case "TimeYears":     return "year";
    case "TimeHalfYears": return "halfyear";
    case "TimeQuarters":  return "quarter";
    case "TimeMonths":    return "month";
    case "TimeWeeks":     return "week";
    case "TimeDays":      return "day";
    case "TimeHours":     return "hour";
    case "TimeMinutes":   return "minute";
    case "TimeSeconds":   return "second";
    default:              return undefined;
  }
}

/**
 * Coarse-to-fine rank of every SML time_unit, used to reorder a time hierarchy's levels.
 * SML requires each level's time_unit to be no finer than the level above it; the source
 * XML's <level> order isn't guaranteed to already satisfy that (e.g. a "Year Month" lookup
 * level placed ahead of "Quarter" purely because that's how the modeler declared it), so
 * levels get sorted into this canonical coarse→fine order rather than passed through as-is.
 * A level with no recognized time_unit sorts after all recognized ones, keeping its
 * relative position among other such levels (stable sort).
 */
const TIME_UNIT_RANK: Record<string, number> = {
  year: 0, halfyear: 1, quarter: 2, month: 3, week: 4, day: 5, hour: 6, minute: 7, second: 8,
};

/**
 * Ordered [pattern, time_unit] fallbacks for levels inside a time dimension whose
 * XML level-type is missing or unrecognized (e.g. custom levels like "customquarter").
 */
const TIME_UNIT_NAME_PATTERNS: Array<[RegExp, string]> = [
  [/\byear\b|\byr\b/i,          "year"],
  [/\bquarter\b|\bqtr\b/i,      "quarter"],
  [/\bhalf.?year\b|\bh[12]\b/i, "halfyear"],
  [/\bmonth\b/i,                "month"],
  [/\bweek\b|\bwk\b/i,          "week"],
  [/\bday\b|\bdate\b/i,         "day"],
  [/\bhour\b|\bhr\b/i,          "hour"],
  [/\bminute\b|\bmin\b/i,       "minute"],
  [/\bsecond\b|\bsec\b/i,       "second"],
  [/year/i,                     "year"],
  [/quarter/i,                  "quarter"],
  [/half.?year|halfyr/i,        "halfyear"],
  [/month/i,                    "month"],
  [/week/i,                     "week"],
  [/date|day/i,                 "day"],
  [/hour/i,                     "hour"],
  [/minute/i,                   "minute"],
  [/second/i,                   "second"],
];

/** Fallback: infer a level's time_unit from its name when the XML level-type is missing/unrecognized. */
function inferTimeUnitFromName(levelName: string): string | undefined {
  for (const [pattern, unit] of TIME_UNIT_NAME_PATTERNS) {
    if (pattern.test(levelName)) return unit;
  }
  return undefined;
}

// ============================================================
// Dataset physical section parser
// ============================================================

/** Map XML column type strings to SML data_type values. */
function mapDataType(xmlType: string | undefined): string {
  if (!xmlType) return "string";
  switch (xmlType.toLowerCase()) {
    case "string":    return "string";
    case "int":
    case "integer":   return "int";
    case "long":      return "long";
    case "float":     return "float";
    case "double":    return "double";
    case "decimal":
    case "numeric":   return "decimal";
    case "date":      return "date";
    // AtScale's engine rejects "timestamp" as an unrecognized physical type at deploy
    // time even though it's a valid static data_type token — the reference converter
    // always emits "datetime" instead, so both map there for engine compatibility.
    case "timestamp":
    case "datetime":  return "datetime";
    case "boolean":
    case "bool":      return "boolean";
    // Semi-structured/JSON types (e.g. Snowflake VARIANT) have no SML equivalent — treat as string.
    case "variant":
    case "json":
    case "object":
    case "array":     return "string";
    default:          return xmlType.toLowerCase();
  }
}

function parseDatasetPhysical(dsEl: Record<string, unknown>): DatasetPhysical | undefined {
  const physSec = first(arr(dsEl.physical)) as Record<string, unknown> | undefined;
  if (!physSec) return undefined;

  // Connection name from <connection id="...">
  const connEl = first(arr(physSec.connection)) as Record<string, unknown> | undefined;
  const connectionName = connEl ? a(connEl, "id") : undefined;

  // Immutable flag from <immutable>true|false</immutable> — preserve an explicit `false`
  // rather than collapsing it into "tag absent" (both used to become `undefined`).
  const immutableStr = s(first(arr(physSec.immutable)));
  const immutable = immutableStr === "true" ? true : immutableStr === "false" ? false : undefined;

  // Aggregate-eligibility flags from the sibling <properties> element:
  //   <properties>
  //     <allow-aggregates>true</allow-aggregates>
  //     <aggregate-destinations>
  //       <allow-local>true</allow-local><allow-peer>true</allow-peer><allow-preferred>true</allow-preferred>
  //     </aggregate-destinations>
  //   </properties>
  // `<properties>` is a peer of `<physical>` on the <data-set> element (dsEl), not nested
  // inside it.
  const boolFrom = (v: string | undefined): boolean | undefined => (v === "true" ? true : v === "false" ? false : undefined);
  const propsSec = first(arr(dsEl.properties)) as Record<string, unknown> | undefined;
  const allowAggregates = boolFrom(s(first(arr(propsSec?.["allow-aggregates"]))));
  const aggDestEl = first(arr(propsSec?.["aggregate-destinations"])) as Record<string, unknown> | undefined;
  const allowLocalAggs = boolFrom(s(first(arr(aggDestEl?.["allow-local"]))));
  const allowPeerAggs = boolFrom(s(first(arr(aggDestEl?.["allow-peer"]))));
  const allowPreferredAggs = boolFrom(s(first(arr(aggDestEl?.["allow-preferred"]))));

  // Column definitions from <column><name>...</name><type>...</type></column>, optionally
  // <sql>...</sql> for a computed column (an expression aliased under this column name,
  // rather than a direct passthrough of a real table column) — without it, the computed
  // column's own name would be queried against the real table as if it existed there
  // directly. Source XML can genuinely declare the same column twice (a copy-paste
  // artifact, or a plain base column shadowed by a later computed override with the
  // same name) — dedupe by name, but prefer whichever duplicate carries a <sql>
  // expression, since dropping a computed override silently turns it into a plain
  // passthrough column.
  type ColEntry = DatasetPhysical["columns"] extends Array<infer T> | undefined ? T : never;
  const columnsByName = new Map<string, ColEntry>();
  const columnOrder: string[] = [];
  function addColumn(name: string, entry: ColEntry, preferOverExisting: boolean): void {
    const existing = columnsByName.get(name);
    if (!existing) {
      columnOrder.push(name);
      columnsByName.set(name, entry);
    } else if (preferOverExisting) {
      columnsByName.set(name, entry);
    }
  }
  /** A column with no computed SQL, map, or parent-column linkage — safe to silently replace. */
  const isPlainColumn = (c: ColEntry): boolean => !c.sql && !c.map && !c.parentColumn;
  for (const col of arr(physSec.column)) {
    const colName = s(first(arr((col as Record<string, unknown>).name)));
    const colType = s(first(arr((col as Record<string, unknown>).type)));
    const colSqlEls = arr((col as Record<string, unknown>).sql);
    // A computed column can declare multiple <sql dialect="..."> variants — the base
    // definition is the one with no dialect attribute; other variants become dialects:.
    const colSqlRaw = pickBaseSql(colSqlEls);
    const colSql = colSqlRaw ? unescapeHtml(colSqlRaw).replace(/\t/g, "  ") : undefined;
    const colDialectEls = colSqlEls.filter((el) => a(el, "dialect"));
    const colDialects = colDialectEls
      .map((el) => {
        const dialect = a(el, "dialect");
        const sqlText = s(el);
        return dialect && sqlText ? { dialect, sql: unescapeHtml(sqlText).replace(/\t/g, "  ") } : undefined;
      })
      .filter((d): d is { dialect: string; sql: string } => Boolean(d));
    if (!colName) continue;
    addColumn(
      colName,
      { name: colName, dataType: mapDataType(colType), sql: colSql, dialects: colDialects.length ? colDialects : undefined },
      Boolean(colSql && !columnsByName.get(colName)?.sql),
    );
  }

  // <map-column>: a semi-structured MAP-typed physical column (e.g. Hive MAP<string,string>),
  // delimited into keys/values, with its own nested <columns> projecting individual keys out
  // of the map. Emitted as a `map:` column (no data_type) plus one sub-column per nested key,
  // each carrying `parent_column` back to the map column's own name.
  for (const mapCol of arr(physSec["map-column"])) {
    const mapColEl = mapCol as Record<string, unknown>;
    const mapColName = s(first(arr(mapColEl.name)));
    if (!mapColName) continue;
    const delimitedEl = first(arr(mapColEl.delimited)) as Record<string, unknown> | undefined;
    const fieldTerminator = delimitedEl ? s(first(arr(delimitedEl["field-terminator"]))) : undefined;
    const keyTerminator = delimitedEl ? s(first(arr(delimitedEl["key-terminator"]))) : undefined;
    const isPrefixed = delimitedEl ? a(delimitedEl, "prefixed") === "true" : false;
    const mapKeyEl = first(arr(mapColEl["map-key"])) as Record<string, unknown> | undefined;
    const mapValueEl = first(arr(mapColEl["map-value"])) as Record<string, unknown> | undefined;
    const keyType = mapKeyEl ? s(first(arr(mapKeyEl.type))) : undefined;
    const valueType = mapValueEl ? s(first(arr(mapValueEl.type))) : undefined;
    if (!fieldTerminator || !keyTerminator || !keyType || !valueType) continue;
    // Only replace a same-named collision if the existing entry is a plain passthrough
    // column — never silently discard another column's computed <sql>, its own map:
    // definition, or its parent-column linkage (a genuine name collision between two
    // distinct physical/computed columns is a source-data ambiguity, not something to
    // resolve by picking whichever happened to be seen last).
    const existingMapCol = columnsByName.get(mapColName);
    addColumn(
      mapColName,
      {
        name: mapColName,
        map: { fieldTerminator, keyTerminator, keyType, valueType, isPrefixed: isPrefixed || undefined },
      },
      !existingMapCol || isPlainColumn(existingMapCol),
    );

    const colsEl = first(arr(mapColEl.columns)) as Record<string, unknown> | undefined;
    for (const subCol of arr(colsEl?.column)) {
      const subColEl = subCol as Record<string, unknown>;
      const subColName = s(first(arr(subColEl.name)));
      const subColType = s(first(arr(subColEl.type)));
      if (!subColName) continue;
      const existingSubCol = columnsByName.get(subColName);
      addColumn(
        subColName,
        { name: subColName, dataType: mapDataType(subColType), parentColumn: mapColName },
        !existingSubCol || isPlainColumn(existingSubCol),
      );
    }
  }

  const columns = columnOrder.map((name) => columnsByName.get(name)!);
  const colsResult = columns.length ? columns : undefined;
  const aggFlags = { allowAggregates, allowLocalAggs, allowPeerAggs, allowPreferredAggs };

  const tableEl = first(arr(physSec.table)) as Record<string, unknown> | undefined;
  // A dataset can declare multiple <query> elements: the base query (no "alternate"
  // attribute) plus alternate query/table bindings (alternate="true") — alternates aren't
  // converted, so picking whichever <query> comes first in document order can silently
  // treat an alternate binding as if it were the dataset's primary definition.
  const queryEls = arr(physSec.query);
  const queryEl = queryEls.find((q) => !a(q, "alternate")) as Record<string, unknown> | undefined;

  if (tableEl) {
    const db = s(first(arr(tableEl.database)));
    const schema = s(first(arr(tableEl.schema)));
    const tableName = s(first(arr(tableEl.name)));
    return { db, schema, tableName, connectionName, columns: colsResult, immutable, ...aggFlags };
  }

  if (queryEl) {
    const sqlEls = arr(queryEl.sql);
    const rawSql = pickBaseSql(sqlEls);
    if (rawSql) {
      const dialectEls = sqlEls.filter((el) => a(el, "dialect"));
      const dialects = dialectEls
        .map((el) => {
          const dialect = a(el, "dialect");
          const sqlText = s(el);
          return dialect && sqlText ? { dialect, sql: unescapeHtml(sqlText).replace(/\t/g, "  ") } : undefined;
        })
        .filter((d): d is { dialect: string; sql: string } => Boolean(d));
      // Replace tabs with spaces so js-yaml can use block literal (| style) rather than quoted
      return {
        sql: unescapeHtml(rawSql).replace(/\t/g, "  "),
        dialects: dialects.length ? dialects : undefined,
        connectionName,
        columns: colsResult,
        immutable,
        ...aggFlags,
      };
    }
  }

  return { connectionName, columns: colsResult, immutable, ...aggFlags };
}

/** Pick the base (no dialect attribute) <sql> element's text from a set of dialect variants. */
/**
 * Pick the base (no dialect attribute) <sql> element's text from a set of dialect variants.
 * Matches the reference converter's getBaseSql()/getBaseQuery(): if every <sql> is
 * dialect-tagged, there is no base definition at all — returning one of the dialect-specific
 * variants here would silently promote (and duplicate into `dialects:`) one engine's SQL as
 * if it were the universal default.
 */
function pickBaseSql(sqlEls: Record<string, unknown>[]): string | undefined {
  const base = sqlEls.find((el) => !a(el, "dialect"));
  return base ? s(base) : undefined;
}

// ============================================================
// Phase 2: Dataset YAML
// ============================================================

function buildDatasetYaml(
  dsEl: Record<string, unknown>,
  dsName: string,
  connectionId: string,
  /** Every column any key-ref/attribute-ref points to for this dataset, regardless of <physical>. */
  referencedColumns?: Set<string>,
): string {
  const phys = parseDatasetPhysical(dsEl) ?? {};

  const obj: Record<string, unknown> = {
    unique_name: `${dsName}.dataset`,
    object_type: "dataset",
    label: dsName,          // preserve original casing; do not title-case
    connection_id: connectionId,
  };

  if (phys.immutable !== undefined) obj.immutable = phys.immutable;

  if (phys.sql) {
    obj.sql = phys.sql;
    if (phys.dialects?.length) obj.dialects = phys.dialects;
  } else {
    // db/schema always live on the connection (see connectionIdByDataset) — a dataset's
    // own table is always a plain string; a nested {db, schema, name} object here is
    // schema-valid SML but rejected by AtScale's live engine.
    obj.table = phys.tableName ?? dsName;
  }

  // A binary column can also be kept alive purely because some OTHER column's own <sql>
  // computed expression references it by name (e.g. a CASE/derived column built from the
  // raw binary value) — that sibling column is emitted regardless of the binary filter
  // below, so dropping the binary column it depends on would leave the generated SQL
  // referencing a column that no longer exists in SML.
  const sqlReferencedColumnNames = new Set<string>();
  for (const col of phys.columns ?? []) {
    if (!col.sql) continue;
    for (const other of phys.columns ?? []) {
      if (other.name === col.name) continue;
      if (new RegExp(`\\b${other.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(col.sql)) {
        sqlReferencedColumnNames.add(other.name);
      }
    }
  }

  const columns: Array<Record<string, unknown>> =
    (phys.columns ?? [])
      // A column whose XML type has no SML equivalent (e.g. Snowflake BINARY) is only
      // safe to keep if something actually references it (a key/relationship column, or
      // a sibling calculated column's own SQL expression); otherwise it's dead physical
      // metadata that fails catalog validation outright — drop it, matching the reference
      // converter's own "unused, will be removed" behavior for these columns. A map
      // column has no data_type at all (SML only requires one unless the column is a
      // map), so it's never subject to this filter.
      .filter((c) => !c.dataType?.startsWith("binary") || referencedColumns?.has(c.name) || sqlReferencedColumnNames.has(c.name))
      .map((c) => ({
        name: c.name,
        ...(c.dataType ? { data_type: c.dataType } : {}),
        ...(c.sql ? { sql: c.sql } : {}),
        ...(c.dialects?.length ? { dialects: c.dialects } : {}),
        ...(c.map ? { map: { field_terminator: c.map.fieldTerminator, key_terminator: c.map.keyTerminator, key_type: c.map.keyType, value_type: c.map.valueType, ...(c.map.isPrefixed ? { is_prefixed: true } : {}) } } : {}),
        ...(c.parentColumn ? { parent_column: c.parentColumn } : {}),
      }));

  if (referencedColumns?.size) {
    const known = new Set(columns.map((c) => c.name));
    for (const col of referencedColumns) {
      if (!known.has(col)) columns.push({ name: col, data_type: "string" }); // unknown — mark for review
    }
  }

  if (columns.length) obj.columns = columns;

  return toYaml(obj);
}

/**
 * Resolves which dimension "owns" each attribute id, for User Defined Aggregate parsing —
 * plus, for perspective parsing, which hierarchy each hierarchy id names and which
 * dimension/hierarchy/level each level's primary-attribute id names.
 *
 * An attribute is hosted natively by whichever dimension references it via a plain
 * `<keyed-attribute-ref attribute-id="X">` with no `ref-id` (the same distinction
 * buildDimensionYaml already uses to separate secondary attributes from skipped
 * cross-dimension refs). When a `ref-id` IS present, the id is instead an opaque
 * "path token" pairing the CURRENT (host) dimension with a foreign attribute reached via
 * a snowflake/embedded relationship — there is no separate declaration to look up, so the
 * ref-id itself is recorded against the host dimension's name for later synthesis of
 * `relationships_path` as `{hostDimension}_{targetDimensionNoSpaces}`.
 */
function collectAttributeDimensionOwnership(
  allDims: Map<string, Record<string, unknown>>,
  attrDef: Map<string, AttrDefEntry>,
): {
  attrIdToDimName: Map<string, string>;
  refIdToHostDimName: Map<string, string>;
  hierarchyIdToRef: Map<string, { dimName: string; hierUniqueName: string }>;
  primaryAttrIdToLevelRef: Map<string, { dimName: string; hierUniqueName: string; levelUniqueName: string }>;
} {
  const attrIdToDimName = new Map<string, string>();
  const refIdToHostDimName = new Map<string, string>();
  const hierarchyIdToRef = new Map<string, { dimName: string; hierUniqueName: string }>();
  const primaryAttrIdToLevelRef = new Map<
    string,
    { dimName: string; hierUniqueName: string; levelUniqueName: string }
  >();

  for (const [dimName, dimEl] of allDims) {
    // Two distinct hierarchies (e.g. "Region" and "Region.") can
    // sanitize to the identical safeName() output once punctuation-only differences are
    // stripped — disambiguate with the same "_2"/"_3" suffix convention used elsewhere in
    // this file, scoped per dimension so it agrees with buildDimensionYaml's own
    // (identically-scoped, identically-ordered) hierarchy disambiguation for this
    // dimension's actual emitted YAML.
    const usedHierUniqueNamesInDim = new Set<string>();
    // Same idea, for levels: two distinct keyed-attributes in different hierarchies of the
    // same dimension (e.g. "AF LOB Group" and "AF LOB Group.") can also collide once
    // punctuation is stripped. Disambiguated here, once per attribute id, so buildDimensionYaml
    // and findCubeMatchingLevels (which both need to agree on this level's name) look it up
    // from primaryAttrIdToLevelRef instead of re-deriving it — otherwise the second
    // colliding attribute's own metadata (format, folder, allowed_calcs_for_dma, ...) has
    // nowhere of its own to live and gets silently merged into the first's.
    const usedLevelUniqueNamesInDim = new Set<string>();
    for (const hierEl of arr(dimEl.hierarchy)) {
      const hierId = a(hierEl, "id");
      const rawHierUniqueName = truncateUniqueName(safeName(a(hierEl, "name") ?? "Hierarchy"));
      let hierUniqueName = rawHierUniqueName;
      if (usedHierUniqueNamesInDim.has(hierUniqueName)) {
        let n = 2;
        while (usedHierUniqueNamesInDim.has(`${rawHierUniqueName}_${n}`)) n++;
        hierUniqueName = `${rawHierUniqueName}_${n}`;
      }
      usedHierUniqueNamesInDim.add(hierUniqueName);
      if (hierId && !hierarchyIdToRef.has(hierId)) {
        hierarchyIdToRef.set(hierId, { dimName, hierUniqueName });
      }
      for (const levelEl of arr(hierEl.level)) {
        const primaryAttrUuid = a(levelEl, "primary-attribute");
        if (primaryAttrUuid && !attrIdToDimName.has(primaryAttrUuid)) {
          attrIdToDimName.set(primaryAttrUuid, dimName);
        }
        if (primaryAttrUuid && !primaryAttrIdToLevelRef.has(primaryAttrUuid)) {
          const primaryDef = attrDef.get(primaryAttrUuid);
          if (primaryDef) {
            const rawLevelUniqueName = levelUniqueNameFor(primaryDef.name);
            let levelUniqueName = rawLevelUniqueName;
            if (usedLevelUniqueNamesInDim.has(levelUniqueName)) {
              let n = 2;
              while (usedLevelUniqueNamesInDim.has(`${rawLevelUniqueName}_${n}`)) n++;
              levelUniqueName = `${rawLevelUniqueName}_${n}`;
            }
            usedLevelUniqueNamesInDim.add(levelUniqueName);
            primaryAttrIdToLevelRef.set(primaryAttrUuid, {
              dimName,
              hierUniqueName,
              levelUniqueName,
            });
          }
        }
        for (const kref of arr(levelEl["keyed-attribute-ref"])) {
          const attrId = a(kref, "attribute-id");
          const refId = a(kref, "ref-id");
          if (!attrId) continue;
          if (refId) {
            if (!refIdToHostDimName.has(refId)) refIdToHostDimName.set(refId, dimName);
          } else if (!attrIdToDimName.has(attrId)) {
            attrIdToDimName.set(attrId, dimName);
          }
        }
      }
    }
  }

  return { attrIdToDimName, refIdToHostDimName, hierarchyIdToRef, primaryAttrIdToLevelRef };
}

/**
 * Resolve a cross-dimension embedded <keyed-attribute-ref ref-id attribute-id> into a proper
 * SML snowflake relationship, the same way a fact-to-dimension join is inferred elsewhere in
 * this file: the host dataset declares an incomplete key-ref, the target dataset declares the
 * complete/unique counterpart sharing the same key-ref id, and matching the two up is the join.
 *
 * `refId` names the ref-path (not a key-ref id directly) — refPathIdToKeyRefId bridges it to
 * the key-ref id that actually carries it, which keyMap then resolves to every dataset bound
 * to that id. `to.level` names a level of THIS (host) dimension, not the target's — confirmed
 * against the reference `dim_room.yml`/`dim-property` example in resources/verticals: the
 * live engine looks it up as one of the host dimension's own attributes and rejects the
 * relationship outright if it isn't. The keyed-attribute-ref's own enclosing level is exactly
 * that — the host-side grain this snowflake join attaches to — so the caller passes it in
 * rather than this function trying to derive one from the target side.
 *
 * Returns undefined (caller reports an omission) when the join can't be traced end to end: no
 * bridging key-ref, an ambiguous set of bindings, the target attribute's owning dimension is
 * unknown, or it resolves back to this same dimension.
 */
function resolveSnowflakeRelationship(
  refId: string,
  attrId: string,
  hostDimName: string,
  hostLevelUniqueName: string,
  keyMap: Map<string, KeyRefEntry[]>,
  refPathIdToKeyRefId: Map<string, string>,
  attrIdToDimName: Map<string, string>,
): DimMeta["snowflakeRelationships"][number] | undefined {
  const hostKeyRefId = refPathIdToKeyRefId.get(refId);
  const entries = hostKeyRefId ? keyMap.get(hostKeyRefId) : undefined;
  if (!entries || entries.length !== 2) return undefined;

  const targetEntry = entries.find((e) => e.complete === "true" && e.unique);
  const hostEntry = entries.find((e) => e !== targetEntry);
  if (!targetEntry || !hostEntry) return undefined;

  const targetDimName = attrIdToDimName.get(attrId);
  if (!targetDimName || targetDimName === hostDimName) return undefined;

  return {
    uniqueName: `${hostDimName.replace(/\s+/g, "")}_${targetDimName.replace(/\s+/g, "")}`,
    fromDataset: `${hostEntry.datasetName}.dataset`,
    fromColumns: hostEntry.columns,
    toDimension: targetDimName,
    toLevel: hostLevelUniqueName,
  };
}

/**
 * Collects every column that is, on its own, the entire (single-column) key of some level
 * anywhere in the schema — used to pick a sane default name_column for a DIFFERENT level
 * whose own key is composite.
 *
 * A composite key is typically a coarser identifier concatenated with the level's own
 * column (e.g. a "cube" level keyed on [org_id, project_id, cube_id], where org_id and
 * project_id belong to separate ORG/PROJECT dimensions/levels and only cube_id is this
 * level's own identity). Defaulting name_column to the first key column — which happens
 * to be correct when nothing is composite, or when a composite key mixes columns that are
 * never independently a level's own key elsewhere — is wrong whenever a column in the key
 * IS independently the sole key of another level: that column represents a foreign
 * identity, not this level's own name, so it should be excluded from consideration in
 * favor of whichever column remains.
 */
function collectSoleKeyColumns(
  allDims: Map<string, Record<string, unknown>>,
  attrDef: Map<string, AttrDefEntry>,
  keyMap: Map<string, KeyRefEntry[]>,
): Set<string> {
  const soleKeyColumns = new Set<string>();

  for (const dimEl of allDims.values()) {
    for (const hierEl of arr(dimEl.hierarchy)) {
      for (const levelEl of arr(hierEl.level)) {
        const primaryAttrUuid = a(levelEl, "primary-attribute");
        if (!primaryAttrUuid) continue;
        const def = attrDef.get(primaryAttrUuid);
        if (!def) continue;
        const keyEntries = keyMap.get(def.keyUuid) ?? [];
        const authEntry = keyEntries.find((e) => e.complete === "true") ?? keyEntries[0];
        if (authEntry?.columns.length === 1) {
          soleKeyColumns.add(authEntry.columns[0]);
        }
      }
    }
  }

  return soleKeyColumns;
}

/**
 * Default name_column for a level's (possibly composite) key: exclude any column that is
 * either (a) independently the sole key of some other level in the schema (see
 * collectSoleKeyColumns) or (b) a date/datetime-typed column, then take the last
 * remaining column — composite keys are built coarse-to-fine, so after removing
 * foreign/borrowed identity columns and pure date qualifiers, the last of what's left is
 * this level's own most granular, nameable column.
 *
 * Both exclusions are needed together: a column can be the sole key of another dimension
 * (e.g. an account or customer's own id) yet still be the right name_column for THIS
 * level, when the only other candidate is a date column tacked on purely to scope a
 * snapshot (e.g. "account as of month-end") — a date is essentially never what a user
 * wants as a dimension member's display name. Conversely a column can be a perfectly
 * ordinary string/id with no date involved, yet still need excluding because it belongs
 * to a genuinely separate dimension (e.g. an org id inside a project/cube/perspective
 * key). Excluding only one of the two signals produces wrong answers for the other
 * pattern, so both apply and whichever columns end up excluded are removed together.
 *
 * If every column ends up excluded, or nothing does, there is no positive signal to act
 * on, so the original first-column default is kept unchanged.
 */
/**
 * Resolve a keyed-attribute's sort_column from its own <properties><ordering><sort-key>
 * <key-ref id="..."/></sort-key></ordering> — a <key-ref> id resolved through keyMap, the
 * same mechanism used for the attribute's own key columns, not the attribute-ref/column
 * lookup used for name_column. Every keyed-attribute (primary level attribute or
 * secondary attribute alike) can declare its own custom sort key this way; absent one,
 * there is no override and the caller should fall back to name_column.
 */
function resolveSortColumn(
  sortKeyUuid: string | undefined,
  keyMap: Map<string, KeyRefEntry[]>,
  preferredDatasetName?: string,
): string | undefined {
  if (!sortKeyUuid) return undefined;
  const entries = keyMap.get(sortKeyUuid);
  if (!entries || entries.length === 0) return undefined;
  const preferred = preferredDatasetName ? entries.find((e) => e.datasetName === preferredDatasetName) : undefined;
  const entry = preferred ?? entries.find((e) => e.complete === "true") ?? entries[0];
  return entry.columns[0];
}

function defaultNameColumn(
  keyColumns: string[],
  datasetName: string,
  soleKeyColumns: Set<string>,
  datasetNameToPhysical: Map<string, DatasetPhysical>,
): string {
  if (keyColumns.length <= 1) return keyColumns[0];
  const physColumns = datasetNameToPhysical.get(datasetName)?.columns;
  const isDateLike = (col: string): boolean => {
    const dataType = physColumns?.find((c) => c.name === col)?.dataType;
    return dataType === "date" || dataType === "datetime";
  };
  const remaining = keyColumns.filter((c) => !soleKeyColumns.has(c) && !isDateLike(c));
  if (remaining.length > 0 && remaining.length < keyColumns.length) {
    return remaining[remaining.length - 1];
  }
  return keyColumns[0];
}

// ============================================================
// Phase 3: Dimension YAML
// ============================================================

interface SecondaryAttrDef {
  uniqueName: string;
  label: string;
  dataset: string;
  keyColumns: string[];
  nameColumn: string;
  sortColumn: string;
  allowedCalcsForDma?: string[];
  format?: string;
  isHidden?: boolean;
  isUniqueKey?: boolean;
  folder?: string;
  description?: string;
}

interface LevelAttrDef {
  uniqueName: string;
  label: string;
  dataset: string;
  keyColumns: string[];
  nameColumn: string;
  sortColumn?: string;
  timeUnit?: string;
  isHiddenFromUi?: boolean;
  isUniqueKey?: boolean;
  folder?: string;
  description?: string;
  format?: string;
  allowedCalcsForDma?: string[];
  /** Set instead of dataset/keyColumns/nameColumn when this level is degenerate on more
   *  than one fact dataset (e.g. a flag column present on both a cube's primary fact table
   *  and its YTD fact table) — SML's shared_degenerate_columns, one entry per fact dataset. */
  sharedDegenerateColumns?: Array<{ dataset: string; keyColumns: string[]; nameColumn: string }>;
}

function buildDimensionYaml(
  dimEl: Record<string, unknown>,
  dimName: string,
  attrDef: Map<string, AttrDefEntry>,
  keyMap: Map<string, KeyRefEntry[]>,
  attrMap: Map<string, AttrRefEntry>,
  /** Whether inferRelationships determined this dimension is degenerate (no relationship
   * in any cube that uses it) — the single source of truth for is_degenerate/type, so it
   * can never disagree with the model's own dimensions:/relationships: placement. */
  isDegenerate: boolean,
  /** Columns that are the sole key of some other level in the schema — see
   * collectSoleKeyColumns/defaultNameColumn for how this refines a composite key's
   * default name_column. */
  soleKeyColumns: Set<string>,
  datasetNameToPhysical: Map<string, DatasetPhysical>,
  metricalAttrDef: Map<string, MetricalAttrDef>,
  /** Per-level fact-dataset bindings gathered across every cube that uses this dimension
   * (levelName -> datasetName -> keyColumns), only meaningful when isDegenerate is true. A
   * level backed by more than one distinct dataset here emits shared_degenerate_columns
   * instead of a single dataset/key_columns/name_column. */
  degenerateBindingsForDim: Map<string, Map<string, string[]>> | undefined,
  /** Every keyed-attribute id's owning (native) dimension name — resolves a cross-dimension
   *  embedded ref's attribute-id to the dimension whose file its attribute actually lives on. */
  attrIdToDimName: Map<string, string>,
  /** ref-path id -> the key-ref id that completes it — see its own declaration for why this
   *  indirection exists. */
  refPathIdToKeyRefId: Map<string, string>,
  /** Every hierarchy id's dimension + already-disambiguated unique_name, computed once by
   *  collectAttributeDimensionOwnership — reused here instead of re-deriving locally so a
   *  punctuation-only hierarchy-name collision (e.g. "Region" vs "Region.") gets the
   *  exact same "_2" suffix perspectives/aggregates resolve against. */
  hierarchyIdToRef: Map<string, { dimName: string; hierUniqueName: string }>,
  /** Every keyed-attribute id's dimension + already-disambiguated hierarchy/level unique_name,
   *  computed once by collectAttributeDimensionOwnership — reused here (and by
   *  findCubeMatchingLevels / the semi-additive resolution loop) instead of re-deriving the
   *  level name locally, so a punctuation-only collision between two DIFFERENT keyed-attributes
   *  (e.g. "AF LOB Group" vs "AF LOB Group.") gets its own distinct name and its own metadata,
   *  rather than the second one silently merging into the first's level_attributes entry. */
  primaryAttrIdToLevelRef: Map<string, { dimName: string; hierUniqueName: string; levelUniqueName: string }>,
): { yaml: string; meta: DimMeta } {
  const props = first(arr(dimEl.properties)) as Record<string, unknown> | undefined;
  const dimTypeRaw = props ? s(first(arr(props["dimension-type"]))) : undefined;
  const isTime = dimTypeRaw === "Time";
  // Fall back to the dimension's own raw XML name, not dimName — dimName is the
  // collision-disambiguated unique_name (e.g. "Foo_2" when two different dimensions
  // elsewhere in the project share the display name "Foo"), and that "_2" suffix has no
  // business appearing in a user-facing label when the source never had a caption to
  // override it with.
  const rawDimName = a(dimEl, "name") ?? dimName;
  const label = props ? (s(first(arr(props.caption))) ?? rawDimName) : rawDimName;
  const dimDescription = props ? s(first(arr(props.description))) : undefined;

  // Meta tracking
  let metaTotalLevels = 0;
  let metaHasDefaultMembers = false;
  const metaSkippedCrossDimRefs: Array<{ dimName: string; attrId: string }> = [];
  const metaSkippedMetricalQuantiles: string[] = [];
  const metaSkippedMetricalUnresolved: string[] = [];
  const metaSnowflakeRelationships: DimMeta["snowflakeRelationships"] = [];
  const metaDroppedSecondaryAttrsForSharedDegenerate: DimMeta["droppedSecondaryAttrsForSharedDegenerate"] = [];

  // Once ANY level of this degenerate dimension is bound to more than one fact dataset (see
  // degenerateBindingsForDim), the engine requires EVERY level of the same dimension to use
  // the shared_degenerate_columns shape — mixing it with plain dataset/key_columns/
  // name_column levels in one dimension is rejected as "Level attributes in a degenerate
  // dimension must be of the same type." A level that only happens to bind to a single fact
  // dataset still gets wrapped in a one-element shared_degenerate_columns array below so
  // every level in the dimension is consistently shaped.
  const dimensionUsesSharedDegenerateFormat =
    isDegenerate &&
    !!degenerateBindingsForDim &&
    Array.from(degenerateBindingsForDim.values()).some((m) => m.size > 1);

  // Collect level attributes (de-duplicated by uniqueName)
  const levelAttrMap = new Map<string, LevelAttrDef>();
  // A level shared across multiple hierarchies (e.g. a "Date" leaf common to a Calendar
  // Hierarchy and a Fiscal Hierarchy) is the same physical level each time, but each
  // hierarchy's own <level> element can carry its OWN, genuinely different
  // <keyed-attribute-ref> list — e.g. a Performance Year hierarchy exposing
  // performance-year-specific secondary attributes on the same shared date level a Calendar
  // hierarchy exposes calendar-specific ones on. Tracking per exact secondary-attribute/
  // metric unique_name (not per level as a whole) lets every hierarchy's distinct set through
  // while still suppressing a literal re-declaration of the same attribute under the same
  // level — which the engine does reject as a duplicate.
  const levelSecondaryAttrsEmitted = new Set<string>();
  const levelMetricsEmitted = new Set<string>();

  const hierarchies: Array<{
    uniqueName: string;
    label: string;
    filterEmpty?: string;
    folder?: string;
    description?: string;
    defaultMember?: { literal_value: string; apply_in_query?: boolean };
    levels: Array<{
      uniqueName: string;
      timeUnit?: string;
      isHidden?: boolean;
      secondaryAttributes?: SecondaryAttrDef[];
      metrics?: MetricalAttrOut[];
    }>;
  }> = [];

  for (const hierEl of arr(dimEl.hierarchy)) {
    const hierName = a(hierEl, "name") ?? "Hierarchy";
    const hierProps = first(arr(hierEl.properties)) as Record<string, unknown> | undefined;
    const hierCaption = hierProps ? s(first(arr(hierProps.caption))) : undefined;
    const hierFolder = hierProps ? s(first(arr(hierProps.folder))) : undefined;
    const hierDescription = hierProps ? s(first(arr(hierProps.description))) : undefined;

    // filter_empty: only store when NOT "always" ("always" is the SML default)
    const filterEmptyRaw = hierProps ? s(first(arr(hierProps["filter-empty"]))) : undefined;
    const filterEmpty =
      filterEmptyRaw && filterEmptyRaw.toLowerCase() !== "always"
        ? filterEmptyRaw.toLowerCase()
        : undefined;

    // Default member — structured object with literal_value (and apply_in_query only when true)
    const defaultMemberEl = hierProps
      ? (first(arr(hierProps["default-member"])) as Record<string, unknown> | undefined)
      : undefined;
    const literalMember = defaultMemberEl
      ? s(first(arr(defaultMemberEl["literal-member"])))
      : undefined;
    let defaultMember: { literal_value: string; apply_in_query?: boolean } | undefined;
    if (literalMember) {
      const applyRaw =
        a(defaultMemberEl!, "applyInQuery") ??
        s(first(arr((defaultMemberEl as Record<string, unknown>).applyInQuery)));
      const applyInQuery = applyRaw === "true";
      defaultMember = {
        literal_value: unescapeHtml(literalMember),
        ...(applyInQuery ? { apply_in_query: true } : {}),
      };
      metaHasDefaultMembers = true;
    }

    const hierLevels: Array<{
      uniqueName: string;
      timeUnit?: string;
      isHidden?: boolean;
      secondaryAttributes?: SecondaryAttrDef[];
      metrics?: MetricalAttrOut[];
    }> = [];

    const levelEls = arr(hierEl.level);
    // Pre-resolve every level's time_unit positionally, up front, so a level whose XML
    // level-type doesn't map to any known unit — e.g. AtScale's own "TimeUndefined", used
    // for a custom retail-calendar period that doesn't fit year/quarter/month/week/day —
    // can still get a usable one inferred from its place between recognized neighbors,
    // rather than being left without one entirely. SML requires every level of a `type:
    // time` dimension to declare a time_unit; standard/degenerate dimensions don't use this
    // at all, and their (not necessarily granularity-ordered) level order is unaffected.
    const rawTimeUnits: (string | undefined)[] = isTime
      ? levelEls.map((levelEl) => {
          const primaryAttrUuid = a(levelEl, "primary-attribute");
          const def = primaryAttrUuid ? attrDef.get(primaryAttrUuid) : undefined;
          const levelName = def ? (def.caption ?? def.name) : undefined;
          const lProps = first(arr((levelEl as Record<string, unknown>).properties)) as Record<string, unknown> | undefined;
          const levelTypeRaw = lProps ? s(first(arr(lProps["level-type"]))) : undefined;
          return mapLevelType(levelTypeRaw) ?? (levelName ? inferTimeUnitFromName(levelName) : undefined);
        })
      : [];
    if (isTime) {
      for (let i = 0; i < rawTimeUnits.length; i++) {
        if (rawTimeUnits[i]) continue;
        // Nearest known neighbors by position (already coarse-to-fine per the source XML's
        // own level order, same assumption the final sort below relies on). A gap of more
        // than one rank between them (e.g. year, then week) means this level occupies an
        // intermediate granularity the schema just didn't name — one rank finer than the
        // coarser neighbor is a reasonable "period" to slot it into; anything else (only one
        // neighbor known, or an adjacent gap) just reuses whichever neighbor is known.
        let before: string | undefined;
        for (let j = i - 1; j >= 0; j--) { if (rawTimeUnits[j]) { before = rawTimeUnits[j]; break; } }
        let after: string | undefined;
        for (let j = i + 1; j < rawTimeUnits.length; j++) { if (rawTimeUnits[j]) { after = rawTimeUnits[j]; break; } }
        const beforeRank = before ? TIME_UNIT_RANK[before] : undefined;
        const afterRank = after ? TIME_UNIT_RANK[after] : undefined;
        if (beforeRank !== undefined && afterRank !== undefined && afterRank > beforeRank + 1) {
          const targetRank = beforeRank + 1;
          rawTimeUnits[i] = Object.keys(TIME_UNIT_RANK).find((u) => TIME_UNIT_RANK[u] === targetRank);
        } else {
          rawTimeUnits[i] = before ?? after;
        }
      }
    }

    for (const [levelIndex, levelEl] of levelEls.entries()) {
      const primaryAttrUuid = a(levelEl, "primary-attribute");
      if (!primaryAttrUuid) continue;

      const def = attrDef.get(primaryAttrUuid);
      if (!def) continue;

      const levelName = def.caption ?? def.name;
      // Reuse collectAttributeDimensionOwnership's already-disambiguated unique_name for this
      // attribute id (see primaryAttrIdToLevelRef's own declaration for why two different
      // keyed-attributes can otherwise collide, e.g. "AF LOB Group" vs "AF LOB Group.")
      // instead of re-deriving it here, so this file and every relationship/semi-additive
      // block that references this level by id always agree on the same "_2"-suffixed name.
      const levelUniqueName = primaryAttrIdToLevelRef.get(primaryAttrUuid)?.levelUniqueName ?? levelUniqueNameFor(def.name);

      // Resolve key columns for the primary level attribute
      const keyEntries = keyMap.get(def.keyUuid) ?? [];
      const authEntry = pickAuthEntry(keyEntries, datasetNameToPhysical);
      if (!authEntry) continue;

      const keyColumns = authEntry.columns;
      const datasetRef = `${authEntry.datasetName}.dataset`;
      const isUniqueKey = authEntry.unique ?? false;

      // The level's own attribute-ref (same id as its primary-attribute) is the
      // authoritative source for the display column — an XML dataset's <logical>
      // section can declare both a <key-ref id="ka.key-ref"> (the key columns) and
      // an independent <attribute-ref id="ka.id"> for the same keyed-attribute,
      // and the latter's column is the intended name_column regardless of what the
      // key looks like (single or composite). Only fall back to the key-column
      // heuristic when no such attribute-ref exists.
      const primaryAttrRefEntry = attrMap.get(primaryAttrUuid);
      const nameColumn =
        primaryAttrRefEntry?.column ??
        defaultNameColumn(keyColumns, authEntry.datasetName, soleKeyColumns, datasetNameToPhysical);
      // sort_column comes from this attribute's own <properties><ordering><sort-key>
      // <key-ref id="..."/></sort-key></ordering> — a *key-ref*, resolved through keyMap
      // like the key columns, not through attrMap (which holds attribute-refs). Absent an
      // explicit sort key, sort by the attribute's own displayed value (name_column) —
      // the XSD's own default when no <ordering> is declared.
      const sortColumn = resolveSortColumn(def.sortKeyUuid, keyMap, authEntry.datasetName) ?? nameColumn;
      const secondaryAttrs: SecondaryAttrDef[] = [];

      // <keyed-attribute-ref> has no "role" attribute in the real schema (only ref-id and
      // attribute-id) — every entry here is a secondary attribute of this level, except ones
      // carrying ref-id, which are cross-dimension embedded relationships: this dimension
      // doesn't host the target attribute's data itself, it reaches it via a snowflake join
      // to whichever dimension actually owns it. Resolved into a proper SML snowflake
      // relationship (obj.relationships) when the join can be traced end to end; reported as
      // an omission when it can't, rather than guessed.
      for (const kref of arr(levelEl["keyed-attribute-ref"])) {
        const attrId = a(kref, "attribute-id");
        const refId = a(kref, "ref-id");
        if (!attrId) continue;
        if (refId) {
          const resolved = resolveSnowflakeRelationship(refId, attrId, dimName, levelUniqueName, keyMap, refPathIdToKeyRefId, attrIdToDimName);
          if (resolved) {
            // The engine requires a relationship's to.level key to have the same column
            // count as its own join_columns. That holds when the enclosing level's key IS
            // the join key (e.g. a single-attribute level joining on its own one column),
            // but not when the level is keyed on something else entirely (e.g. a
            // composite-keyed bridge level hosting several unrelated single-column FKs as
            // secondary attributes) — there the containing level's key arity never matches
            // any individual FK's. Give the join its own single-purpose level, keyed by the
            // same columns the join itself uses, so the two arities always agree.
            if (resolved.fromColumns.length !== keyColumns.length) {
              const kaDef = attrDef.get(attrId);
              const ownLevelName = truncateUniqueName(safeName(kaDef?.name ?? attrId));
              if (!levelAttrMap.has(ownLevelName)) {
                levelAttrMap.set(ownLevelName, {
                  uniqueName: ownLevelName,
                  label: kaDef?.caption ?? kaDef?.name ?? ownLevelName,
                  dataset: resolved.fromDataset,
                  keyColumns: resolved.fromColumns,
                  nameColumn: resolved.fromColumns[resolved.fromColumns.length - 1],
                });
              }
              resolved.toLevel = ownLevelName;
            }
            if (!metaSnowflakeRelationships.some((r) => r.uniqueName === resolved.uniqueName)) {
              metaSnowflakeRelationships.push(resolved);
            }
          } else {
            metaSkippedCrossDimRefs.push({ dimName, attrId });
          }
          continue;
        }

        const kaDef = attrDef.get(attrId);
        if (!kaDef) continue;
        const kaKeyEntries = keyMap.get(kaDef.keyUuid) ?? [];
        const kaAuthEntry = pickAuthEntry(kaKeyEntries, datasetNameToPhysical);
        if (!kaAuthEntry) continue;
        const saKeyColumns = kaAuthEntry.columns;
        const saDataset = `${kaAuthEntry.datasetName}.dataset`;
        const saAttrRefEntry = attrMap.get(attrId);
        const saNameCol = saAttrRefEntry?.column ?? saKeyColumns[0];
        const saSortCol = resolveSortColumn(kaDef.sortKeyUuid, keyMap, kaAuthEntry.datasetName) ?? saNameCol;
        secondaryAttrs.push({
          uniqueName: truncateUniqueName(safeName(kaDef.name)),
          label: kaDef.caption ?? kaDef.name,
          dataset: saDataset,
          keyColumns: saKeyColumns,
          nameColumn: saNameCol,
          sortColumn: saSortCol,
          allowedCalcsForDma: kaDef.allowedCalcTypes,
          format: resolveFormat(kaDef.formatString, kaDef.namedFormat),
          // Matches the reference converter: is_hidden applies only to secondary attributes
          // (never the level's own primary attribute), from the keyed-attribute's own
          // <properties><visible>; is_unique_key applies to every keyed attribute, from its
          // key-ref's own unique flag — the same signal already used for level_attributes.
          isHidden: !kaDef.visible || undefined,
          isUniqueKey: kaAuthEntry.unique || undefined,
          folder: kaDef.folder,
          description: kaDef.description,
        });
      }

      // Metrical attributes: a schema-level plain <attribute-ref attribute-id="..."> (NOT
      // <keyed-attribute-ref>) links a measure defined once at schema level to this level —
      // these become the level's own `metrics:` array in SML rather than a cube's metric.
      const levelMetrics: MetricalAttrOut[] = [];
      for (const aref of arr(levelEl["attribute-ref"])) {
        const attrId = a(aref, "attribute-id");
        if (!attrId) continue;
        const maDef = metricalAttrDef.get(attrId);
        if (!maDef) continue;
        if (maDef.isQuantile || !maDef.aggregation) {
          metaSkippedMetricalQuantiles.push(maDef.name);
          continue;
        }
        const maAttrRefEntry = attrMap.get(attrId);
        const maKeyRefEntries = maDef.keyRefId ? keyMap.get(maDef.keyRefId) ?? [] : [];
        const maKeyRefAuthEntry = pickAuthEntry(maKeyRefEntries, datasetNameToPhysical);
        const column = maKeyRefAuthEntry?.columns[0] ?? maAttrRefEntry?.column;
        const datasetName = maKeyRefAuthEntry?.datasetName ?? maAttrRefEntry?.datasetName;
        if (!column || !datasetName) {
          metaSkippedMetricalUnresolved.push(maDef.name);
          continue;
        }
        levelMetrics.push({
          uniqueName: truncateUniqueName(safeName(maDef.name)),
          label: maDef.caption ?? maDef.name,
          dataset: `${datasetName}.dataset`,
          column,
          calculationMethod: maDef.aggregation,
          format: resolveFormat(maDef.formatString, maDef.namedFormat),
          folder: maDef.folder,
          description: maDef.description,
          isHidden: !maDef.visible || undefined,
          unrelatedDimensionsHandling: maDef.unrelatedDimensionsHandling,
          isAggregatable: maDef.isAggregatable,
        });
      }

      // Visibility for a level (and its level_attributes entry) comes from the LEVEL's own
      // <properties><visible> only — the reference converter never lets the primary keyed-
      // attribute's own visibility hide the level (that flag only applies to secondary
      // attributes, see the secondaryAttrs.push above). Mixing the two meant a level whose
      // attribute happened to be marked invisible for unrelated reasons was hidden even
      // though the level itself was never marked hidden.
      const levelVisibleStr = (() => {
        const lProps = first(arr(levelEl.properties)) as Record<string, unknown> | undefined;
        return lProps ? s(first(arr(lProps.visible))) : undefined;
      })();
      const isHidden = levelVisibleStr === "false";

      const timeUnit = rawTimeUnits[levelIndex];

      // A degenerate level backed by more than one distinct fact dataset (e.g. a flag column
      // present on both a cube's primary fact table and its YTD fact table) needs
      // shared_degenerate_columns instead of a single dataset/key_columns/name_column —
      // one dataset alone (the common case) keeps the plain fields, unchanged from before,
      // UNLESS some other level in this same dimension does need the shared shape, in which
      // case this level must match it (see dimensionUsesSharedDegenerateFormat above) —
      // wrapped as a one-element array using this level's own single binding.
      const datasetBindings = isDegenerate ? degenerateBindingsForDim?.get(levelUniqueName) : undefined;
      const sharedDegenerateColumns =
        datasetBindings && datasetBindings.size > 1
          ? Array.from(datasetBindings, ([bindingDataset, bindingColumns]) => ({
              dataset: `${bindingDataset}.dataset`,
              keyColumns: bindingColumns,
              nameColumn: defaultNameColumn(bindingColumns, bindingDataset, soleKeyColumns, datasetNameToPhysical),
            }))
          : dimensionUsesSharedDegenerateFormat
          ? [{ dataset: datasetRef, keyColumns, nameColumn }]
          : undefined;

      // Build or merge the level attribute entry (de-duplicated by unique name)
      if (!levelAttrMap.has(levelUniqueName)) {
        levelAttrMap.set(levelUniqueName, {
          uniqueName: levelUniqueName,
          label: levelName,
          dataset: datasetRef,
          keyColumns,
          nameColumn,
          sortColumn,
          timeUnit,
          isHiddenFromUi: isHidden || undefined,
          isUniqueKey: isUniqueKey || undefined,
          folder: def.folder,
          description: def.description,
          format: resolveFormat(def.formatString, def.namedFormat),
          allowedCalcsForDma: def.allowedCalcTypes,
          sharedDegenerateColumns,
        });
      }

      const newSecondaryAttrs = secondaryAttrs.filter((sa) => {
        const key = `${levelUniqueName}::${sa.uniqueName}`;
        if (levelSecondaryAttrsEmitted.has(key)) return false;
        levelSecondaryAttrsEmitted.add(key);
        return true;
      });
      const newLevelMetrics = levelMetrics.filter((lm) => {
        const key = `${levelUniqueName}::${lm.uniqueName}`;
        if (levelMetricsEmitted.has(key)) return false;
        levelMetricsEmitted.add(key);
        return true;
      });

      // The engine disallows secondary attributes entirely on a level that uses
      // shared_degenerate_columns (multi-dataset) — report the drop as an omission rather
      // than silently emitting an invalid combination.
      if (sharedDegenerateColumns) {
        for (const sa of newSecondaryAttrs) {
          metaDroppedSecondaryAttrsForSharedDegenerate.push({ level: levelUniqueName, secondaryAttrName: sa.uniqueName });
        }
      }

      hierLevels.push({
        uniqueName: levelUniqueName,
        timeUnit,
        isHidden: isHidden || undefined,
        secondaryAttributes: !sharedDegenerateColumns && newSecondaryAttrs.length ? newSecondaryAttrs : undefined,
        metrics: newLevelMetrics.length ? newLevelMetrics : undefined,
      });
    }

    if (hierLevels.length > 0) {
      metaTotalLevels += hierLevels.length;
      // SML requires a time hierarchy's levels to run coarse-to-fine (each level's
      // time_unit no finer than the one above it) — the source XML's level order isn't
      // guaranteed to satisfy that, so reorder rather than emit an invalid hierarchy.
      const orderedLevels = isTime
        ? [...hierLevels].sort((a, b) => (TIME_UNIT_RANK[a.timeUnit ?? ""] ?? 99) - (TIME_UNIT_RANK[b.timeUnit ?? ""] ?? 99))
        : hierLevels;
      // Reuse collectAttributeDimensionOwnership's already-disambiguated unique_name for
      // this hierarchy id (see that function for why two hierarchies can otherwise
      // collide, e.g. "Region" vs "Region.") instead of re-deriving it
      // here, so this file and every perspective/aggregate that references this hierarchy
      // by id always agree on the same "_2"-suffixed name.
      const hierId = a(hierEl, "id");
      const hierUniqueName = (hierId && hierarchyIdToRef.get(hierId)?.hierUniqueName) || truncateUniqueName(safeName(hierName));
      hierarchies.push({
        uniqueName: hierUniqueName,
        label: hierCaption ?? hierName,
        filterEmpty,
        folder: hierFolder,
        description: hierDescription,
        defaultMember,
        levels: orderedLevels,
      });
    }
  }

  // A level shared by name across multiple hierarchies (e.g. "Category" common to three
  // different product hierarchies) must have an identical sequence of levels below it
  // everywhere it's used — the engine rejects a mismatch (e.g. one hierarchy going
  // straight from "Category" to a leaf level, skipping an intermediate "Sub Category"
  // that the others include) as "Level X is duplicated in hierarchies ... but levels below
  // it differ", even though the source XML genuinely models it that way. Disambiguate by
  // renaming every occurrence whose "below" shape doesn't match the first-seen shape for
  // that level name, cloning its level_attributes entry under the new name so it still
  // resolves to the same physical column.
  {
    const canonicalBelowSignature = new Map<string, string>();
    const renamedNameForSignature = new Map<string, string>();
    const nextSuffix = new Map<string, number>();
    for (const h of hierarchies) {
      for (let i = 0; i < h.levels.length; i++) {
        const level = h.levels[i];
        const originalName = level.uniqueName;
        const signature = h.levels
          .slice(i + 1)
          .map((l) => l.uniqueName)
          .join(">");
        const canonical = canonicalBelowSignature.get(originalName);
        if (canonical === undefined) {
          canonicalBelowSignature.set(originalName, signature);
          continue;
        }
        if (canonical === signature) continue;

        const dedupeKey = `${originalName} ${signature}`;
        let renamed = renamedNameForSignature.get(dedupeKey);
        if (!renamed) {
          const suffix = (nextSuffix.get(originalName) ?? 1) + 1;
          nextSuffix.set(originalName, suffix);
          renamed = truncateUniqueName(`${originalName}_${suffix}`);
          renamedNameForSignature.set(dedupeKey, renamed);
          const baseAttr = levelAttrMap.get(originalName);
          if (baseAttr && !levelAttrMap.has(renamed)) {
            levelAttrMap.set(renamed, { ...baseAttr, uniqueName: renamed });
          }
        }
        level.uniqueName = renamed;
      }
    }
  }

  // Build YAML structure
  const obj: Record<string, unknown> = {
    unique_name: dimName,
    object_type: "dimension",
    label,
  };

  if (dimDescription) obj.description = dimDescription;
  // type and is_degenerate are independent SML properties, not mutually exclusive — a
  // dimension bound directly to a fact table (degenerate) can still be time-typed (e.g. a
  // date/time column that only exists on the fact table itself, never joined to a separate
  // date dimension). The previous if/else-if chain here treated them as exclusive, silently
  // dropping type: time whenever is_degenerate was also true.
  if (isDegenerate) obj.is_degenerate = true;
  if (isTime) {
    obj.type = "time";
  } else if (!isDegenerate) {
    obj.type = "standard";
  }

  if (hierarchies.length > 0) {
    obj.hierarchies = hierarchies.map((h) => {
      const hierObj: Record<string, unknown> = {
        unique_name: h.uniqueName,
        label: h.label,
      };
      if (h.description) hierObj.description = h.description;
      if (h.filterEmpty) hierObj.filter_empty = h.filterEmpty;
      if (h.folder) hierObj.folder = h.folder;
      if (h.defaultMember) hierObj.default_member = h.defaultMember;
      hierObj.levels = h.levels.map((l) => {
        const lObj: Record<string, unknown> = { unique_name: l.uniqueName };
        if (l.isHidden) lObj.is_hidden = true;
        if (l.secondaryAttributes?.length) {
          lObj.secondary_attributes = l.secondaryAttributes.map((sa) => {
            const saObj: Record<string, unknown> = {
              unique_name: sa.uniqueName,
              label: sa.label,
              dataset: sa.dataset,
              key_columns: sa.keyColumns,
              name_column: sa.nameColumn,
            };
            // Emit whenever the XML declared an explicit sort key (resolveSortColumn only
            // ever returns a value for one), even if it happens to equal name_column — the
            // SML spec requires sort_column be set on every dataset of a shared-degenerate-
            // columns level once it's set on any one of them, so suppressing a coincidental
            // match here can leave a sibling dataset's real override without a required peer.
            if (sa.sortColumn) saObj.sort_column = sa.sortColumn;
            if (sa.format) saObj.format = sa.format;
            if (sa.folder) saObj.folder = sa.folder;
            if (sa.description) saObj.description = sa.description;
            if (sa.allowedCalcsForDma?.length) {
              saObj.allowed_calcs_for_dma = sa.allowedCalcsForDma;
            }
            if (sa.isHidden) saObj.is_hidden = true;
            if (sa.isUniqueKey) saObj.is_unique_key = true;
            return saObj;
          });
        }
        if (l.metrics?.length) {
          lObj.metrics = l.metrics.map((m) => {
            const mObj: Record<string, unknown> = {
              unique_name: m.uniqueName,
              label: m.label,
              dataset: m.dataset,
              column: m.column,
              calculation_method: m.calculationMethod,
            };
            if (m.description) mObj.description = m.description;
            if (m.format) mObj.format = m.format;
            if (m.folder) mObj.folder = m.folder;
            if (m.isHidden) mObj.is_hidden = true;
            if (m.unrelatedDimensionsHandling) mObj.unrelated_dimensions_handling = m.unrelatedDimensionsHandling;
            if (m.isAggregatable === false) mObj.is_aggregatable = false;
            return mObj;
          });
        }
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
      };
      // shared_degenerate_columns and dataset/name_column/key_columns are mutually
      // exclusive per the SML spec — a level backed by more than one fact dataset uses the
      // former instead of the latter.
      if (la.sharedDegenerateColumns) {
        laObj.shared_degenerate_columns = la.sharedDegenerateColumns.map((sdc) => ({
          dataset: sdc.dataset,
          name_column: sdc.nameColumn,
          key_columns: sdc.keyColumns,
        }));
      } else {
        laObj.dataset = la.dataset;
        laObj.name_column = la.nameColumn;
        laObj.key_columns = la.keyColumns;
      }
      if (la.description) laObj.description = la.description;
      // See the matching comment on the secondary-attribute sort_column above — always
      // emit an explicit XML sort key, even if it coincidentally equals name_column.
      if (la.sortColumn) laObj.sort_column = la.sortColumn;
      if (la.timeUnit) laObj.time_unit = la.timeUnit;
      if (la.isUniqueKey) laObj.is_unique_key = true;
      if (la.folder) laObj.folder = la.folder;
      if (la.format) laObj.format = la.format;
      if (la.isHiddenFromUi) laObj.is_hidden = true;
      if (la.allowedCalcsForDma?.length) laObj.allowed_calcs_for_dma = la.allowedCalcsForDma;
      return laObj;
    });
  }

  if (metaSnowflakeRelationships.length > 0) {
    obj.relationships = metaSnowflakeRelationships.map((r) => ({
      unique_name: r.uniqueName,
      from: { dataset: r.fromDataset, join_columns: r.fromColumns },
      to: { dimension: r.toDimension, level: r.toLevel },
      type: "snowflake",
    }));
  }

  const meta: DimMeta = {
    type: isDegenerate ? "degenerate" : isTime ? "time" : "standard",
    hierarchyCount: hierarchies.length,
    levelCount: metaTotalLevels,
    hasDefaultMembers: metaHasDefaultMembers,
    skippedCrossDimRefs: metaSkippedCrossDimRefs,
    skippedMetricalQuantiles: metaSkippedMetricalQuantiles,
    skippedMetricalUnresolved: metaSkippedMetricalUnresolved,
    snowflakeRelationships: metaSnowflakeRelationships,
    droppedSecondaryAttrsForSharedDegenerate: metaDroppedSecondaryAttrsForSharedDegenerate,
  };

  return { yaml: toYaml(obj), meta };
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
  description?: string,
  unrelatedDimensionsHandling?: string,
  isAggregatable?: boolean,
  semiAdditive?: {
    position: string;
    relationships?: string[];
    degenerateDimensions?: Array<{ name: string; level: string }>;
  },
): string {
  const obj: Record<string, unknown> = {
    unique_name: uniqueName,
    object_type: "metric",
    label,
    calculation_method: calculationMethod,
  };
  // Matches the field order production deployments use: semi_additive sits between
  // calculation_method and dataset/column.
  if (semiAdditive) {
    const semiAdditiveObj: Record<string, unknown> = { position: semiAdditive.position };
    if (semiAdditive.relationships?.length) semiAdditiveObj.relationships = semiAdditive.relationships;
    if (semiAdditive.degenerateDimensions?.length) {
      semiAdditiveObj.degenerate_dimensions = semiAdditive.degenerateDimensions;
    }
    obj.semi_additive = semiAdditiveObj;
  }
  obj.dataset = `${factDatasetName}.dataset`;
  obj.column = column;
  if (description) obj.description = description;
  if (format) obj.format = format;
  if (folder) obj.folder = folder;
  if (!visible) obj.is_hidden = true;
  if (unrelatedDimensionsHandling) obj.unrelated_dimensions_handling = unrelatedDimensionsHandling;
  if (isAggregatable === false) obj.is_aggregatable = false;
  return toYaml(obj);
}

/** Percentile metric — the SML equivalent of an AtScale quantile-group/quantile-instance pair. */
function buildPercentileMetricYaml(
  uniqueName: string,
  label: string,
  factDatasetName: string,
  column: string,
  compression: number | undefined,
  quantileVal: number,
  format?: string,
  folder?: string,
  visible = true,
  description?: string,
): string {
  const obj: Record<string, unknown> = {
    unique_name: uniqueName,
    object_type: "metric",
    label,
    calculation_method: "percentile",
    dataset: `${factDatasetName}.dataset`,
    column,
  };
  if (compression !== undefined) obj.compression = compression;
  if (quantileVal === 0.5) {
    obj.named_quantiles = "median";
  } else {
    obj.custom_quantiles = [quantileVal];
  }
  if (description) obj.description = description;
  if (format) obj.format = format;
  if (folder) obj.folder = folder;
  if (!visible) obj.is_hidden = true;
  return toYaml(obj);
}

/**
 * Emit a schema-level calculated member as a `metric_calc` YAML object.
 * These live in /calculations/ and use `expression:` rather than `formula:`.
 */
function buildCalcMemberYaml(
  uniqueName: string,
  label: string,
  expression: string,
  format?: string,
  folder?: string,
  visible = true,
  description?: string,
  mdxAggregateFunction?: string,
  dimension?: string,
): string {
  const obj: Record<string, unknown> = {
    unique_name: uniqueName,
    object_type: "metric_calc",
    label,
    expression,
  };
  if (description) obj.description = description;
  if (format) obj.format = format;
  if (folder) obj.folder = folder;
  if (!visible) obj.is_hidden = true;
  if (mdxAggregateFunction) obj.mdx_aggregate_function = mdxAggregateFunction;
  if (dimension) obj.dimension = dimension;
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
  const description = props ? s(first(arr(props.description))) : undefined;
  const visibleStr = props ? s(first(arr(props.visible))) : undefined;
  const visible = visibleStr !== "false";
  const fmtEl = props ? (first(arr(props.formatting)) as Record<string, unknown> | undefined) : undefined;
  const formatString = fmtEl ? s(first(arr(fmtEl["format-string"]))) : undefined;
  const namedFormat = fmtEl ? s(first(arr(fmtEl["named-format"]))) : undefined;
  const exprRaw = s(first(arr(cm.expression)));
  if (!exprRaw) return undefined;
  // <mdx-aggregate-function> and the dimension="..." XML attribute (defaults to "Measures"
  // per the XSD) live directly on <calculated-member>, not under <properties>.
  const mdxAggregateFunctionRaw = s(first(arr(cm["mdx-aggregate-function"])));
  const mdxAggregateFunction = mdxAggregateFunctionRaw ? mdxAggregateFunctionRaw.toUpperCase() : undefined;
  const dimension = a(cm, "dimension") ?? "Measures";
  return {
    name,
    caption,
    folder,
    description,
    visible,
    formatString,
    namedFormat,
    expression: unescapeHtml(exprRaw),
    mdxAggregateFunction,
    dimension,
  };
}

// ============================================================
// Phase 5: Relationship inference
// ============================================================

interface CubeKeyRole {
  columns: string[];
  rolePlay?: string;
  complete: string;
  datasetName: string;
}

interface CubeLevelMatch {
  matchId: string;
  toLevel: string;
  dimKeyUuid?: string;
}

/**
 * Scan every level of every hierarchy in a dimension for matches against the cube's
 * key-refs — a dimension can have multiple hierarchies (e.g. a date dimension with
 * separate Calendar/Reporting/Custom hierarchies) each needing their own relationship
 * to the same fact-table FK, so this returns ALL matches, not just the first.
 * Two distinct matching mechanisms exist in the source XML:
 *   - Role-played FKs (e.g. "Order Date" / "Ship Date" both pointing at the same Date
 *     Dimension level): the cube's <key-ref><ref-path><new-ref attribute-id="..."> value
 *     equals the level's own `primary-attribute` id directly.
 *   - Plain FKs / degenerate attributes: matched via the keyed-attribute's own
 *     `key-ref="..."` XML attribute (def.keyUuid), same as before.
 * Each match's `matchId` is what to look up in cubeKeyRoles; `dimKeyUuid` is the
 * dimension's own canonical key, used separately to resolve which dataset backs it —
 * these differ for role-played matches, where matchId is cube-local.
 */
function findCubeMatchingLevels(
  dimEl: Record<string, unknown>,
  attrDef: Map<string, AttrDefEntry>,
  cubeKeyRoles: Map<string, CubeKeyRole[]>,
  /** Every keyed-attribute id's already-disambiguated level unique_name, computed once by
   *  collectAttributeDimensionOwnership — see buildDimensionYaml's own parameter of the same
   *  name for why this must be looked up rather than re-derived with levelUniqueNameFor. */
  primaryAttrIdToLevelRef: Map<string, { dimName: string; hierUniqueName: string; levelUniqueName: string }>,
): CubeLevelMatch[] {
  const matches: CubeLevelMatch[] = [];
  for (const hierEl of arr(dimEl.hierarchy)) {
    for (const levelEl of arr(hierEl.level)) {
      const pa = a(levelEl, "primary-attribute");
      if (!pa) continue;
      const def = attrDef.get(pa);
      // toLevel must match the level's actual emitted unique_name (buildDimensionYaml
      // truncates it — see truncateUniqueName there) so relationships[].to.level,
      // semi_additive.degenerate_dimensions[].level, and the shared-degenerate-bindings
      // lookup key all agree with what the dimension file itself uses; otherwise a level
      // with a name over 63 chars silently fails every one of those lookups.
      const toLevel = primaryAttrIdToLevelRef.get(pa)?.levelUniqueName ?? levelUniqueNameFor(def?.name ?? pa);
      // These two checks are independent, not either/or: the source XML commonly declares
      // BOTH a plain key-ref and one or more role-played key-refs sharing the same outer
      // <key-ref id> for one dimension level (e.g. a role-played FK alongside the plain/
      // canonical FK to the same lookup table). Checking only the role-play match and
      // stopping there would silently drop the plain relationship for that level.
      if (cubeKeyRoles.has(pa)) {
        matches.push({ matchId: pa, toLevel, dimKeyUuid: def?.keyUuid });
      }
      if (def?.keyUuid && def.keyUuid !== pa && cubeKeyRoles.has(def.keyUuid)) {
        matches.push({ matchId: def.keyUuid, toLevel, dimKeyUuid: def.keyUuid });
      }
    }
  }
  return matches;
}

/** One fact dataset's binding for a degenerate dimension's level — the raw material for
 *  either a plain level_attributes dataset/key_columns pair (one binding) or a
 *  shared_degenerate_columns array (multiple distinct fact datasets for the same level). */
interface DegenerateBinding {
  dimName: string;
  toLevel: string;
  dataset: string;
  keyColumns: string[];
}

/** A single (dimension, level, fact-dataset) binding found in one cube — the common raw
 *  material both the cross-cube eligibility pre-pass and inferRelationships itself need. */
interface DimensionBinding {
  dimName: string;
  toLevel: string;
  role: CubeKeyRole;
  dimDataset: string | undefined;
  isSelfReferencing: boolean;
}

/** This cube's inline dimensions plus schema-level shared dimensions referenced via
 *  dimension-ref — the set of dimensions relevant to inferring this cube's relationships. */
function buildRelevantDims(
  cube: Record<string, unknown>,
  schemaDims: Map<string, Record<string, unknown>>,
  dimIdToName: Map<string, string>,
): Map<string, Record<string, unknown>> {
  const cubeLevelDims = new Map<string, Record<string, unknown>>();
  for (const dimsSec of arr(cube.dimensions)) {
    for (const dim of arr(dimsSec.dimension)) {
      // Resolved once, globally, when allDims was built — reuse that same (possibly
      // disambiguated) name rather than re-deriving the raw XML name here, or this cube's
      // own dimension could resolve to a name a *different* cube's same-named-but-distinct
      // dimension already claimed.
      const id = a(dim, "id");
      const name = id ? dimIdToName.get(id) : a(dim, "name");
      if (name) cubeLevelDims.set(name, dim as Record<string, unknown>);
    }
  }
  // Schema-level dims referenced via dimension-ref
  for (const dimsSec of arr(cube.dimensions)) {
    for (const dimRef of arr(dimsSec["dimension-ref"])) {
      const refId = a(dimRef, "id");
      if (!refId) continue;
      for (const [dname, del] of schemaDims) {
        if (a(del, "id") === refId) {
          cubeLevelDims.set(dname, del);
          break;
        }
      }
    }
  }
  return new Map([...schemaDims, ...cubeLevelDims]);
}

/**
 * For one cube, find every (dimension, level, fact-dataset) binding — the raw material
 * inferRelationships uses to decide relationships vs. degenerate treatment, and that the
 * cross-cube eligibility pre-pass (computeEligibleDegenerateDimensions) uses to check SML's
 * shared-degenerate constraints before any cube commits to either treatment.
 */
function gatherDimensionBindings(
  cubeEl: Record<string, unknown>,
  keyMap: Map<string, KeyRefEntry[]>,
  attrDef: Map<string, AttrDefEntry>,
  relevantDims: Map<string, Record<string, unknown>>,
  datasetIdToName: Map<string, string>,
  /** Passed straight through to findCubeMatchingLevels — see its own parameter of the same
   *  name for why the level's unique_name must be looked up here, not re-derived. */
  primaryAttrIdToLevelRef: Map<string, { dimName: string; hierUniqueName: string; levelUniqueName: string }>,
): DimensionBinding[] {
  // Build the set of ids that appear in this cube's data-set-ref logical sections, mapped to
  // every distinct role that id represents. Role-played FKs (e.g. "Order Date" and "Ship
  // Date" both pointing at the same Date Dimension level) share the same outer <key-ref id>
  // but have different <ref-path><new-ref attribute-id="..."> values — that attribute-id
  // equals the dimension level's own primary-attribute id, so it's used as the map key
  // instead of the (colliding) outer id. The same outer id can also appear, unchanged, in
  // MULTIPLE <data-set-ref> blocks of a multi-fact cube (e.g. a "query" fact and a "sub-
  // query" fact both keying against the same dimension under different column names) — so
  // each data-set-ref's own dataset name is tracked per role, not assumed to be the cube's
  // single factDatasetName, and every distinct (dataset, columns) pair is kept as a separate
  // role rather than the last one silently overwriting the others.
  const cubeKeyRoles = new Map<string, CubeKeyRole[]>();
  for (const dsSec of arr(cubeEl["data-sets"])) {
    for (const dsRef of arr(dsSec["data-set-ref"])) {
      const refId = a(dsRef, "id");
      const dsDatasetName = refId ? (datasetIdToName.get(refId) ?? refId) : undefined;
      if (!dsDatasetName) continue;

      for (const logSec of arr(dsRef.logical)) {
        for (const kr of arr(logSec["key-ref"])) {
          const id = a(kr, "id");
          if (!id) continue;
          const cols = extractColumns(arr(kr.column));
          if (cols.length === 0) continue;
          const complete = a(kr, "complete") ?? "true";

          const refPathEl = first(arr(kr["ref-path"])) as Record<string, unknown> | undefined;
          const newRefEl = refPathEl
            ? (first(arr(refPathEl["new-ref"])) as Record<string, unknown> | undefined)
            : undefined;
          const roleAttrId = newRefEl ? a(newRefEl, "attribute-id") : undefined;
          const rolePlay = newRefEl ? s(first(arr(newRefEl["ref-naming"]))) : undefined;
          const matchId = roleAttrId ?? id;

          const roles = cubeKeyRoles.get(matchId) ?? [];
          const colKey = `${dsDatasetName}|${cols.join(",")}`;
          const existingIdx = roles.findIndex((r) => `${r.datasetName}|${r.columns.join(",")}` === colKey);
          if (existingIdx === -1) {
            roles.push({ columns: cols, rolePlay, complete, datasetName: dsDatasetName });
          } else if (complete === "false") {
            // Prefer the explicit-FK (complete=false) version of the same column set
            roles[existingIdx] = { columns: cols, rolePlay, complete, datasetName: dsDatasetName };
          }
          cubeKeyRoles.set(matchId, roles);
        }
      }
    }
  }

  const bindings: DimensionBinding[] = [];
  for (const [dimName, dimEl] of relevantDims) {
    // Find every level (across every hierarchy) of this dimension matching the cube's
    // key-refs — a dimension can have multiple hierarchies each needing their own
    // relationship to the same fact-table FK (e.g. a date dimension's Calendar/Reporting/
    // Custom hierarchies all role-played as both "Order Date" and "Ship Date").
    const matches = findCubeMatchingLevels(dimEl, attrDef, cubeKeyRoles, primaryAttrIdToLevelRef);
    if (matches.length === 0) continue; // Dimension not used by this cube

    for (const { matchId, toLevel, dimKeyUuid } of matches) {
      const roles = cubeKeyRoles.get(matchId) ?? [];
      const dimKeyEntries = dimKeyUuid ? keyMap.get(dimKeyUuid) ?? [] : [];
      // Dimension dataset: the complete=true side of the dimension's own key (the lookup
      // table) — distinct from matchId, which may be a cube-local role-play identifier.
      const dimTrueEntry = dimKeyEntries.find((e) => e.complete === "true");
      const dimDataset = dimTrueEntry?.datasetName;
      // When a complete=true entry exists somewhere, it's the dimension's one real lookup
      // table, and every OTHER entry under the same key-ref id is just a foreign-key
      // reference from a fact table TO that table — a genuine relationship, not degenerate,
      // no matter what its own completeness marker says. Only when NO complete=true entry
      // exists anywhere for this key (this schema uses "false" and "partial" for values
      // other than "true", not just a plain complete/incomplete binary) does the dimension
      // have no separate physical home at all, so every fact dataset registered under this
      // key hosts the data directly and self-referencing must be checked against all of them
      // — otherwise a role landing on a "partial"-only key silently reads as a real
      // relationship and produces a spurious self-join.
      const selfReferencingDatasets = dimTrueEntry
        ? new Set([dimTrueEntry.datasetName])
        : new Set(dimKeyEntries.map((e) => e.datasetName));
      for (const role of roles) {
        bindings.push({ dimName, toLevel, role, dimDataset, isSelfReferencing: selfReferencingDatasets.has(role.datasetName) });
      }
    }
  }
  return bindings;
}

/**
 * Determines which dimensions may validly use SML's shared-degenerate mechanism, checked
 * globally across every cube before any single cube commits to relationships vs. degenerate
 * treatment. A per-cube decision can't see a dimension's bindings in OTHER cubes, but SML's
 * own constraints can only be verified with the full picture:
 *   - Every level of a shared degenerate dimension must be backed by the exact same set of
 *     fact datasets (a dimension with one level on two fact tables and another level on only
 *     one can't be modeled this way at all — Design Center rejects the mix outright).
 *   - For a level spanning multiple fact datasets, every dataset's key/name column must have
 *     the same physical data type (two fact tables computing "the same" degenerate column
 *     with different declared types, e.g. one raw and one CAST to a different type, can't be
 *     reconciled by the converter — this is a source-schema inconsistency to flag, not fix).
 * A dimension failing either constraint falls back to ordinary relationships entirely, the
 * same as if this feature didn't exist for it — exactly its pre-existing behavior.
 */
function computeEligibleDegenerateDimensions(
  cubeEls: Record<string, unknown>[],
  schemaDims: Map<string, Record<string, unknown>>,
  keyMap: Map<string, KeyRefEntry[]>,
  attrDef: Map<string, AttrDefEntry>,
  datasetIdToName: Map<string, string>,
  datasetNameToPhysical: Map<string, DatasetPhysical>,
  dimIdToName: Map<string, string>,
  /** Passed straight through to gatherDimensionBindings — see its own parameter of the same
   *  name for why the level's unique_name must be looked up here, not re-derived. */
  primaryAttrIdToLevelRef: Map<string, { dimName: string; hierUniqueName: string; levelUniqueName: string }>,
): { eligible: Set<string>; rejected: Array<{ dimName: string; reason: string }> } {
  const byDim = new Map<string, DimensionBinding[]>();
  for (const cube of cubeEls) {
    const factDatasetName = getFactDatasetName(cube, datasetIdToName);
    if (!factDatasetName) continue;
    const relevantDims = buildRelevantDims(cube, schemaDims, dimIdToName);
    for (const b of gatherDimensionBindings(cube, keyMap, attrDef, relevantDims, datasetIdToName, primaryAttrIdToLevelRef)) {
      const list = byDim.get(b.dimName) ?? [];
      list.push(b);
      byDim.set(b.dimName, list);
    }
  }

  const eligible = new Set<string>();
  const rejected: Array<{ dimName: string; reason: string }> = [];

  for (const [dimName, bindings] of byDim) {
    if (!bindings.some((b) => b.isSelfReferencing)) continue; // never degenerate — leave as relationships

    // A name shared across cubes can resolve to genuinely different underlying attributes —
    // e.g. one cube's "Shared Dim Name" hosted on a real snowflake dataset (a normal
    // relationship) while another cube's own same-named dimension is degenerate on its fact
    // table directly. Mixing the two into one shared_degenerate_columns array would silently
    // fold a real relationship's dataset in as if it were just another fact table, discarding
    // whatever transformation (e.g. an UPPER() case-normalization) made it a separate lookup
    // table in the first place. Same rule the rest of this file already applies globally: a
    // real relationship anywhere wins over degenerate treatment for that name everywhere.
    if (bindings.some((b) => !b.isSelfReferencing)) {
      rejected.push({
        dimName,
        reason: "Some of its bindings are a genuine relationship to a separate dataset while others are degenerate directly on a fact table — these are very likely different underlying attributes that happen to share this display name across cubes, so it was left as ordinary relationships instead of risking an incorrect merge.",
      });
      continue;
    }

    // shared_degenerate_columns is declared per level_attribute in SML, not once for the
    // whole dimension (see dimension.md) — there's no requirement that every level share the
    // identical set of fact datasets. A level backed by only one of the cube's fact tables
    // (e.g. an hour-of-day column only present on the primary fact, while year/month/quarter
    // are computed on every fact table bound to the cube) simply keeps the plain
    // dataset/key_columns fields for that level; buildDimensionYaml already emits
    // shared_degenerate_columns only for the levels that actually need it (datasetBindings
    // size > 1). Rejecting the whole dimension over this per-level variation produced invalid
    // output the live engine flagged as "should be degenerative" — degenerate was correct.
    const byLevel = new Map<string, Map<string, string[]>>();
    for (const b of bindings) {
      const byDataset = byLevel.get(b.toLevel) ?? new Map<string, string[]>();
      byDataset.set(b.role.datasetName, b.role.columns);
      byLevel.set(b.toLevel, byDataset);
    }

    let typeMismatch: string | undefined;
    for (const byDataset of byLevel.values()) {
      if (byDataset.size <= 1) continue;
      const types = new Map<string, string>();
      for (const [dsName, cols] of byDataset) {
        for (const col of cols) {
          types.set(`${dsName}.${col}`, datasetNameToPhysical.get(dsName)?.columns?.find((c) => c.name === col)?.dataType ?? "unknown");
        }
      }
      if (new Set(types.values()).size > 1) {
        typeMismatch = Array.from(types, ([k, v]) => `${k}: ${v}`).join(", ");
        break;
      }
    }
    if (typeMismatch) {
      rejected.push({
        dimName,
        reason: `Degenerate on more than one fact table, but the underlying columns have inconsistent data types across those tables (${typeMismatch}) — SML requires them to match, so this dimension was left as ordinary relationships instead.`,
      });
      continue;
    }

    eligible.add(dimName);
  }

  return { eligible, rejected };
}

function inferRelationships(
  cubeEl: Record<string, unknown>,
  factDatasetName: string | undefined,
  keyMap: Map<string, KeyRefEntry[]>,
  attrDef: Map<string, AttrDefEntry>,
  relevantDims: Map<string, Record<string, unknown>>,
  datasetIdToName: Map<string, string>,
  eligibleDegenerateDimNames: Set<string>,
  /** Passed straight through to gatherDimensionBindings — see its own parameter of the same
   *  name for why the level's unique_name must be looked up here, not re-derived. */
  primaryAttrIdToLevelRef: Map<string, { dimName: string; hierUniqueName: string; levelUniqueName: string }>,
): { relationships: RelationshipDef[]; degenerateDimNames: string[]; degenerateBindings: DegenerateBinding[] } {
  if (!factDatasetName) return { relationships: [], degenerateDimNames: [], degenerateBindings: [] };

  const byDim = new Map<string, DimensionBinding[]>();
  for (const b of gatherDimensionBindings(cubeEl, keyMap, attrDef, relevantDims, datasetIdToName, primaryAttrIdToLevelRef)) {
    const list = byDim.get(b.dimName) ?? [];
    list.push(b);
    byDim.set(b.dimName, list);
  }

  const relationships: RelationshipDef[] = [];
  const degenerateDimNames: string[] = [];
  const degenerateBindings: DegenerateBinding[] = [];
  const seen = new Set<string>();
  const usedNames = new Set<string>();

  for (const [dimName, bindings] of byDim) {
    // Whether this dimension is degenerate is decided once, globally, by
    // computeEligibleDegenerateDimensions — not re-derived per cube — so a dimension's
    // relationships:/dimensions: placement can never disagree with its own dimension file's
    // is_degenerate flag, and every cube treats the same dimension the same way.
    if (eligibleDegenerateDimNames.has(dimName)) {
      degenerateDimNames.push(dimName);
      for (const { toLevel, role } of bindings) {
        degenerateBindings.push({ dimName, toLevel, dataset: role.datasetName, keyColumns: role.columns });
      }
      continue;
    }

    for (const { toLevel, role, dimDataset } of bindings) {
      const relKey = `${dimName}|${toLevel}|${role.datasetName}|${role.columns.join(",")}`;
      if (seen.has(relKey)) continue;
      seen.add(relKey);

      const baseName = `${safeName(role.datasetName)}_to_${safeName(dimName)}_${safeName(role.columns.join("_"))}`;
      let relUniqueName = baseName;
      let suffix = 1;
      while (usedNames.has(relUniqueName)) {
        relUniqueName = `${baseName}_${++suffix}`;
      }
      usedNames.add(relUniqueName);

      relationships.push({
        uniqueName: relUniqueName,
        fromDataset: role.datasetName,
        fromColumns: role.columns,
        toDimension: dimName,
        toLevel,
        rolePlay: role.rolePlay,
        dimensionDataset: dimDataset,
      });
    }
  }

  return { relationships, degenerateDimNames, degenerateBindings };
}

// ============================================================
// Phase 6: Catalog, connection, model YAML
// ============================================================

function buildCatalogYaml(
  catalogName: string,
  /** Per-dataset aggregate-eligibility overrides (unique_name → flags), from each XML
   * <data-set>'s <properties> — see the `dataset_properties` property in the SML reference. */
  datasetProperties?: Map<string, Record<string, boolean>>,
): string {
  const obj: Record<string, unknown> = {
    unique_name: `${catalogName}.catalog`,
    object_type: "catalog",
    label: catalogName,
    version: 1.5,
    aggressive_agg_promotion: false,
    build_speculative_aggs: false,
  };
  if (datasetProperties?.size) {
    obj.dataset_properties = Object.fromEntries(datasetProperties);
  }
  return toYaml(obj);
}

function buildConnectionYaml(
  connName: string,
  connType?: string,
  db?: string,
  schema?: string,
  /** The base AtScale-registered connection this one is a db/schema variant of, if any. */
  asConnection?: string,
): string {
  const obj: Record<string, unknown> = {
    unique_name: connName,
    object_type: "connection",
    label: connName,
    as_connection: asConnection ?? connName,
  };
  if (connType) obj.connection_type = connType;
  if (db) obj.database = db;
  if (schema) obj.schema = schema;
  return toYaml(obj);
}

function buildModelYaml(
  modelName: string,
  relationships: RelationshipDef[],
  dimNames: string[],
  metricNames: Array<{ uniqueName: string; folder?: string }>,
  aggregates: AggregateDef[] = [],
  perspectives: PerspectiveDef[] = [],
  isHidden = false,
  includeDefaultDrillthrough = false,
): string {
  const obj: Record<string, unknown> = {
    unique_name: modelName,
    object_type: "model",
    label: modelName,
  };

  // Models use visible (default true), not is_hidden — a different property
  // from every other SML object type that carries a hidden flag.
  if (isHidden) obj.visible = false;
  if (includeDefaultDrillthrough) obj.include_default_drillthrough = true;

  obj.relationships = relationships.map((r) => {
    const relObj: Record<string, unknown> = {
      unique_name: r.uniqueName,
      from: {
        dataset: `${r.fromDataset}.dataset`,
        join_columns: r.fromColumns,
      },
      to: {
        dimension: r.toDimension,
        level: r.toLevel,
      },
    };
    if (r.rolePlay) relObj.role_play = r.rolePlay;
    return relObj;
  });

  if (dimNames.length > 0) {
    obj.dimensions = dimNames;
  }

  if (metricNames.length > 0) {
    // A cube can declare the same measure/calculated-member twice with an identical dedup
    // signature (e.g. two <attribute> elements that differ only in an inert property) — the
    // "already emitted, just reference it again" branches above correctly reuse the single
    // metrics/*.yml file but still append to this cube's own metricNames list once per
    // declaration, not once per unique_name. Dedup here (case-insensitive, matching this
    // file's own dedupKey convention) so the model's metrics: list can't contain the same
    // unique_name twice.
    const seenMetricUniqueNames = new Set<string>();
    const dedupedMetricNames = metricNames.filter((m) => {
      const key = m.uniqueName.toLowerCase();
      if (seenMetricUniqueNames.has(key)) return false;
      seenMetricUniqueNames.add(key);
      return true;
    });
    obj.metrics = dedupedMetricNames.map((m) => {
      const mObj: Record<string, unknown> = { unique_name: m.uniqueName };
      if (m.folder) mObj.folder = m.folder;
      return mObj;
    });
  }

  if (aggregates.length > 0) {
    obj.aggregates = aggregates.map((agg) => {
      const aggObj: Record<string, unknown> = {
        unique_name: agg.uniqueName,
        label: agg.label,
      };
      if (agg.attributes.length > 0) {
        aggObj.attributes = agg.attributes.map((attr) => {
          const attrObj: Record<string, unknown> = { name: attr.name, dimension: attr.dimension };
          if (attr.relationshipsPath?.length) attrObj.relationships_path = attr.relationshipsPath;
          return attrObj;
        });
      }
      if (agg.metrics.length > 0) aggObj.metrics = agg.metrics;
      if (agg.caching) aggObj.caching = agg.caching;
      return aggObj;
    });
  }

  // Every perspective the schema declared for this cube is emitted, even one whose
  // hide-list ends up empty — either because it was genuinely defined empty (nothing to
  // hide is a legitimate perspective, not an error) or because every referenced object
  // was unresolvable (already reported as its own "Perspective" omission where this is
  // built). Either way the perspective itself still exists and must keep its identity in
  // the model file rather than vanishing without a trace.
  const perspectiveObjs = perspectives.map((p) => {
    const pObj: Record<string, unknown> = { unique_name: p.uniqueName, label: p.label };
    if (p.hiddenMetrics.length > 0) pObj.metrics = p.hiddenMetrics;
    const dimensionObjs = [...p.hiddenDimensions.entries()].map(([dimName, hidden]) => {
      const dimObj: Record<string, unknown> = { name: dimName };
      if (hidden.wholeDimensionHidden) return dimObj;
      if (hidden.hiddenHierarchies.size > 0) {
        dimObj.hierarchies = [...hidden.hiddenHierarchies.entries()].map(([hierName, level]) => {
          const hierObj: Record<string, unknown> = { name: hierName };
          if (level) hierObj.level = level;
          return hierObj;
        });
      }
      if (hidden.hiddenSecondaryAttributes.size > 0) {
        dimObj.secondary_attributes = [...hidden.hiddenSecondaryAttributes];
      }
      return dimObj;
    });
    if (dimensionObjs.length > 0) pObj.dimensions = dimensionObjs;
    return pObj;
  });
  if (perspectiveObjs.length > 0) obj.perspectives = perspectiveObjs;

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

// ============================================================
// Mermaid schema diagram
// ============================================================

/**
 * Sanitize a name to a valid Mermaid erDiagram entity identifier.
 * Entity names must start with a letter; only A-Z, 0-9, and _ are safe.
 */
function mermaidEnt(name: string): string {
  let id = name.toUpperCase().replace(/[^A-Z0-9]/g, "_").replace(/__+/g, "_").replace(/^_+|_+$/g, "");
  // Mermaid entity names must start with a letter
  if (/^[0-9]/.test(id)) id = "T_" + id;
  return id || "ENTITY";
}

/**
 * Build a Mermaid erDiagram code block showing fact datasets,
 * dimensions, and the join relationships between them.
 */
function buildMermaidDiagram(models: ModelRecord[], dimensions: DimRecord[]): string {
  const dimByName = new Map<string, DimRecord>();
  for (const d of dimensions) dimByName.set(d.name, d);

  // Collect all unique fact datasets and their join columns across all models
  const factColumns = new Map<string, Set<string>>(); // mermaid-entity-name → join cols
  // Collect all unique dimension entities used in any relationship
  const dimEntities = new Map<string, string>(); // mermaid-entity-name → original dim name
  // Relationship lines (deduped)
  const relLines: string[] = [];
  const seenRels = new Set<string>();

  for (const model of models) {
    for (const rel of model.relationships) {
      const factEnt = mermaidEnt(rel.fromDataset);
      const dimEnt  = mermaidEnt(rel.toDimension);

      if (!factColumns.has(factEnt)) factColumns.set(factEnt, new Set());
      for (const col of rel.fromColumns) factColumns.get(factEnt)!.add(col);

      if (!dimEntities.has(dimEnt)) dimEntities.set(dimEnt, rel.toDimension);

      const label   = (rel.rolePlay ?? rel.fromColumns.join(", ")).replace(/"/g, "'");
      const relKey  = `${factEnt}|${dimEnt}|${label}`;
      if (!seenRels.has(relKey)) {
        seenRels.add(relKey);
        relLines.push(`    ${factEnt} }o--|| ${dimEnt} : "${label}"`);
      }
    }
  }

  if (relLines.length === 0) return "";

  const lines: string[] = ["```mermaid", "erDiagram"];

  // Emit fact entities with their join columns (cap at 10)
  const MAX_COLS = 10;
  for (const [factEnt, cols] of factColumns) {
    const colArr = [...cols];
    lines.push(`    ${factEnt} {`);
    for (const col of colArr.slice(0, MAX_COLS)) {
      const colId = col.toUpperCase().replace(/[^A-Z0-9]/g, "_").replace(/^_+|_+$/g, "") || "COL";
      lines.push(`        string ${colId}`);
    }
    if (colArr.length > MAX_COLS) {
      lines.push(`        string etc "...${colArr.length - MAX_COLS} more"`);
    }
    lines.push("    }");
  }

  // Emit dimension entities with type and level count
  for (const [dimEnt, dimName] of dimEntities) {
    const dim = dimByName.get(dimName);
    lines.push(`    ${dimEnt} {`);
    lines.push(`        string dim_type "${dim?.type ?? "standard"}"`);
    lines.push(`        int level_count "${dim?.levelCount ?? 0}"`);
    lines.push("    }");
  }

  // Emit relationships
  lines.push(...relLines);

  lines.push("```");
  return lines.join("\n");
}

// ============================================================
// README.md generation
// ============================================================

function buildReadme(
  catalogName: string,
  connectionName: string,
  xmlFileName: string | undefined,
  datasets: DatasetRecord[],
  dimensions: DimRecord[],
  metrics: MetricRecord[],
  models: ModelRecord[],
  omissions: OmissionRecord[],
  unboundByCube: CubeBindingRecord[] = [],
  truncatedNames: TruncatedNameRecord[] = [],
): string {
  const date = new Date().toISOString().split("T")[0];
  const measures      = metrics.filter((m) => m.metricType === "measure");
  const calcMeasures  = metrics.filter((m) => m.metricType === "calculated_measure");
  const calcMembers   = metrics.filter((m) => m.metricType === "calculated_member");
  const structural    = omissions.filter((o) => o.category === "Structural");
  const itemLevel     = omissions.filter((o) => o.category !== "Structural");

  const lines: string[] = [];

  // ── Title ──
  lines.push(`# SML Conversion Report: ${catalogName}`, "");
  lines.push(`**Source:** \`${xmlFileName ?? "unknown"}\`  `);
  lines.push(`**Generated:** ${date}  `);
  lines.push(`**Connection:** \`${connectionName}\``, "");

  // ── Schema diagram ──
  const diagram = buildMermaidDiagram(models, dimensions);
  if (diagram) {
    lines.push("## Schema Diagram", "");
    lines.push(diagram, "");
    lines.push("---", "");
  }

  // ── TOC ──
  lines.push("## Table of Contents", "");
  lines.push("- [Summary](#summary)");
  lines.push("- [Successful Conversions](#successful-conversions)");
  lines.push("  - [Catalog and Connection](#catalog-and-connection)");
  lines.push(`  - [Datasets (${datasets.length})](#datasets)`);
  lines.push(`  - [Dimensions (${dimensions.length})](#dimensions)`);
  lines.push(`  - [Metrics and Calculations (${metrics.length})](#metrics-and-calculations)`);
  lines.push(`  - [Models (${models.length})](#models)`);
  if (models.some((m) => m.dimensionDatasets.length > 0)) {
    lines.push("  - [Model Dataset Dependencies](#model-dataset-dependencies)");
  }
  lines.push("- [Omissions and Recommendations](#omissions-and-recommendations)");
  if (unboundByCube.length > 0)   lines.push("  - [Unbound Datasets](#unbound-datasets)");
  if (structural.length > 0)      lines.push("  - [Structural Omissions](#structural-omissions)");
  if (itemLevel.length > 0)       lines.push("  - [Item-Level Omissions](#item-level-omissions)");
  if (truncatedNames.length > 0)  lines.push("  - [Truncated Identifiers](#truncated-identifiers)");
  lines.push("", "---", "");

  // ── Summary ──
  const unboundCount = datasets.filter((d) => d.isUnbound).length;
  lines.push("## Summary", "");
  lines.push("| Category | Count |");
  lines.push("|----------|-------|");
  lines.push(`| Datasets | ${datasets.length} |`);
  if (unboundCount > 0) lines.push(`| ⚠ Unbound Datasets | ${unboundCount} |`);
  lines.push(`| Dimensions | ${dimensions.length} |`);
  lines.push(`| Measures | ${measures.length} |`);
  lines.push(`| Calculated Measures | ${calcMeasures.length} |`);
  lines.push(`| Calculated Members | ${calcMembers.length} |`);
  lines.push(`| Models | ${models.length} |`);
  const aggregateTotal = models.reduce((sum, m) => sum + m.aggregateCount, 0);
  if (aggregateTotal > 0) lines.push(`| User Defined Aggregates | ${aggregateTotal} |`);
  lines.push(`| Omissions | ${omissions.length} |`);
  if (truncatedNames.length > 0) lines.push(`| Truncated Identifiers | ${truncatedNames.length} |`);
  lines.push("", "---", "");

  // ── Successful Conversions ──
  lines.push("## Successful Conversions", "");

  // Catalog & Connection
  lines.push("### Catalog and Connection", "");
  lines.push("| File | Object |");
  lines.push("|------|--------|");
  lines.push(`| \`catalog.yml\` | Catalog: **${catalogName}** |`);
  lines.push(`| \`connections/${safeFilename(connectionName)}.yml\` | Connection: **${connectionName}** |`);
  lines.push("");

  // Datasets
  lines.push("### Datasets", "");
  if (datasets.length === 0) {
    lines.push("_No datasets were converted._", "");
  } else {
    lines.push("| Dataset | File | Type | Columns | Notes |");
    lines.push("|---------|------|------|---------|-------|");
    for (const ds of datasets) {
      const noteParts: string[] = [];
      if (ds.isImmutable) noteParts.push("immutable");
      if (ds.isUnbound)   noteParts.push("⚠ no physical binding");
      const cols = ds.columnCount > 0 ? String(ds.columnCount) : "—";
      lines.push(`| ${ds.name} | \`${ds.file}\` | ${ds.type} | ${cols} | ${noteParts.join(", ")} |`);
    }
    lines.push("");
  }

  // Dimensions
  lines.push("### Dimensions", "");
  if (dimensions.length === 0) {
    lines.push("_No dimensions were converted._", "");
  } else {
    lines.push("| Dimension | File | Type | Hierarchies | Levels | Default Member |");
    lines.push("|-----------|------|------|-------------|--------|----------------|");
    for (const dim of dimensions) {
      const dm = dim.hasDefaultMembers ? "yes" : "—";
      lines.push(`| ${dim.name} | \`${dim.file}\` | ${dim.type} | ${dim.hierarchyCount} | ${dim.levelCount} | ${dm} |`);
    }
    lines.push("");
  }

  // Metrics
  lines.push("### Metrics and Calculations", "");
  if (metrics.length === 0) {
    lines.push("_No metrics were converted._", "");
  } else {
    lines.push("| Metric | Label | File | Type | Aggregation | Folder |");
    lines.push("|--------|-------|------|------|-------------|--------|");
    for (const m of metrics) {
      const agg    = m.aggregation ?? "—";
      const folder = m.folder ?? "—";
      const hidden = m.isHidden ? " *(hidden)*" : "";
      lines.push(`| \`${m.name}\` | ${m.label}${hidden} | \`${m.file}\` | ${m.metricType.replace("_", " ")} | ${agg} | ${folder} |`);
    }
    lines.push("");
  }

  // Models
  lines.push("### Models", "");
  if (models.length === 0) {
    lines.push("_No models were converted._", "");
  } else {
    const hasAggregates = models.some((m) => m.aggregateCount > 0);
    const aggHeader = hasAggregates ? " Aggregates |" : "";
    const aggSep = hasAggregates ? "-----------|" : "";
    lines.push(`| Model | File | Relationships | Dimensions | Metrics |${aggHeader} Notes |`);
    lines.push(`|-------|------|---------------|------------|---------|${aggSep}-------|`);
    for (const m of models) {
      const notes: string[] = [];
      if (m.isHidden) notes.push("hidden");
      if (m.hasDefaultDrillthrough) notes.push("drillthrough");
      const aggCell = hasAggregates ? ` ${m.aggregateCount} |` : "";
      lines.push(`| ${m.name} | \`${m.file}\` | ${m.relationshipCount} | ${m.dimensionCount} | ${m.metricCount} |${aggCell} ${notes.join(", ")} |`);
    }
    lines.push("");
  }

  // Model dataset dependencies table
  const modelsWithDimDs = models.filter((m) => m.dimensionDatasets.length > 0);
  if (modelsWithDimDs.length > 0) {
    lines.push("### Model Dataset Dependencies", "");
    lines.push(
      "Each model requires both its directly-bound fact tables (cube `data-set-ref`s) and the " +
      "dimension datasets that back its join dimensions. Both sets of tables must exist in the " +
      "warehouse and be accessible via the connection.", "");
    lines.push("| Model | Fact Tables | Dimension Tables |");
    lines.push("|-------|-------------|------------------|");
    for (const m of modelsWithDimDs) {
      const factStr = m.factDatasets.length > 0 ? m.factDatasets.join(", ") : "—";
      const dimStr  = m.dimensionDatasets.join(", ");
      lines.push(`| **${m.name}** | ${factStr} | ${dimStr} |`);
    }
    lines.push("");
  }

  lines.push("---", "");

  // ── Omissions ──
  lines.push("## Omissions and Recommendations", "");

  if (omissions.length === 0 && unboundByCube.length === 0 && truncatedNames.length === 0) {
    lines.push("✅ No omissions detected.", "");
    lines.push("---");
    return lines.join("\n");
  }

  // ── Unbound datasets ──
  if (unboundByCube.length > 0) {
    lines.push("### Unbound Datasets", "");
    lines.push(
      "The following models reference datasets that have no physical table or SQL binding " +
      "in the source XML. Placeholder YAML was emitted but **these models will not execute** " +
      "until every listed dataset is bound to a real database table.", "");
    lines.push("| Model | Currently Bound | Needs Binding |");
    lines.push("|-------|-----------------|---------------|");
    for (const rec of unboundByCube) {
      const bound   = rec.boundDatasets.length  > 0 ? rec.boundDatasets.join(", ")   : "—";
      const unbound = rec.unboundDatasets.join(", ");
      lines.push(`| **${rec.cubeName}** | ${bound} | ${unbound} |`);
    }
    lines.push("");
  }

  if (structural.length > 0) {
    lines.push("### Structural Omissions", "");
    lines.push("The following XML features have no direct SML equivalent and were not converted:", "");
    lines.push("| Feature | Reason | Recommendation |");
    lines.push("|---------|--------|----------------|");
    for (const o of structural) {
      lines.push(`| **${o.item}** | ${o.reason} | ${o.recommendation} |`);
    }
    lines.push("");
  }

  if (itemLevel.length > 0) {
    lines.push("### Item-Level Omissions", "");
    lines.push("| Category | Item | Reason | Recommendation |");
    lines.push("|----------|------|--------|----------------|");
    for (const o of itemLevel) {
      lines.push(`| ${o.category} | \`${o.item}\` | ${o.reason} | ${o.recommendation} |`);
    }
    lines.push("");
  }

  if (truncatedNames.length > 0) {
    lines.push("### Truncated Identifiers", "");
    lines.push(
      "The following source names exceed SML's 63-character `unique_name` limit and were " +
      "shortened with an interior hash fragment (kept in the middle of the name, not the end, " +
      "so both the original head and tail stay legible). The original full name is recorded " +
      "here so it never has to be recovered by decoding the hash.", "");
    lines.push("| Category | Original Name | Emitted `unique_name` |");
    lines.push("|----------|----------------|------------------------|");
    for (const t of truncatedNames) {
      lines.push(`| ${t.category} | \`${t.original}\` | \`${t.truncated}\` |`);
    }
    lines.push("");
  }

  lines.push("---");
  return lines.join("\n");
}
