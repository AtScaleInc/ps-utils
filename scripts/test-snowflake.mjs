import { YamlService } from "../dist/services/YamlService.js";
import { SqlService } from "../dist/services/SqlService.js";

async function main() {
  const yaml = new YamlService();
  const sql = new SqlService();
  const cfg = yaml.readFromFile("example/connections.yaml");
  const schema = cfg?.connections?.snow_demo?.sql?.schema;
  const conn = await sql.connect(cfg, "snow_demo");

  const schemaName = (schema ?? "PUBLIC").toUpperCase();
  const current = await sql.query(conn, "SELECT CURRENT_DATABASE() AS DB, CURRENT_SCHEMA() AS SCHEMA");
  console.log("Current DB/Schema:");
  console.log(current);

  const tables = await sql.query(
    conn,
    `SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = '${schemaName}'`
  );
  console.log("Tables:");
  console.log(tables);

  const columns = await sql.query(
    conn,
    `SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = '${schemaName}'`
  );
  console.log("Columns:");
  console.log(columns);

  const foreignKeys = await sql.query(
    conn,
    `SELECT * FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = '${schemaName}'`
  );
  console.log("Foreign Keys:");
  console.log(foreignKeys);

  await sql.close(conn);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
