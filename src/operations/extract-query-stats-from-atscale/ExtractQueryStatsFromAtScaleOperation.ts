/**
 * Extract query usage statistics from AtScale.
 *
 * For a given time window, paginates through the AtScale query history REST API
 * and tallies how many user queries involved each (dimension-attribute, measure)
 * pair.  The result is written as a CSV occurrence matrix — one row per pair,
 * one column per count — that mirrors the heatmap produced by the
 * query_histogram_updated.ipynb notebook.
 *
 * Optionally generates a month-by-month breakdown CSV for a full calendar year.
 */
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import axios from "axios";
import { Parser } from "xml2js";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Parameter set
// ---------------------------------------------------------------------------

class ExtractQueryStatsParameterSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name = "connection-file";
      description = "Path to the connections YAML file";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "connection-name";
      description = "Connection name within the connections file";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "model";
      description = "AtScale model (cube) name to analyse";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "output-dir";
      description = "Directory to write the output CSV files";
      required = false;
      defaultValue = ".";
    })(),
    new (class extends StringParameter {
      name = "window-days";
      description = "Number of days to look back when no explicit start/end date is given";
      required = false;
      defaultValue = "30";
    })(),
    new (class extends StringParameter {
      name = "start-date";
      description = "Explicit window start (ISO-8601, e.g. 2025-01-01T00:00:00Z). Overrides --window-days.";
      required = false;
    })(),
    new (class extends StringParameter {
      name = "end-date";
      description = "Explicit window end (ISO-8601). Defaults to now when --start-date is given.";
      required = false;
    })(),
    new (class extends StringParameter {
      name = "monthly";
      description = "When 'true', also generates a month-by-month breakdown CSV for --monthly-year";
      required = false;
      defaultValue = "false";
    })(),
    new (class extends StringParameter {
      name = "monthly-year";
      description = "Calendar year (e.g. 2025) for the monthly breakdown. Defaults to the current year.";
      required = false;
    })(),
    new (class extends StringParameter {
      name = "limit";
      description = "Page size for the query history API";
      required = false;
      defaultValue = "100";
    })(),
    new (class extends StringParameter {
      name = "num-queries";
      description = "Maximum number of sample query IDs to retain per (attribute, measure) pair";
      required = false;
      defaultValue = "10";
    })(),
  ];
}

type Params = {
  "connection-file": string;
  "connection-name": string;
  model: string;
  "output-dir": string;
  "window-days": string;
  "start-date"?: string;
  "end-date"?: string;
  monthly: string;
  "monthly-year"?: string;
  limit: string;
  "num-queries": string;
};
export type ExtractQueryStatsFromAtScaleParams = Params;

// Map key for an (attribute | null, measure | null) pair.
type PairKey = string;

function pairKey(attribute: string | null, measure: string | null): PairKey {
  return JSON.stringify([attribute, measure]);
}

function parsePairKey(key: PairKey): [string | null, string | null] {
  return JSON.parse(key) as [string | null, string | null];
}

// ---------------------------------------------------------------------------
// Operation
// ---------------------------------------------------------------------------

export class ExtractQueryStatsFromAtScaleOperation extends Operation<Params> {
  name = "extract-query-stats-from-atscale";
  description =
    "Analyse AtScale query history and output a CSV occurrence matrix of (dimension attribute × measure) query pairs";
  parameters = new ExtractQueryStatsParameterSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  private async getToken(
    installer: boolean,
    atscaleUrl: string,
    organizationId: string,
    username: string,
    password: string,
    proxyConfig: Record<string, any>
  ): Promise<string> {
    const config: Record<string, any> = {}
    if (Object.keys(proxyConfig).length != 0) {
      config.proxy = proxyConfig
    }
    if (installer) {
      const url = `${atscaleUrl}:10500/${organizationId}/auth`;
      this.logger.verbose("Auth URL: " + url);

      config.auth = { username, password };
      const response = await axios.get(url, config);
      return response.data as string;
    } else {
      const url = `${atscaleUrl}/auth/realms/atscale/protocol/openid-connect/token`;
      this.logger.verbose(`Auth URL: ${url}`);
      const params = new URLSearchParams();
      params.append("client_id", "atscale-ai-link");
      params.append("grant_type", "password");
      params.append("username", username);
      params.append("password", password);
      const response = await axios.post(url, params);
      return response.data.access_token as string;
    }
  }

  // -------------------------------------------------------------------------
  // XMLA / DMV helpers
  // -------------------------------------------------------------------------

