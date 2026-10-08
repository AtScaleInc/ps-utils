/**
 * Reads the parts of a .pbix that matter for DAX gap analysis.
 *
 * A .pbix is a zip. What is in it depends on how the report connects:
 *
 *   - **Import / composite** reports carry a `DataModel` part. That is an
 *     XPress9-compressed Analysis Services backup, NOT a plain file, and cannot
 *     be read without Microsoft's tooling. This reader reports its presence and
 *     says so rather than pretending to parse it.
 *   - **Live connection** reports (the common case when pointing at SSAS or
 *     AtScale) have no `DataModel` at all -- the model lives on the server.
 *     Their report-scoped measures sit in `Report/Layout` under
 *     `config.modelExtensions`, in plain text. Those are exactly the
 *     client-side DAX expressions AtScale would have to evaluate.
 *
 * `Report/Layout` is UTF-16LE JSON with JSON-encoded strings nested inside it,
 * so it needs decoding and a second parse pass.
 */

import { readFile } from "node:fs/promises";
import JSZip from "jszip";

export type PbixMeasure = {
  /** Entity (table) the measure extends, as named in the report. */
  entity: string;
  name: string;
  expression: string;
  /** Model measures this report measure references, per Power BI's own index. */
  referencedModelMeasures: string[];
  hidden: boolean;
  formatString?: string;
};

export type PbixConnection = {
  name: string;
  connectionString: string;
  connectionType: string;
  /** Parsed from the connection string when present. */
  dataSource?: string;
  catalog?: string;
  cube?: string;
  /** daxdialect= parameter, when the connection sets one. */
  daxDialect?: string;
};

export type PbixReport = {
  fileName: string;
  /** True when the file carries an embedded model we cannot read. */
  hasEmbeddedDataModel: boolean;
  /** True when every connection is a live connection. */
  isLiveConnection: boolean;
  connections: PbixConnection[];
  measures: PbixMeasure[];
  /** Report page names, for context in the report. */
  pages: string[];
};

/** Decode a zip entry that may be UTF-16LE (Power BI's default) or UTF-8. */
function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString("utf16le");
  }
  // Power BI writes Report/Layout as UTF-16LE with no BOM.
  if (buf.length >= 2 && buf[1] === 0x00) return buf.toString("utf16le");
  return buf.toString("utf8").replace(/^\uFEFF/, "");
}

function parseConnectionString(cs: string): Partial<PbixConnection> {
  const out: Partial<PbixConnection> = {};
  for (const part of cs.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (key === "data source") out.dataSource = value;
    else if (key === "initial catalog") out.catalog = value;
    else if (key === "cube") out.cube = value;
  }
  const dialect = /[?&]daxdialect=([A-Za-z]+)/i.exec(cs);
  if (dialect) out.daxDialect = dialect[1].toLowerCase();
  return out;
}

async function entryText(zip: JSZip, name: string): Promise<string | undefined> {
  const file = zip.file(name);
  if (!file) return undefined;
  return decodeText(await file.async("nodebuffer"));
}

async function readConnections(zip: JSZip): Promise<PbixConnection[]> {
  const text = await entryText(zip, "Connections");
  if (text === undefined) return [];
  try {
    const parsed = JSON.parse(text) as {
      Connections?: Array<{ Name?: string; ConnectionString?: string; ConnectionType?: string }>;
    };
    return (parsed.Connections ?? []).map((c) => {
      const cs = c.ConnectionString ?? "";
      return {
        name: c.Name ?? "",
        connectionString: cs,
        connectionType: c.ConnectionType ?? "",
        ...parseConnectionString(cs),
      };
    });
  } catch {
    return [];
  }
}

type ModelExtension = {
  entities?: Array<{
    name?: string;
    measures?: Array<{
      name?: string;
      expression?: string;
      hidden?: boolean;
      formatInformation?: { formatString?: string };
      references?: { measures?: Array<{ name?: string }> };
    }>;
  }>;
};

async function readLayout(
  zip: JSZip,
): Promise<{ measures: PbixMeasure[]; pages: string[] }> {
  const text = await entryText(zip, "Report/Layout");
  if (text === undefined) return { measures: [], pages: [] };

  let layout: { config?: unknown; sections?: Array<{ displayName?: string; name?: string }> };
  try {
    layout = JSON.parse(text);
  } catch {
    return { measures: [], pages: [] };
  }

  const pages = (layout.sections ?? [])
    .map((s) => s.displayName ?? s.name ?? "")
    .filter(Boolean);

  // `config` is a JSON *string* nested inside the layout JSON.
  let config: { modelExtensions?: ModelExtension[] } = {};
  const raw = layout.config;
  if (typeof raw === "string") {
    try { config = JSON.parse(raw); } catch { config = {}; }
  } else if (raw && typeof raw === "object") {
    config = raw as { modelExtensions?: ModelExtension[] };
  }

  const measures: PbixMeasure[] = [];
  for (const ext of config.modelExtensions ?? []) {
    for (const entity of ext.entities ?? []) {
      for (const m of entity.measures ?? []) {
        if (!m.name) continue;
        measures.push({
          entity: entity.name ?? "",
          name: m.name,
          expression: (m.expression ?? "").trim(),
          referencedModelMeasures: (m.references?.measures ?? [])
            .map((r) => r.name ?? "")
            .filter(Boolean),
          hidden: Boolean(m.hidden),
          formatString: m.formatInformation?.formatString,
        });
      }
    }
  }
  return { measures, pages };
}

export async function readPbix(filePath: string, fileName: string): Promise<PbixReport> {
  return readPbixBuffer(await readFile(filePath), fileName);
}

/** Split out so tests can build a .pbix in memory. */
export async function readPbixBuffer(buffer: Buffer, fileName: string): Promise<PbixReport> {
  const zip = await JSZip.loadAsync(buffer);
  const names = new Set(Object.keys(zip.files));
  const connections = await readConnections(zip);
  const { measures, pages } = await readLayout(zip);

  return {
    fileName,
    hasEmbeddedDataModel: names.has("DataModel"),
    isLiveConnection:
      connections.length > 0 &&
      connections.every((c) => /Live$/i.test(c.connectionType)),
    connections,
    measures,
    pages,
  };
}
