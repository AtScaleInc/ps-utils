/**
 * AtScaleDeployRepo
 *
 * Instructs an AtScale instance to deploy (publish) a git repository that is
 * already configured in AtScale.  AtScale pulls the SML files from its
 * configured git repo and publishes them to the catalog.  No local file I/O
 * is performed by this operation.
 *
 * Example:
 *
 *   atscale-deploy-repo \
 *     --atscale-connection-name my_atscale \
 *     --repo-id 8c1a201b-0f9c-51c7-a2a1-63b13836d4b7
 */
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, BooleanParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import {
  AtScaleRestClientService,
  AtScaleEnvironment,
  type TableauServerTarget,
} from "../../services/AtScaleRestClientService.js";

// ── Parameters ────────────────────────────────────────────────────────────────

class AtScaleDeployRepoParams extends ParameterSet {
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
      name        = "repo-id";
      description = "UUID of the git repository already configured in AtScale (from atscale-list-repos)";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "project-id";
      description = "UUID of an existing AtScale project to update. Omit for first-time deploys.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "tableau-servers";
      description = "Optional JSON array of Tableau servers to publish to, e.g. [{\"name\":\"ts1\",\"sites\":[\"Default\"]}]";
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
  "repo-id": string;
  "project-id"?: string;
  "tableau-servers"?: string;
  "insecure"?: boolean;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveAtScaleEnv(
  config: Record<string, any>,
  connectionName: string,
  insecureOverride?: boolean,
): AtScaleEnvironment {
  const connections: Record<string, any> = config.connections ?? {};
  const entry = connections[connectionName];
  if (!entry) {
    throw new Error(`Connection '${connectionName}' not found in connections file`);
  }
  const atscale = entry.atscale;
  if (!atscale) {
    throw new Error(`Connection '${connectionName}' is missing an 'atscale:' block`);
  }
  const url = atscale.url;
  if (!url) {
    throw new Error(`Connection '${connectionName}'.atscale is missing 'url'`);
  }
  let username: string | undefined = atscale.username;
  let password: string | undefined = atscale.password;
  if (atscale.user) {
    const users: Record<string, any> = config.users ?? {};
    const userEntry = users[atscale.user];
    if (userEntry) {
      username ??= userEntry.username;
      password ??= userEntry.password;
    }
  }
  if (!atscale.apiToken) {
    if (!username) {
      throw new Error(
        `Connection '${connectionName}'.atscale is missing 'username' (or a 'user' key referencing the users block). ` +
        "Alternatively, set 'apiToken' to use a Design Center API token instead.",
      );
    }
    if (!password) {
      throw new Error(
        `Connection '${connectionName}'.atscale is missing 'password'. ` +
        "Alternatively, set 'apiToken' to use a Design Center API token instead.",
      );
    }
  }
  return new AtScaleEnvironment({
    baseUrl:       url,
    username,
    password,
    realm:         atscale.realm,
    clientId:      atscale.clientId,
    clientSecret:  atscale.clientSecret,
    authType:      atscale.authType,
    apiToken:      atscale.apiToken,
    sessionCookie: atscale.sessionCookie,
    insecure:      insecureOverride ?? atscale.insecure,
  });
}

// ── Operation ─────────────────────────────────────────────────────────────────

export class AtScaleDeployRepoOperation extends Operation<Params> {
  name        = "atscale-deploy-repo";
  description = "Trigger AtScale to deploy (publish) a git repository already configured in AtScale";
  parameters  = new AtScaleDeployRepoParams();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const yaml       = this.services.get<YamlService>("yaml");
    const atScaleSvc = this.services.get<AtScaleRestClientService>("atscale-rest");

    const config = yaml.readFromFile<Record<string, any>>(params["connection-file"]);
    const env    = resolveAtScaleEnv(config, params["atscale-connection-name"], params["insecure"]);

    let tableauServers: TableauServerTarget[] | undefined;
    if (params["tableau-servers"]) {
      tableauServers = JSON.parse(params["tableau-servers"]) as TableauServerTarget[];
    }

    this.logger.verbose(`[AtScaleDeployRepo] Deploying repo ${params["repo-id"]} on ${env.baseUrl}`);

    const result = await atScaleSvc.deployRepo(env, {
      repoId:         params["repo-id"],
      projectId:      params["project-id"],
      tableauServers,
    });

    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
}