  private async getDmvData(
    token: string,
    installer: boolean,
    atscaleUrl: string,
    statement: string,
    organizationId: string,
    catalogName: string,
    modelName: string,
    proxyConfig: Record<string, any>
  ): Promise<Record<string, string>[]> {
    const data = `<?xml version="1.0" encoding="UTF-8"?>
    <Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">
        <Body>
            <Execute xmlns="urn:schemas-microsoft-com:xml-analysis">
                <Command><Statement>${statement}</Statement></Command>
                <Properties>
                    <PropertyList><Catalog>${catalogName}</Catalog></PropertyList>
                </Properties>
                <Parameters>
                    <Parameter>
                        <Name>CubeName</Name>
                        <Value>${modelName}</Value>
                    </Parameter>
                </Parameters>
            </Execute>
        </Body>
    </Envelope>`;

    const xmlaUrl = installer
      ? `${atscaleUrl}:10502/xmla/${organizationId}`
      : `${atscaleUrl}/engine/xmla`;

    const config: Record<string, any> = {}
    if (Object.keys(proxyConfig).length != 0) {
      config.proxy = proxyConfig
    }
    config.headers = {
      'Content-Type': 'text/xml',
      'Authorization': `Bearer ${token}`
    }

    const response = await axios.post(xmlaUrl, data, config);

    const parser = new Parser({ explicitArray: false, ignoreAttrs: true });
    const result: any = await parser.parseStringPromise(response.data);

    try {
      const rows =
        result["soap:Envelope"]["soap:Body"]["ExecuteResponse"]["return"]["root"]["row"];
      return Array.isArray(rows) ? rows : [rows];
    } catch {
      return [];
    }
  }

  /** Returns the flat list of measure names for the cube. */
  private async getMeasureNames(
    token: string,
    installer: boolean,
    atscaleUrl: string,
    organizationId: string,
    catalogName: string,
    modelName: string,
    proxyConfig: Record<string, any>
  ): Promise<string[]> {
    const statement =
      "SELECT MEASURE_NAME FROM $system.MDSCHEMA_MEASURES WHERE [CUBE_NAME] = @CubeName";
    const rows = await this.getDmvData(
      token, installer, atscaleUrl, statement, organizationId, catalogName, modelName, proxyConfig
    );
    return rows.map((r) => r.MEASURE_NAME).filter(Boolean);
  }

  /** Returns the flat list of dimension level names for the cube (excluding Measures dim and All levels). */
  private async getAttributeNames(
    token: string,
    installer: boolean,
    atscaleUrl: string,
    organizationId: string,
    catalogName: string,
    modelName: string,
    proxyConfig: Record<string, any>
  ): Promise<string[]> {
    const rows = await this.getLevelMetadataRows(
      token, installer, atscaleUrl, organizationId, catalogName, modelName, proxyConfig
    );
    return rows.map((r) => r.LEVEL_NAME).filter(Boolean);
  }

  /**
   * Returns dimension/hierarchy/level metadata for every non-All, non-Measures
   * level in the cube.  Used to build the metric-by-hierarchy CSV.
   */
  private async getLevelMetadataRows(
    token: string,
    installer: boolean,
    atscaleUrl: string,
    organizationId: string,
    catalogName: string,
    modelName: string,
    proxyConfig: Record<string, any>
  ): Promise<Record<string, string>[]> {
    const statement =
      "SELECT DIMENSION_UNIQUE_NAME, HIERARCHY_UNIQUE_NAME, LEVEL_NAME " +
      "FROM $system.MDSCHEMA_LEVELS WHERE [CUBE_NAME] = @CubeName " +
      "and [LEVEL_NAME] &lt;&gt; '(All)' and [DIMENSION_UNIQUE_NAME] &lt;&gt; '[Measures]'";
    return this.getDmvData(
      token, installer, atscaleUrl, statement, organizationId, catalogName, modelName, proxyConfig
    );
  }

