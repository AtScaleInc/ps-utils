import { YamlService } from "../dist/services/YamlService.js";
import { SqlService } from "../dist/services/SqlService.js";

async function main(): Promise<void> {
  const yaml = new YamlService();
  const sql = new SqlService();
  const cfg = yaml.readFromFile("example/connections.yaml");
  const conn = await sql.connect(cfg, "snow_demo");

  const tables = await sql.getTables(conn, undefined, "%", ["TABLE"]);
  console.log("Tables:");
  console.log(tables);

  const columns = await sql.getColumns(conn, undefined, "%", "%");
  console.log("Columns:");
  console.log(columns);

  const foreignKeys = await sql.getForeignKeys(conn, undefined, "%");
  console.log("Foreign Keys:");
  console.log(foreignKeys);

  await sql.close(conn);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
