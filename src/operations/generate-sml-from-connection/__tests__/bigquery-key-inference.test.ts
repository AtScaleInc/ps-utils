import { describe, it, expect } from "vitest";
import {
  choosePrimaryKey,
  inferForeignKeys,
  keyCandidates,
  tableBases,
  type InferTable,
} from "../bigquery-key-inference.js";

const col = (name: string, dataType = "INT64") => ({ name, dataType });

// A slice of the AdventureWorks dataset used by the internet sales model.
const dimcustomer: InferTable = {
  name: "dimcustomer",
  columns: [col("customerkey"), col("geographykey"), col("firstname", "STRING")],
};
const dimgeography: InferTable = {
  name: "dimgeography",
  columns: [col("geographykey"), col("city", "STRING")],
};
const dimCity: InferTable = {
  name: "dim_geo_city",
  columns: [col("geographykey"), col("city", "STRING"), col("citystatekey", "STRING")],
};
const dimState: InferTable = {
  name: "dim_geo_state",
  columns: [col("statekey", "STRING"), col("state", "STRING")],
};
const datecustom: InferTable = {
  name: "datecustom",
  columns: [col("pk_date", "TIMESTAMP"), col("datekey"), col("year", "TIMESTAMP")],
};
const fact: InferTable = {
  name: "factinternetsales",
  columns: [col("customerkey"), col("orderdatekey"), col("shipdatekey"), col("salesamount", "FLOAT64")],
};

describe("tableBases", () => {
  it("strips a role prefix and also offers the last token", () => {
    expect(tableBases("dimcustomer")).toEqual(["customer"]);
    expect(tableBases("dim_geo_state")).toEqual(["geostate", "state"]);
    expect(tableBases("datecustom")).toEqual(["datecustom"]);
  });
});

describe("keyCandidates", () => {
  it("ranks the table's own key first, then other *key columns in order", () => {
    expect(keyCandidates(dimcustomer).map((c) => c.column)).toEqual(["customerkey", "geographykey"]);
  });

  it("prefers datekey over pk_date", () => {
    expect(keyCandidates(datecustom).map((c) => c.column)).toEqual(["datekey", "pk_date"]);
  });

  it("uses the only column of a one-column table", () => {
    expect(keyCandidates({ name: "dim_geo_country", columns: [col("country", "STRING")] })).toEqual([
      { column: "country", tier: 4 },
    ]);
  });
});

describe("choosePrimaryKey", () => {
  const cands = [{ column: "currencykey", tier: 1 }, { column: "ordernumberlinekey", tier: 1 }];

  it("skips a candidate that has duplicates", () => {
    expect(choosePrimaryKey(cands, (c) => (c === "currencykey" ? "duplicate" : "unique"))).toBe("ordernumberlinekey");
  });

  it("trusts an unverified candidate only when it is named for the table", () => {
    expect(choosePrimaryKey([{ column: "customerkey", tier: 0 }], () => "unknown")).toBe("customerkey");
    expect(choosePrimaryKey([{ column: "geographykey", tier: 1 }], () => "unknown")).toBeUndefined();
  });
});

