import { describe, expect, it } from "vitest";
import { DdlDatabaseMetaData } from "../ddl-reader.js";

describe("DdlDatabaseMetaData — qualified names", () => {
  it("parses one-, two- and three-part table names", async () => {
    const db = DdlDatabaseMetaData.fromDdl(`
      CREATE TABLE t1 (id INT);
      CREATE TABLE sales.t2 (id INT);
      CREATE TABLE DW.sales.t3 (id INT);
      CREATE OR REPLACE TRANSIENT TABLE "My DB"."My.Schema"."Odd Table" (id INT);
    `);
    const tables = await db.getTables();
    expect(tables).toEqual([
      { tableName: "t1", tableType: "TABLE" },
      { tableName: "t2", tableType: "TABLE", schemaName: "sales" },
      { tableName: "t3", tableType: "TABLE", schemaName: "sales", databaseName: "DW" },
      { tableName: "Odd Table", tableType: "TABLE", schemaName: "My.Schema", databaseName: "My DB" },
    ]);
  });

  it("keeps foreign keys working with three-part REFERENCES", async () => {
    const db = DdlDatabaseMetaData.fromDdl(`
      CREATE TABLE DW.dims.customer (customer_id INT PRIMARY KEY, name VARCHAR(50));
      CREATE TABLE DW.facts.orders (
        order_id INT PRIMARY KEY,
        customer_id INT,
        amount DECIMAL(10,2),
        FOREIGN KEY (customer_id) REFERENCES DW.dims.customer (customer_id)
      );
    `);
    const fks = await db.getForeignKeys("orders");
    expect(fks).toHaveLength(1);
    expect(fks[0]).toMatchObject({ fkColumnName: "customer_id", pkTableName: "customer", pkColumnName: "customer_id" });
  });

  it("filters by a comma-separated schema list", async () => {
    const db = DdlDatabaseMetaData.fromDdl(`
      CREATE TABLE a.t1 (id INT);
      CREATE TABLE b.t2 (id INT);
      CREATE TABLE c.t3 (id INT);
      CREATE VIEW b.v1 AS SELECT id FROM b.t2;
    `);
    const names = (await db.getTables("A, b")).map((t) => t.tableName);
    expect(names).toEqual(["t1", "t2", "v1"]);
  });
});