  /** Strip MDX bracket notation, e.g. "[Customer].[Customer Hierarchy]" → "Customer Hierarchy". */
  private stripBrackets(s: string): string {
    // Take the last bracket-enclosed segment, or the whole string if no brackets.
    const match = s.match(/\[([^\]]+)\]$/);
    return match ? match[1] : s;
  }

  /** Returns AtScale internal GUIDs needed for the query history REST API. */
  private async getIds(
    token: string,
    installer: boolean,
    atscaleUrl: string,
    organizationId: string,
    catalogName: string,
    modelName: string,
    proxyConfig: Record<string, any>
  ): Promise<{ catalogId: string; modelId: string }> {
    const catalogStatement =
      `SELECT CATALOG_GUID FROM $system.DBSCHEMA_CATALOGS WHERE [CATALOG_NAME] = '${catalogName}'`;
    const catalogRows = await this.getDmvData(
      token, installer, atscaleUrl, catalogStatement, organizationId, catalogName, modelName, proxyConfig
    );
    const catalogId = catalogRows[0]?.CATALOG_GUID ?? "";

    const modelStatement =
      `SELECT CUBE_GUID FROM $system.MDSCHEMA_CUBES WHERE [CATALOG_NAME] = '${catalogName}' ` +
      `and [CUBE_NAME] = '${modelName}'`;
    const modelRows = await this.getDmvData(
      token, installer, atscaleUrl, modelStatement, organizationId, catalogName, modelName, proxyConfig
    );
    const modelId = modelRows[0]?.CUBE_GUID ?? "";

    return { catalogId, modelId };
  }

  // -------------------------------------------------------------------------
  // Query history pagination
  // -------------------------------------------------------------------------

  /**
   * Pages through the AtScale query history REST API for [startTime, endTime],
   * tallying how many successful user queries involved each
   * (dimension-attribute, measure) pair.
   *
   * Uses reservoir sampling so that at most `numQueries` representative query
   * IDs are kept per pair (matching the notebook's approach exactly).
   *
   * Returns:
   *   occurrenceDict  — Map<pairKey, count>
   *   sampleQueryIds  — Map<pairKey, Array<[queryId, allFields]>>
   */
  private async processQueries(
    installer: boolean,
    atscaleUrl: string,
    token: string,
    organizationId: string,
    catalogId: string,
    modelId: string,
    startTime: string,
    endTime: string,
    limit: number,
    numQueries: number,
    proxyConfig: Record<string, any>
  ): Promise<{
    occurrenceDict: Map<PairKey, number>;
    sampleQueryIds: Map<PairKey, Array<[string, string[]]>>;
  }> {
    const occurrenceDict = new Map<PairKey, number>();
    const sampleQueryIds = new Map<PairKey, Array<[string, string[]]>>();

    const config: Record<string, any> = {}
    if (Object.keys(proxyConfig).length != 0) {
      config.proxy = proxyConfig
    }
    config.headers = {
      'Content-Type': 'text/xml',
      'Authorization': `Bearer ${token}`
    }

    const baseUrl = installer
      ? `${atscaleUrl}:10502/queries/orgId/${organizationId}`
      : `${atscaleUrl}/engine/queries/orgId/${organizationId}`;

    let offset = 0;
    let done = false;

    while (!done) {
      const url =
        `${baseUrl}?querySource=user&status=success` +
        `&projectId=${catalogId}&cubeId=${modelId}` +
        `&queryDateTimeStart=${startTime}&queryDateTimeEnd=${endTime}` +
        `&offset=${offset}&limit=${limit}`;

      this.logger.verbose(`Fetching query page at offset ${offset}: ${url}`);
      const response = await axios.get(url, config);
      const data: any[] = response.data?.response?.data ?? [];

      for (const query of data) {
        const queryId: string = query.query_id ?? "";
        const rawAttrs: any[] | null | undefined = query.attributes;

        if (rawAttrs == null) continue;

        const measures: Array<string | null> = [];
        const attributes: Array<string | null> = [];

        for (const attr of rawAttrs) {
          if (attr["attribute-type"] === "measure") {
            measures.push(attr.name ?? null);
          } else if (attr["attribute-type"] === "dimension") {
            attributes.push(attr.name ?? null);
          }
        }

        if (attributes.length === 0) attributes.push(null);
        if (measures.length === 0) measures.push(null);

        const allFields = [
          ...measures.filter((x): x is string => x !== null),
          ...attributes.filter((x): x is string => x !== null),
        ];

        for (const attribute of attributes) {
          for (const measure of measures) {
            const key = pairKey(attribute, measure);
            const count = occurrenceDict.get(key) ?? 0;

            if (count === 0) {
              sampleQueryIds.set(key, [[queryId, allFields]]);
            } else if (count < numQueries) {
              sampleQueryIds.get(key)!.push([queryId, allFields]);
            } else if (Math.random() < 0.5) {
              const idx = Math.floor(Math.random() * numQueries);
              sampleQueryIds.get(key)![idx] = [queryId, allFields];
            }

            occurrenceDict.set(key, count + 1);
          }
        }
      }

      if (data.length < limit) {
        done = true;
      } else {
        offset += limit;
      }
    }

    this.logger.verbose(
      `Processed ${offset + limit} query records; found ${occurrenceDict.size} unique (attribute, measure) pairs`,
    );

    return { occurrenceDict, sampleQueryIds };
  }

  // -------------------------------------------------------------------------
  // CSV helpers
  // -------------------------------------------------------------------------

  /** Serialises a 2-D string array to CSV, quoting cells that contain commas or quotes. */
  private toCsv(rows: Array<Array<string | number | null>>): string {
    return rows
      .map((row) =>
        row
          .map((cell) => {
            const s = cell == null ? "" : String(cell);
            return s.includes(",") || s.includes('"') || s.includes("\n")
              ? `"${s.replace(/"/g, '""')}"`
              : s;
          })
          .join(","),
      )
      .join("\n") + "\n";
  }

  // -------------------------------------------------------------------------
  // Main run
  // -------------------------------------------------------------------------

  async run(params: Params): Promise<void> {
    const yaml = this.services.get<YamlService>("yaml");

    // --- Connection setup ---
    this.logger.info(`Reading connection file: ${params["connection-file"]}`);
    const connectionFile = yaml.readFromFile<any>(params["connection-file"]);
    const connection = connectionFile.connections[params["connection-name"]];
    if (!connection) {
      throw new Error(`Connection '${params["connection-name"]}' not found in ${params["connection-file"]}`);
    }
    if (!connection.mdx) {
      throw new Error(
        `Connection '${params["connection-name"]}' is missing an 'mdx:' block. ` +
        `Add mdx: { url, organization_id, catalog_name, user } to this connection in ${params["connection-file"]}.`
      );
    }

    const proxyConfig: Record<string, any> = {};
    if (connection.proxy.host) {
      proxyConfig.host = connection.proxy.host;
      if (connection.proxy.password) {
        proxyConfig.port = connection.proxy.port;
      }
      else {
        throw new Error(
          `Connection '${params["connection-name"]}' contains a proxy host but is missing the required port`,
        );
      }
      if (connection.proxy.protocol) {
        proxyConfig.protocol = connection.proxy.protocol;
      }
      if (connection.proxy.username) {
        proxyConfig.auth = {};
        proxyConfig.auth.username = connection.proxy.username;
        if (connection.proxy.password) {
          proxyConfig.password = connection.proxy.password;
        }
      }
    }

    const { installer, mdx } = connection;
    const { url: atscaleUrl, organization_id: organizationId, catalog_name: catalogName } = mdx;
    const user = (connectionFile.users ?? {})[mdx.user] ?? {};
    const modelName = params.model;

    // --- Auth ---
    this.logger.info("Authenticating…");
    const token = await this.getToken(
      installer, atscaleUrl, organizationId, user.username, user.password, proxyConfig
    );

    // --- Discover model schema ---
    this.logger.info("Fetching measure and attribute names from DMV…");
    const [measureNames, levelMetaRows, ids] = await Promise.all([
      this.getMeasureNames(token, installer, atscaleUrl, organizationId, catalogName, modelName, proxyConfig),
      this.getLevelMetadataRows(token, installer, atscaleUrl, organizationId, catalogName, modelName, proxyConfig),
      this.getIds(token, installer, atscaleUrl, organizationId, catalogName, modelName, proxyConfig),
    ]);
    const attributeNames = levelMetaRows.map((r) => r.LEVEL_NAME).filter(Boolean);

    // Map from level name → { dimension, hierarchy, level } for the new CSV.
    // When a level name appears in multiple hierarchies, all entries are kept.
    type LevelMeta = { dimension: string; hierarchy: string; level: string };
    const levelMetaByName = new Map<string, LevelMeta[]>();
    for (const row of levelMetaRows) {
      const levelName = row.LEVEL_NAME;
      if (!levelName) continue;
      const entry: LevelMeta = {
        dimension: this.stripBrackets(row.DIMENSION_UNIQUE_NAME ?? ""),
        hierarchy: this.stripBrackets(row.HIERARCHY_UNIQUE_NAME ?? ""),
        level: levelName,
      };
      const existing = levelMetaByName.get(levelName);
      if (existing) existing.push(entry);
      else levelMetaByName.set(levelName, [entry]);
    }

    this.logger.info(
      `Found ${measureNames.length} measure(s) and ${attributeNames.length} attribute level(s)`,
    );

    const { catalogId, modelId } = ids;
    if (!catalogId || !modelId) {
      throw new Error(
        `Could not resolve GUIDs for catalog '${catalogName}' / model '${modelName}'. ` +
        "Check that the catalog_name in connections.yaml matches the AtScale project name.",
      );
    }

    // --- Parse parameters ---
    const limit = Math.max(1, parseInt(params.limit, 10) || 100);
    const numQueries = Math.max(1, parseInt(params["num-queries"], 10) || 10);
    const doMonthly = params.monthly?.toLowerCase() === "true";
    const outputDir = path.resolve(params["output-dir"] ?? ".");
    fs.mkdirSync(outputDir, { recursive: true });

    const safeName = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePrefix = path.join(outputDir, `${safeName(catalogName)}_${safeName(modelName)}`);

    // -----------------------------------------------------------------------
    // Single-window CSV
    // -----------------------------------------------------------------------
    const now = new Date();

    let startTime: string;
    let endTime: string;

    if (params["start-date"]) {
      startTime = params["start-date"];
      endTime = params["end-date"] ?? now.toISOString().replace(/\.\d+Z$/, "Z");
    } else {
      const windowDays = Math.max(1, parseInt(params["window-days"], 10) || 30);
      const startDate = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
      startTime = startDate.toISOString().replace(/\.\d+Z$/, "Z");
      endTime = now.toISOString().replace(/\.\d+Z$/, "Z");
    }

    this.logger.info(`Collecting query stats from ${startTime} to ${endTime}…`);
    const { occurrenceDict } = await this.processQueries(
      installer, atscaleUrl, token, organizationId,
      catalogId, modelId, startTime, endTime, limit, numQueries, proxyConfig
    );

    // Build occurrence CSV: cross-product of attributes × measures
    const occurrenceRows: Array<Array<string | number | null>> = [
      ["attribute", "measure", "occurrences"],
    ];
    for (const attr of attributeNames) {
      for (const measure of measureNames) {
        const key = pairKey(attr, measure);
        occurrenceRows.push([attr, measure, occurrenceDict.get(key) ?? 0]);
      }
    }
    // Also include (null, measure) and (attribute, null) pairs seen in actual queries
    // that may not appear in the DMV lists (e.g. measure-only queries)
    for (const [key, count] of occurrenceDict) {
      const [attr, measure] = parsePairKey(key);
      const attrInList = attr === null || attributeNames.includes(attr);
      const measureInList = measure === null || measureNames.includes(measure);
      if (!attrInList || !measureInList) {
        occurrenceRows.push([attr ?? "(none)", measure ?? "(none)", count]);
      }
    }

    const occurrenceFile = `${filePrefix}_occurrences.csv`;
    fs.writeFileSync(occurrenceFile, this.toCsv(occurrenceRows), "utf8");
    this.logger.info(`Wrote occurrence matrix to ${occurrenceFile}`);

    // -----------------------------------------------------------------------
    // Metric-by-hierarchy CSV
    // Rows: dimension, hierarchy, level, metric, occurrences
    // One row per (dimension × hierarchy × level × metric) combination observed
    // in queries; zero-count combinations are omitted.
    // -----------------------------------------------------------------------

    // key: JSON.stringify([dimension, hierarchy, level, metric])
    const hierMetricCounts = new Map<string, number>();
    for (const [key, count] of occurrenceDict) {
      const [attr, measure] = parsePairKey(key);
      if (!attr || !measure) continue;  // skip attribute-only or measure-only rows
      const metas = levelMetaByName.get(attr);
      if (!metas) continue;
      for (const meta of metas) {
        const hKey = JSON.stringify([meta.dimension, meta.hierarchy, meta.level, measure]);
        hierMetricCounts.set(hKey, (hierMetricCounts.get(hKey) ?? 0) + count);
      }
    }

    const hierRows: Array<Array<string | number | null>> = [
      ["dimension", "hierarchy", "level", "metric", "occurrences"],
    ];
    // Sort by dimension → hierarchy → level → metric for readability
    const sortedHierKeys = Array.from(hierMetricCounts.keys()).sort();
    for (const hKey of sortedHierKeys) {
      const [dimension, hierarchy, level, metric] = JSON.parse(hKey) as string[];
      hierRows.push([dimension, hierarchy, level, metric, hierMetricCounts.get(hKey)!]);
    }

    const hierFile = `${filePrefix}_metric_by_hierarchy.csv`;
    fs.writeFileSync(hierFile, this.toCsv(hierRows), "utf8");
    this.logger.info(`Wrote metric-by-hierarchy breakdown to ${hierFile}`);

    // -----------------------------------------------------------------------
    // Pivot table CSV
    // Rows: metrics  |  Columns: "Hierarchy > Level"  |  Values: occurrences
    // -----------------------------------------------------------------------

    // Collect ordered unique column keys: "hierarchy > level", sorted for stability.
    const pivotColKeys = Array.from(
      new Set(
        sortedHierKeys.map((hKey) => {
          const [, hierarchy, level] = JSON.parse(hKey) as string[];
          return `${hierarchy} > ${level}`;
        }),
      ),
    ).sort();

    // Build lookup: "metric|hierarchy > level" → count
    const pivotLookup = new Map<string, number>();
    for (const hKey of sortedHierKeys) {
      const [, hierarchy, level, metric] = JSON.parse(hKey) as string[];
      const colKey = `${hierarchy} > ${level}`;
      pivotLookup.set(`${metric}|${colKey}`, hierMetricCounts.get(hKey)!);
    }

    // All metrics that appear in the pivot (sorted for stability).
    const pivotMetrics = Array.from(
      new Set(
        sortedHierKeys.map((hKey) => (JSON.parse(hKey) as string[])[3]),
      ),
    ).sort();

    const pivotRows: Array<Array<string | number | null>> = [
      ["metric", ...pivotColKeys],
    ];
    for (const metric of pivotMetrics) {
      const row: Array<string | number | null> = [metric];
      for (const colKey of pivotColKeys) {
        row.push(pivotLookup.get(`${metric}|${colKey}`) ?? 0);
      }
      pivotRows.push(row);
    }

    const pivotFile = `${filePrefix}_metric_pivot.csv`;
    fs.writeFileSync(pivotFile, this.toCsv(pivotRows), "utf8");
    this.logger.info(`Wrote metric pivot table to ${pivotFile}`);

    // -----------------------------------------------------------------------
    // Monthly breakdown CSV (optional)
    // -----------------------------------------------------------------------
    if (doMonthly) {
      const year = parseInt(params["monthly-year"] ?? String(now.getFullYear()), 10);
      this.logger.info(`Generating monthly breakdown for ${year}…`);

      const MONTHS = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
      ];

      // Header: attribute, measure, Jan, Feb, …, Dec, total
      const monthlyRows: Array<Array<string | number | null>> = [
        ["attribute", "measure", ...MONTHS, "total"],
      ];

      // Collect all 12 months' occurrence dicts
      const monthlyDicts: Map<PairKey, number>[] = [];
      for (let month = 0; month < 12; month++) {
        const monthStart = new Date(year, month, 1, 0, 0, 0);
        const monthEnd = new Date(year, month + 1, 1, 0, 0, 0);
        monthEnd.setSeconds(monthEnd.getSeconds() - 1);

        const mStart = monthStart.toISOString().replace(/\.\d+Z$/, "Z");
        const mEnd = monthEnd.toISOString().replace(/\.\d+Z$/, "Z");

        this.logger.info(`  ${MONTHS[month]} ${year}…`);
        const { occurrenceDict: mDict } = await this.processQueries(
          installer, atscaleUrl, token, organizationId,
          catalogId, modelId, mStart, mEnd, limit, numQueries, proxyConfig
        );
        monthlyDicts.push(mDict);
      }

      for (const attr of attributeNames) {
        for (const measure of measureNames) {
          const key = pairKey(attr, measure);
          const monthlyCounts = monthlyDicts.map((d) => d.get(key) ?? 0);
          const total = monthlyCounts.reduce((a, b) => a + b, 0);
          monthlyRows.push([attr, measure, ...monthlyCounts, total]);
        }
      }

      const monthlyFile = `${filePrefix}_monthly_occurrences.csv`;
      fs.writeFileSync(monthlyFile, this.toCsv(monthlyRows), "utf8");
      this.logger.info(`Wrote monthly breakdown to ${monthlyFile}`);
    }

    // Summary
    const totalQueries = Array.from(occurrenceDict.values()).reduce((a, b) => a + b, 0);
    const uniquePairs = occurrenceDict.size;
    this.logger.info(
      `Done — ${totalQueries} query occurrence(s) across ${uniquePairs} unique (attribute, measure) pair(s)`,
    );
  }
}
