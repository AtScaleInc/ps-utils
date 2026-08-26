/**
 * AtScaleCreateDataSource
 *
 * Creates a data warehouse (data source) in an AtScale instance using the
 * connection details from a named SQL connection in the connections file.
 *
 * The connections file must have:
 *   - An `atscale:` block on the AtScale connection entry (for authentication)
 *   - A `sql:` block on the SQL connection entry (for data source configuration)
 *
 * Example:
 *
 *   connections:
 *     my_atscale:
 *       atscale:
 *         url: https://atscale.example.com
 *         user: admin
 *     snow_prod:
 *       sql:
 *         dialect: snowflake
 *         account: myorg.snowflakecomputing.com
 *         warehouse: COMPUTE_WH
 *         database: MY_DB
 *         user: snowflake_user
 *
 *   users:
 *     admin:
 *       username: admin
 *       password: secret
 *     snowflake_user:
 *       username: USER@EXAMPLE.COM
 *       privateKeyPath: resources/keys/snowflake_key.p8
 *       privateKeyPassword: ""
 */
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, BooleanParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import type { ConnectionConfig } from "../../services/SqlService.js";
import {
  AtScaleRestClientService,
} from "../../services/AtScaleRestClientService.js";
import { resolveAtScaleEnv } from "../atscale-env.js";

// ── Parameters ────────────────────────────────────────────────────────────────

class AtScaleCreateDataSourceParamsSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name         = "connection-file";
      description  = "Path to the connections YAML file";
      required     = false;
      defaultValue = "connections.yaml";
    })(),
    new (class extends StringParameter {
      name        = "atscale-connection-name";
      description = "Name of the AtScale connection entry (must have an atscale: block)";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "new-connection-name";
      description = "Name of the SQL connection entry to register as a data source (must have a sql: block)";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "aggregate-schema";
      description = "Schema (or BigQuery dataset) used for aggregate table storage";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "name";
      description = "Display name for the data warehouse in AtScale. Defaults to --new-connection-name.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "connection-id";
      description = "Logical connection ID embedded in SML. Defaults to --new-connection-name.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "access-users";
      description = "Comma-separated AtScale usernames to grant access. Omit or pass empty string to grant access to the 'everyone' group instead.";
      required    = false;
      defaultValue = "";
    })(),
    new (class extends StringParameter {
      name        = "aggregate-project-id";
      description = "BigQuery only: GCP project ID for aggregate storage. Defaults to sql.project from the connection config.";
      required    = false;
    })(),
    new (class extends BooleanParameter {
      name         = "insecure";
      description  = "Skip TLS certificate verification (overrides the connections file value). Defaults to true.";
      required     = false;
    })(),
  ];
}

type Params = {
  "connection-file": string;
  "atscale-connection-name": string;
  "new-connection-name": string;
  "aggregate-schema": string;
  "name"?: string;
  "connection-id"?: string;
  "access-users": string;
  "aggregate-project-id"?: string;
  "insecure"?: boolean;
};
export type AtScaleCreateDataSourceParams = Params;

// ── Helpers ───────────────────────────────────────────────────────────────────


// ── Operation ─────────────────────────────────────────────────────────────────

export class AtScaleCreateDataSourceOperation extends Operation<Params> {
  name        = "atscale-create-data-source";
  description = "Register a data source (data warehouse) in an AtScale instance";
  parameters  = new AtScaleCreateDataSourceParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const yaml       = this.services.get<YamlService>("yaml");
    const atScaleSvc = this.services.get<AtScaleRestClientService>("atscale-rest");

    const config = yaml.readFromFile<ConnectionConfig>(params["connection-file"]);
    const env    = resolveAtScaleEnv(config as Record<string, any>, params["atscale-connection-name"], params["insecure"]);

    const sqlConnectionName = params["new-connection-name"];
    const name         = params["name"] ?? sqlConnectionName;
    const connectionId = params["connection-id"] ?? sqlConnectionName;
    const accessUsers  = params["access-users"]
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean)
      .map((userName) => ({ userName }));
    const access = accessUsers.length > 0
      ? { users: accessUsers, groups: [] }
      : { users: [], groups: [{ name: "everyone" }] };

    this.logger.verbose(`[AtScaleCreateDataSource] Creating data source '${name}' on ${env.baseUrl}`);

    const result = await atScaleSvc.createDataSource(env, {
      config,
      connectionName:     sqlConnectionName,
      name,
      connectionId,
      aggregateSchema:    params["aggregate-schema"],
      access,
      aggregateProjectId: params["aggregate-project-id"],
    });

    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
}
