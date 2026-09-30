import { describe, expect, it } from "vitest";
import {
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