describe("inferForeignKeys", () => {
  const tables = [dimcustomer, dimgeography, dimCity, dimState, datecustom, fact];
  const pks = new Map([
    ["dimcustomer", "customerkey"],
    ["dimgeography", "geographykey"],
    ["dim_geo_city", "geographykey"],
    ["dim_geo_state", "statekey"],
    ["datecustom", "datekey"],
  ]);
  const { foreignKeys, ambiguous } = inferForeignKeys(tables, pks);
  const has = (t: string, c: string, pt: string) =>
    foreignKeys.some((f) => f.fkTable === t && f.fkColumn === c && f.pkTable === pt);

  it("matches identical names", () => {
    expect(has("factinternetsales", "customerkey", "dimcustomer")).toBe(true);
  });

  it("matches role-playing keys that end in the key's name", () => {
    expect(has("factinternetsales", "orderdatekey", "datecustom")).toBe(true);
    expect(has("factinternetsales", "shipdatekey", "datecustom")).toBe(true);
    const order = foreignKeys.find((f) => f.fkColumn === "orderdatekey");
    expect(order?.exact).toBe(false);
  });

  it("resolves a shared key name to the table named for it", () => {
    expect(has("dimcustomer", "geographykey", "dimgeography")).toBe(true);
    expect(has("dimcustomer", "geographykey", "dim_geo_city")).toBe(false);
  });

  it("never links a table's own key to a table with the same key name", () => {
    expect(foreignKeys.some((f) => f.fkTable === "dim_geo_city" && f.fkColumn === "geographykey")).toBe(false);
  });

  it("reports, rather than guesses, an unresolvable match", () => {
    const t = [
      { name: "a", columns: [col("thingkey")] },
      { name: "b", columns: [col("thingkey")] },
      { name: "c", columns: [col("widgetthingkey")] },
    ];
    const r = inferForeignKeys(t, new Map([["a", "thingkey"], ["b", "thingkey"]]));
    expect(r.foreignKeys).toEqual([]);
    expect(r.ambiguous[0]?.candidates.sort()).toEqual(["a", "b"]);
  });

  it("does not match on generic key names", () => {
    const t = [{ name: "a", columns: [col("id")] }, { name: "b", columns: [col("customerid")] }];
    expect(inferForeignKeys(t, new Map([["a", "id"]])).foreignKeys).toEqual([]);
  });
});

// TPC-DS style: surrogate keys end in _sk and every column carries a table prefix.
describe("surrogate keys with per-table column prefixes", () => {
  const item: InferTable = {
    name: "item",
    columns: [col("i_item_sk"), col("i_item_id", "STRING"), col("i_brand", "STRING")],
  };
  const dateDim: InferTable = {
    name: "date_dim",
    columns: [col("d_date_sk"), col("d_date_id", "STRING"), col("d_year")],
  };
  const customer: InferTable = {
    name: "customer",
    columns: [col("c_customer_sk"), col("c_customer_id", "STRING"), col("c_first_sales_date_sk")],
  };
  const storeSales: InferTable = {
    name: "store_sales",
    columns: [
      col("ss_sold_date_sk"), col("ss_item_sk"), col("ss_customer_sk"), col("ss_net_paid", "FLOAT64"),
    ],
  };

  it("prefers the _sk column over the business _id column as the key", () => {
    expect(keyCandidates(item)[0]?.column).toBe("i_item_sk");
    expect(keyCandidates(dateDim)[0]?.column).toBe("d_date_sk");
    expect(keyCandidates(customer)[0]?.column).toBe("c_customer_sk");
  });

  it("matches ss_item_sk to i_item_sk once the table prefixes are removed", () => {
    const pks = new Map([["item", "i_item_sk"], ["date_dim", "d_date_sk"], ["customer", "c_customer_sk"]]);
    const { foreignKeys } = inferForeignKeys([item, dateDim, customer, storeSales], pks);
    const to = (c: string) => foreignKeys.find((f) => f.fkTable === "store_sales" && f.fkColumn === c)?.pkTable;
    expect(to("ss_item_sk")).toBe("item");
    expect(to("ss_customer_sk")).toBe("customer");
    expect(to("ss_sold_date_sk")).toBe("date_dim");
  });

  it("links a dimension's own date keys to date_dim", () => {
    const pks = new Map([["date_dim", "d_date_sk"], ["customer", "c_customer_sk"]]);
    const { foreignKeys } = inferForeignKeys([dateDim, customer], pks);
    expect(foreignKeys.some((f) => f.fkColumn === "c_first_sales_date_sk" && f.pkTable === "date_dim")).toBe(true);
  });

  it("does not treat words that merely end in 'sk' as surrogate keys", () => {
    expect(keyCandidates({ name: "t", columns: [col("task"), col("desk")] })).toEqual([]);
  });
});