describe("DdlDatabaseMetaData — CREATE VIEW", () => {
  it("reads an explicit column list, bracketed body and Snowflake modifiers", async () => {
    const db = DdlDatabaseMetaData.fromDdl(`
      create or replace secure view DB.SCH.VW_SALES( "Region" COMMENT 'sales region', "Amount" )
        copy grants comment = 'a view AS described' as (
        select s."REGION" as "Region", s."AMT" as "Revenue" from DB.SCH.TB_SALES s
      );
    `);
    expect(db.getViewNames()).toEqual(["VW_SALES"]);
    const tables = await db.getTables();
    expect(tables).toEqual([{ tableName: "VW_SALES", tableType: "VIEW", schemaName: "SCH", databaseName: "DB" }]);
    const cols = await db.getColumns("vw_sales");
    // The column list wins over the SELECT aliases.
    expect(cols.map((c) => c.columnName)).toEqual(["Region", "Amount"]);
  });

  it("derives columns from SELECT aliases when there is no column list", async () => {
    const db = DdlDatabaseMetaData.fromDdl(`
      CREATE VIEW v AS
      SELECT DISTINCT a.id, b.name AS customer_name, COUNT(*) order_count,
             CASE WHEN a.x > 1 THEN 'y' ELSE 'n' END AS flag, a.*
      FROM t_a a JOIN t_b b ON a.id = b.id
      WHERE a.id > 0;
    `);
    const cols = await db.getColumns("v");
    expect(cols.map((c) => c.columnName)).toEqual(["id", "customer_name", "order_count", "flag"]);
  });

  it("does not mistake a parenthesised SELECT for a column list", async () => {
    const db = DdlDatabaseMetaData.fromDdl(`CREATE VIEW v AS (SELECT id, name FROM t);`);
    expect((await db.getColumns("v")).map((c) => c.columnName)).toEqual(["id", "name"]);
  });

  it("resolves view column types from source tables, CAST and ::", async () => {
    const db = DdlDatabaseMetaData.fromDdl(`
      CREATE TABLE sch.orders (order_id INT, amount DECIMAL(12,2), placed_at TIMESTAMP);
      CREATE VIEW sch.v_orders ("Order", "Amount", "Day", "Units", "Label") AS (
        SELECT o.order_id, o."AMOUNT", CAST(o.placed_at AS DATE), qty::NUMBER(10,0), 'x' FROM sch.orders o
      );
      CREATE VIEW sch.v_top AS SELECT "Amount" AS amt FROM sch.v_orders;
    `);
    const cols = await db.getColumns("v_orders");
    expect(cols.map((c) => `${c.columnName}:${c.dataType}`)).toEqual([
      "Order:INT", "Amount:DECIMAL", "Day:DATE", "Units:NUMBER", "Label:VARCHAR",
    ]);
    // View-on-view lineage
    expect((await db.getColumns("v_top")).map((c) => c.dataType)).toEqual(["DECIMAL"]);
    expect(db.getReaderWarnings().join("\n")).toContain('View "v_orders": 1 column(s) default to VARCHAR (Label)');
  });

  it("warns when a whole view is untyped and applies column-types overrides", async () => {
    const ddl = `CREATE VIEW DB.S.VW (a, b) AS (SELECT x AS a, y AS b FROM DB.RAW.T);`;
    const plain = DdlDatabaseMetaData.fromDdl(ddl);
    expect(plain.getReaderWarnings().join("\n")).toContain("all 2 column(s) default to VARCHAR");

    const typed = DdlDatabaseMetaData.fromDdl(ddl, {
      columnTypes: { "VW.b": "NUMBER(38,6)", "S.VW.a": "DATE", "NOPE.x": "INT" },
    });
    expect((await typed.getColumns("VW")).map((c) => `${c.columnName}:${c.dataType}:${c.columnSize}`))
      .toEqual(["a:DATE:0", "b:NUMBER:38"]);
    const warnings = typed.getReaderWarnings().join("\n");
    expect(warnings).toContain('Override "NOPE.x" did not match any column');
    expect(warnings).not.toContain("[VIEW TYPES]");
  });

  it("exposes views only through getViews() when viewsAsTables is false", async () => {
    const ddl = `CREATE TABLE t (id INT); CREATE VIEW v AS SELECT id FROM t;`;
    const db = DdlDatabaseMetaData.fromDdl(ddl, { viewsAsTables: false });
    expect((await db.getTables()).map((t) => t.tableName)).toEqual(["t"]);
    expect(await db.getColumns("v")).toEqual([]);
    const views = await db.getViews();
    expect(views).toHaveLength(1);
    expect(views[0].columns.map((c) => `${c.columnName}:${c.dataType}`)).toEqual(["id:INT"]);

    const asTables = DdlDatabaseMetaData.fromDdl(ddl);
    expect((await asTables.getTables()).map((t) => `${t.tableName}:${t.tableType}`)).toEqual(["t:TABLE", "v:VIEW"]);
    expect(await asTables.getViews()).toEqual([]);
  });

  it("prefers a table over a view of the same name and warns", async () => {
    const db = DdlDatabaseMetaData.fromDdl(`CREATE TABLE x (id INT); CREATE VIEW x AS SELECT 1 AS one;`);
    expect((await db.getTables()).map((t) => t.tableType)).toEqual(["TABLE"]);
    expect(db.getDuplicateTableWarnings().join("\n")).toContain("defined as both a table and a view");
  });
});
