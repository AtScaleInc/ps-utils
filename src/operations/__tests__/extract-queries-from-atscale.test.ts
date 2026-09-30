import { describe, expect, it } from "vitest";
import {
  buildExtractionSql,
  rowToRecord,
} from "../extract-queries-from-atscale/ExtractQueriesFromAtScaleOperation.js";

const sql = buildExtractionSql("engine", "analysis", "O'Brien Cube", 30, 2);
const flat = sql.replace(/\s+/g, " ");

describe("buildExtractionSql", () => {
  it("reduces subqueries to one row per query before grouping by text", () => {
    expect(flat).toContain("WITH sub AS ( SELECT s.query_id, COUNT(*) AS subquery_count");
    expect(flat).toContain("GROUP BY s.query_id");
    expect(flat).toContain("FROM per_query GROUP BY service, query_language, query_text, cube_name, project_id");
  });

  it("keeps queries that sent no subquery (LEFT JOIN, no inner join on subqueries)", () => {
    expect(flat).toContain("LEFT JOIN sub ON q.query_id = sub.query_id");
    expect(flat).not.toMatch(/(?<!LEFT )JOIN engine\.subqueries/);
  });

  it("takes aggregate use from query_aggregate_usage, not the as_agg_ table prefix", () => {
    expect(flat).toContain("EXISTS (SELECT 1 FROM engine.query_aggregate_usage u WHERE u.query_id = q.query_id)");
    expect(sql).not.toContain("as_agg_");
  });

  it("reads the cache flags from subquery_results and classifies each execution", () => {
    expect(flat).toContain("bool_or(COALESCE(sr.used_local_cache, false))");
    expect(flat).toContain("bool_or(COALESCE(sr.used_aggregate_cache, false))");
    expect(flat).toContain("AS cache_executions");
    expect(flat).toContain("AS agg_executions");
    expect(flat).toContain("AS raw_executions");
  });

  it("escapes quotes and applies the filters", () => {
    expect(flat).toContain("p.cube_name = 'O''Brien Cube'");
    expect(flat).toContain("INTERVAL '30 days'");
    expect(flat).toContain("HAVING COUNT(*) >= 2");
  });
});

describe("rowToRecord", () => {
  it("maps pg's string numerics and the new breakdown fields", () => {
    const rec = rowToRecord({
      query_language: "analysis", original_text: "SELECT 1", atscale_query_id: "id-1",
      outbound_text: null, cube_name: "c", project_id: "p", used_agg: false,
      used_local_cache: true, used_aggregate_cache: false,
      num_times: "5", cache_executions: "3", agg_executions: "0", raw_executions: "2",
      avg_subquery_count: "0.4000000000000000", elapsed_time_in_seconds: "0.25", avg_result_size: "10",
    }, 0, "analysis", "c");
    expect(rec).toMatchObject({
      queryName: "XMLA Query 1 (id-1)", outboundText: null, numTimes: 5,
      cacheExecutions: 3, aggExecutions: 0, rawExecutions: 2,
      usedLocalCache: true, usedAggregateCache: false, avgSubqueryCount: 0.4,
      elapsedTimeInSeconds: 0.25, avgResultSetSize: 10,
    });
  });
});
