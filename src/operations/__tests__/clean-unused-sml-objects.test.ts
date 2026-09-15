import { describe, expect, it } from "vitest";
import { analyzeSmlUsage, type SmlCollection, type SmlObject } from "../clean-unused-sml-objects/sml-usage-analyzer.js";

function obj(file: string, raw: Record<string, unknown>): SmlObject {
  return { file, raw };
}

function emptyCollection(): SmlCollection {
  return { connections: [], datasets: [], dimensions: [], metrics: [], calculations: [], models: [], other: [] };
}

describe("analyzeSmlUsage", () => {
  it("marks a dataset/connection reachable only through a model relationship as used", () => {
    const c = emptyCollection();
    c.connections.push(obj("connections/conn.yml", { unique_name: "conn", object_type: "connection" }));
    c.datasets.push(obj("datasets/fact.yml", { unique_name: "fact", object_type: "dataset", connection_id: "conn" }));
    c.dimensions.push(
      obj("dimensions/dim.yml", {
        unique_name: "Dim",
        object_type: "dimension",
        level_attributes: [{ unique_name: "la_key", dataset: "dim_ds.dataset", key_columns: ["id"] }],
      }),
    );
    c.datasets.push(obj("datasets/dim_ds.yml", { unique_name: "dim_ds", object_type: "dataset", connection_id: "conn" }));
    c.metrics.push(obj("metrics/m_sales.yml", { unique_name: "m_sales", object_type: "metric", dataset: "fact.dataset", column: "sales" }));
    c.models.push(
      obj("models/model.yml", {
        unique_name: "Model",
        object_type: "model",
        relationships: [{ unique_name: "rel", from: { dataset: "fact.dataset", join_columns: ["id"] }, to: { dimension: "Dim", level: "la_key" } }],
        metrics: [{ unique_name: "m_sales" }],
      }),
    );

    const analysis = analyzeSmlUsage(c);
    expect(analysis.unusedConnections).toHaveLength(0);
    expect(analysis.unusedDatasets).toHaveLength(0);
    expect(analysis.unusedDimensions).toHaveLength(0);
    expect(analysis.unusedMetrics).toHaveLength(0);
  });

  it("flags a dataset/dimension/metric/calculation/connection no model reaches", () => {
    const c = emptyCollection();
    c.connections.push(obj("connections/used.yml", { unique_name: "used_conn", object_type: "connection" }));
    c.connections.push(obj("connections/orphan.yml", { unique_name: "orphan_conn", object_type: "connection" }));
    c.datasets.push(obj("datasets/fact.yml", { unique_name: "fact", object_type: "dataset", connection_id: "used_conn" }));
    c.datasets.push(obj("datasets/orphan_ds.yml", { unique_name: "orphan_ds", object_type: "dataset", connection_id: "orphan_conn" }));
    c.dimensions.push(obj("dimensions/orphan_dim.yml", { unique_name: "Orphan Dim", object_type: "dimension", level_attributes: [] }));
    c.metrics.push(obj("metrics/orphan_metric.yml", { unique_name: "orphan_metric", object_type: "metric" }));
    c.calculations.push(obj("calculations/orphan_calc.yml", { unique_name: "orphan_calc", object_type: "metric_calc" }));
    c.models.push(
      obj("models/model.yml", {
        unique_name: "Model",
        object_type: "model",
        relationships: [{ unique_name: "rel", from: { dataset: "fact.dataset", join_columns: ["id"] }, to: { dimension: "Nonexistent", level: "x" } }],
        metrics: [],
      }),
    );

    const analysis = analyzeSmlUsage(c);
    expect(analysis.unusedConnections.map((o) => o.raw.unique_name)).toEqual(["orphan_conn"]);
    expect(analysis.unusedDatasets.map((o) => o.raw.unique_name)).toEqual(["orphan_ds"]);
    expect(analysis.unusedDimensions.map((o) => o.raw.unique_name)).toEqual(["Orphan Dim"]);
    expect(analysis.unusedMetrics.map((o) => o.raw.unique_name)).toEqual(["orphan_metric"]);
    expect(analysis.unusedCalculations.map((o) => o.raw.unique_name)).toEqual(["orphan_calc"]);
  });

  it("reaches a dimension only through another dimension's snowflake relationship, transitively", () => {
    const c = emptyCollection();
    c.datasets.push(obj("datasets/fact.yml", { unique_name: "fact", object_type: "dataset" }));
    c.datasets.push(obj("datasets/host_ds.yml", { unique_name: "host_ds", object_type: "dataset" }));
    c.datasets.push(obj("datasets/target_ds.yml", { unique_name: "target_ds", object_type: "dataset" }));
    c.dimensions.push(
      obj("dimensions/host.yml", {
        unique_name: "Host Dim",
        object_type: "dimension",
        level_attributes: [{ unique_name: "la_host", dataset: "host_ds.dataset", key_columns: ["id"] }],
        relationships: [
          {
            unique_name: "Host_Target",
            from: { dataset: "host_ds.dataset", join_columns: ["target_id"] },
            to: { dimension: "Target Dim", level: "la_host" },
            type: "snowflake",
          },
        ],
      }),
    );
    c.dimensions.push(
      obj("dimensions/target.yml", {
        unique_name: "Target Dim",
        object_type: "dimension",
        level_attributes: [{ unique_name: "la_target", dataset: "target_ds.dataset", key_columns: ["id"] }],
      }),
    );
    c.models.push(
      obj("models/model.yml", {
        unique_name: "Model",
        object_type: "model",
        relationships: [{ unique_name: "rel", from: { dataset: "fact.dataset", join_columns: ["id"] }, to: { dimension: "Host Dim", level: "la_host" } }],
      }),
    );

    const analysis = analyzeSmlUsage(c);
    expect(analysis.unusedDimensions).toHaveLength(0);
    expect(analysis.unusedDatasets.map((o) => o.raw.unique_name)).toEqual([]);
  });

  it("reaches a degenerate dimension via a model's dimensions: list, with no relationship at all", () => {
    const c = emptyCollection();
    c.dimensions.push(obj("dimensions/degen.yml", { unique_name: "Degen Dim", object_type: "dimension", is_degenerate: true }));
    c.models.push(
      obj("models/model.yml", {
        unique_name: "Model",
        object_type: "model",
        dimensions: [{ unique_name: "Degen Dim" }],
      }),
    );

    const analysis = analyzeSmlUsage(c);
    expect(analysis.unusedDimensions).toHaveLength(0);
  });
});
