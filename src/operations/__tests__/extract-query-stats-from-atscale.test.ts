import { describe, expect, it } from "vitest";
import {
  fetchAllQueryHistory,
  monthlyWindowsUtc,
  queryReceivedAt,
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
