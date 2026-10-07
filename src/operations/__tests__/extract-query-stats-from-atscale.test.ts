import { describe, expect, it } from "vitest";
import {
  dmvStringLiteral,
  fetchAllQueryHistory,
  monthlyWindowsUtc,
  parseQuerySource,
  queryReceivedAt,
  reservoirOffer,
  resolveQueryStatsConnection,
  summarizeQueryRow,
  queryHistoryBaseUrl,
  queryHistoryPageUrl,
} from "../extract-query-stats-from-atscale/ExtractQueryStatsFromAtScaleOperation.js";

const filters = { catalogId: "cat-1", modelId: "cube-1", startTime: "2026-01-01T00:00:00Z", endTime: "2026-02-01T00:00:00Z" };

describe("query history URL", () => {
  it("uses /engine/queries with no orgId segment on container hosts", () => {
    const base = queryHistoryBaseUrl(false, "https://h", "default");
    expect(base).toBe("https://h/engine/queries");
    expect(queryHistoryPageUrl(base, filters, 0, 100)).toBe(
      "https://h/engine/queries?querySource=user&status=success&projectId=cat-1&cubeId=cube-1" +
      "&queryDateTimeStart=2026-01-01T00:00:00Z&queryDateTimeEnd=2026-02-01T00:00:00Z&offset=0&limit=100",
    );
  });

  it("keeps the org-scoped installer path", () => {
    expect(queryHistoryBaseUrl(true, "https://h", "default")).toBe("https://h:10502/queries/orgId/default");
  });
});

/** A stub engine: serves `total` rows, at most 101 per page, like PaginationSupport. */
function stubEngine(total: number) {
  const urls: string[] = [];
  const getPage = async (url: string) => {
    urls.push(url);
    const q = new URL(url).searchParams;
    const offset = Number(q.get("offset"));
    const limit = Math.min(Number(q.get("limit")), 101);
    const data = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => ({
      query_id: `q${offset + i}`,
    }));
    return { response: { data } };
  };
  return { urls, getPage };
}

describe("fetchAllQueryHistory", () => {
  it("fetches every page when --limit exceeds the engine's 101-row cap", async () => {
    const { urls, getPage } = stubEngine(350);
    const rows = await fetchAllQueryHistory(getPage, "https://h/engine/queries", filters, 500);
    expect(rows).toHaveLength(350);
    expect(new Set(rows.map((r) => r.query_id)).size).toBe(350);
    expect(urls.every((u) => u.endsWith("limit=100"))).toBe(true);
  });

  it("advances the offset by the rows actually returned", async () => {
    const { urls, getPage } = stubEngine(250);
    await fetchAllQueryHistory(getPage, "https://h/engine/queries", filters, 100);
    expect(urls.map((u) => new URL(u).searchParams.get("offset"))).toEqual(["0", "100", "200"]);
  });

  it("stops on an empty page when the total is a multiple of the page size", async () => {
    const { urls, getPage } = stubEngine(200);
    const rows = await fetchAllQueryHistory(getPage, "https://h/engine/queries", filters, 100);
    expect(rows).toHaveLength(200);
    expect(urls).toHaveLength(3);
  });
});

describe("monthlyWindowsUtc", () => {
  it("builds UTC calendar months, extending each end to catch queries finishing after midnight", () => {
    const w = monthlyWindowsUtc(2026);
    expect(w).toHaveLength(12);
    expect(w[0]).toEqual({
      start: "2026-01-01T00:00:00Z",
      end: "2026-02-02T00:00:00Z",
      receivedBefore: "2026-02-01T00:00:00Z",
    });
    expect(w[11].receivedBefore).toBe("2027-01-01T00:00:00Z");
    for (let i = 1; i < 12; i++) expect(w[i].start).toBe(w[i - 1].receivedBefore);
  });
});

describe("queryReceivedAt", () => {
  it("reads the QueryWallTime start", () => {
    expect(queryReceivedAt({ timeline_events: [
      { type: "QueryPlanning", started: "2026-01-31T23:59:59.9Z" },
      { type: "QueryWallTime", started: "2026-01-31T23:59:59.5Z" },
    ] })).toBe("2026-01-31T23:59:59.5Z");
    expect(queryReceivedAt({})).toBeUndefined();
  });
});

