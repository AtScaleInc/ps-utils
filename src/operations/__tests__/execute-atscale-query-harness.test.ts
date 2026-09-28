import { describe, expect, it } from "vitest";
import { summarizeXmlaResponse, xmlaConfigFromYaml, xmlaFaultMessage } from "../execute-atscale-query-harness/ExecuteAtScaleQueryHarnessOperation.js";

type Cell = { value: string; fmt?: string };

/** A container-host-shaped XMLA Execute response. */
function response(opts: {
  sessionId?: string;
  lastDataUpdate?: string;
  lastSchemaUpdate?: string;
  cells?: Cell[];
  member?: string;
} = {}): string {
  const {
    sessionId = "session-a",
    lastDataUpdate = "2026-09-28T20:32:12.962674780Z",
    lastSchemaUpdate = "2026-09-28T20:11:46.763286098Z",
    cells = [{ value: "100", fmt: "100.00" }],
    member = "[Product].[Product Hierarchy].[productkey].&[1]",
  } = opts;
  const engine = "http://schemas.microsoft.com/analysisservices/2003/engine";
  const cellXml = cells
    .map((c, i) =>
      `<Cell CellOrdinal="${i}"><Value xsi:type="xsd:double">${c.value}</Value>` +
      (c.fmt !== undefined ? `<FmtValue>${c.fmt}</FmtValue>` : "") +
      `</Cell>`)
    .join("");
  return [
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">`,
    `<soap:Header><Session xmlns="urn:schemas-microsoft-com:xml-analysis" SessionId="${sessionId}"/></soap:Header>`,
    `<soap:Body><ExecuteResponse xmlns="urn:schemas-microsoft-com:xml-analysis"><return>`,
    `<root xmlns="urn:schemas-microsoft-com:xml-analysis:mddataset">`,
    `<OlapInfo><CubeInfo><Cube><CubeName>envmgr_build_test</CubeName>`,
    `<LastDataUpdate xmlns="${engine}">${lastDataUpdate}</LastDataUpdate>`,
    `<LastSchemaUpdate xmlns="${engine}">${lastSchemaUpdate}</LastSchemaUpdate>`,
    `</Cube></CubeInfo></OlapInfo>`,
    `<Axes><Axis name="Axis0"><Tuples><Tuple><Member><UName>${member}</UName></Member></Tuple></Tuples></Axis></Axes>`,
    `<CellData>${cellXml}</CellData>`,
    `</root></return></ExecuteResponse></soap:Body></soap:Envelope>`,
  ].join("");
}

describe("summarizeXmlaResponse checksum", () => {
  it("ignores SessionId and LastDataUpdate / LastSchemaUpdate", () => {
    const a = summarizeXmlaResponse(response());
    const b = summarizeXmlaResponse(response({
      sessionId: "session-b",
      lastDataUpdate: "2026-09-28T21:00:00.000000000Z",
      lastSchemaUpdate: "2026-09-28T21:00:01.000000000Z",
    }));
    expect(a.checksum).not.toBe("");
    expect(b.checksum).toBe(a.checksum);
  });

  it("changes when a cell value changes", () => {
    const a = summarizeXmlaResponse(response());
    const b = summarizeXmlaResponse(response({ cells: [{ value: "101", fmt: "101.00" }] }));
    expect(b.checksum).not.toBe(a.checksum);
  });

  it("changes when an axis member changes", () => {
    const a = summarizeXmlaResponse(response());
    const b = summarizeXmlaResponse(response({ member: "[Product].[Product Hierarchy].[productkey].&[2]" }));
    expect(b.checksum).not.toBe(a.checksum);
  });

  it("is empty when there are no cells", () => {
    expect(summarizeXmlaResponse(response({ cells: [] })).checksum).toBe("");
  });
});

describe("summarizeXmlaResponse row count", () => {
  it("counts each cell once when cells carry both <Value> and <FmtValue>", () => {
    const body = response({ cells: [{ value: "1", fmt: "1.00" }, { value: "2", fmt: "2.00" }] });
    expect(summarizeXmlaResponse(body).rowCount).toBe(2);
  });

  it("counts namespace-prefixed <Value> elements", () => {
    const body = response({ cells: [{ value: "1" }] }).replace(/<(\/?)Value/g, "<$1x:Value");
    expect(summarizeXmlaResponse(body).rowCount).toBe(1);
  });
});

describe("xmlaFaultMessage", () => {
  it("returns the faultstring of a SOAP fault", () => {
    const body =
      `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
      `<soap:Fault><faultcode>soap:Server</faultcode>` +
      `<faultstring> Level \`[Product].[Product]\` not found </faultstring></soap:Fault>` +
      `</soap:Body></soap:Envelope>`;
    expect(xmlaFaultMessage(body)).toBe("Level `[Product].[Product]` not found");
  });

  it("returns empty for a normal result", () => {
    expect(xmlaFaultMessage(response())).toBe("");
  });
});

describe("xmlaConfigFromYaml container auth", () => {
  const file = (mdxUrl: string) => ({
    users: { u: { username: "user", password: "pw" } },
    connections: {
      c: { installer: false, mdx: { url: mdxUrl, user: "u", catalog_name: "cat" } },
    },
  });

  it("fetches a Keycloak token for a bare host URL", () => {
    const cfg = xmlaConfigFromYaml(file("https://host.example.com"), "c", "cube");
    expect(cfg.url).toBe("https://host.example.com/engine/xmla");
    expect(cfg.keycloakAuth).toBe(true);
    expect(cfg.authUrl).toBe("https://host.example.com/auth/realms/atscale/protocol/openid-connect/token");
  });

  it("does not double an /engine/xmla suffix", () => {
    const cfg = xmlaConfigFromYaml(file("https://host.example.com/engine/xmla"), "c", "cube");
    expect(cfg.url).toBe("https://host.example.com/engine/xmla");
    expect(cfg.keycloakAuth).toBe(true);
    expect(cfg.authUrl).toBe("https://host.example.com/auth/realms/atscale/protocol/openid-connect/token");
  });

  it("uses an XMLA token embedded in the URL as-is, with no token fetch", () => {
    const cfg = xmlaConfigFromYaml(file("https://host.example.com/engine/xmla/abc123"), "c", "cube");
    expect(cfg.url).toBe("https://host.example.com/engine/xmla/abc123");
    expect(cfg.keycloakAuth).toBe(false);
  });
});