describe("resolveQueryStatsConnection", () => {
  it("accepts the standard container atscale: entry with no mdx block or organization_id", () => {
    const c = resolveQueryStatsConnection({ connections: { dev: {
      atscale: { url: "https://h/", username: "u", password: "p", insecure: true },
    } } }, "dev", "My Catalog");
    expect(c).toEqual({
      installer: false, atscaleUrl: "https://h", organizationId: undefined, catalogName: "My Catalog",
      username: "u", password: "p", insecure: true,
    });
  });

  it("still reads an mdx: block, stripping an /engine/xmla suffix", () => {
    const c = resolveQueryStatsConnection({
      users: { admin: { username: "u", password: "p" } },
      connections: { dev: { mdx: { url: "https://h/engine/xmla", user: "admin", catalog_name: "Cat" } } },
    }, "dev", undefined);
    expect(c).toMatchObject({ installer: false, atscaleUrl: "https://h", catalogName: "Cat", username: "u" });
  });

  it("requires organization_id only for installer connections", () => {
    const file = (installer: boolean) => ({ connections: { c: {
      installer, mdx: { url: "https://h", catalog_name: "Cat" },
    } } });
    expect(() => resolveQueryStatsConnection(file(false), "c", undefined)).not.toThrow();
    expect(() => resolveQueryStatsConnection(file(true), "c", undefined)).toThrow(/organization_id/);
  });

  it("requires a catalog name", () => {
    expect(() => resolveQueryStatsConnection({ connections: { c: { atscale: { url: "https://h" } } } }, "c", undefined))
      .toThrow(/--catalog/);
  });
});

describe("dmvStringLiteral", () => {
  it("doubles single quotes and XML-escapes the result", () => {
    expect(dmvStringLiteral("O'Brien & <Co>")).toBe("'O''Brien &amp; &lt;Co&gt;'");
  });
});

describe("reservoirOffer (Algorithm R)", () => {
  it("fills to capacity, then replaces slot j only when j < capacity", () => {
    const sample: number[] = [];
    for (let i = 0; i < 3; i++) reservoirOffer(sample, i, i, 3);
    expect(sample).toEqual([0, 1, 2]);
    // seen = 3: j = floor(r * 4); r = 0.9 -> j = 3 (>= capacity) -> kept out
    reservoirOffer(sample, 3, 3, 3, () => 0.9);
    expect(sample).toEqual([0, 1, 2]);
    // r = 0.3 -> j = 1 -> replaces slot 1
    reservoirOffer(sample, 4, 4, 3, () => 0.3);
    expect(sample).toEqual([0, 4, 2]);
  });

  it("keeps every item with roughly equal probability", () => {
    const hits = new Array(10).fill(0);
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let t = 0; t < 20000; t++) {
      const sample: number[] = [];
      for (let i = 0; i < 10; i++) reservoirOffer(sample, i, i, 3, rand);
      for (const x of sample) hits[x]++;
    }
    // Expected 20000 * 3/10 = 6000 each.
    for (const h of hits) expect(Math.abs(h - 6000)).toBeLessThan(400);
  });
});

describe("query-source", () => {
  it("filters on querySource for user / system and drops the filter for all", () => {
    const base = "https://h/engine/queries";
    expect(queryHistoryPageUrl(base, { ...filters, querySource: "system" }, 0, 100)).toContain("?querySource=system&status=success");
    expect(queryHistoryPageUrl(base, { ...filters, querySource: "all" }, 0, 100)).toMatch(/\?status=success&/);
    expect(queryHistoryPageUrl(base, filters, 0, 100)).toContain("?querySource=user&");
    expect(parseQuerySource(undefined)).toBe("user");
    expect(() => parseQuerySource("everyone")).toThrow(/user", "system" or "all/);
  });
});

describe("summarizeQueryRow", () => {
  const row = (opts: { children?: any[] | null; aggs?: string[]; succeeded?: boolean }) => ({
    query_id: "q1", user_id: "u1", cube_name: "cube", succeeded: opts.succeeded ?? true,
    aggregate_definition_ids: opts.aggs ?? [],
    timeline_events: [
      { type: "QueryWallTime", started: "2026-09-29T16:04:01.932869Z", duration: 0.126705, children: [] },
      ...(opts.children === null ? [] : [{ type: "SubqueriesWall", children: opts.children ?? [] }]),
    ],
  });
  const sq = (used_local_cache: boolean) => ({ used_local_cache, used_aggregate_cache: false });

  it("classifies a local-cache subquery as cache, even with an aggregate", () => {
    expect(summarizeQueryRow(row({ children: [sq(false), sq(true)], aggs: ["a"] })).class).toBe("cache");
  });

  it("classifies a successful query with no subquery as cache", () => {
    expect(summarizeQueryRow(row({ children: null })).class).toBe("cache");
    expect(summarizeQueryRow(row({ children: [] })).subquery_count).toBe(0);
  });

  it("classifies an aggregate hit as agg, and the rest as raw", () => {
    expect(summarizeQueryRow(row({ children: [sq(false)], aggs: ["a", "b"] }))).toMatchObject({ class: "agg", aggregate_count: 2 });
    expect(summarizeQueryRow(row({ children: [sq(false)] })).class).toBe("raw");
    expect(summarizeQueryRow(row({ children: [], succeeded: false })).class).toBe("raw");
  });

  it("reads received time and duration from QueryWallTime", () => {
    expect(summarizeQueryRow(row({ children: [sq(false)] }))).toMatchObject({
      query_id: "q1", received: "2026-09-29T16:04:01.932869Z", duration_ms: 126.705,
      user_id: "u1", cube_name: "cube", subquery_count: 1,
    });
  });
});
