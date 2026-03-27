/**
 * AtScaleDeployModel
 *
 * Deploys a catalog (semantic model) to an AtScale instance from a catalog XML
 * file and an existing repository ID or name.
 *
 * Example:
 *
 *   atscale-deploy-model \
 *     --atscale-connection-name my_atscale \
 *     --catalog-xml-file catalog.xml \
 *     --repository-name my-sml-repo
 */
import fs from "fs";
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

class AtScaleDeployModelParams extends ParameterSet {
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
      name        = "catalog-xml-file";
      description = "Path to the catalog XML file to deploy";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "repository-id";
      description = "UUID of the repository to deploy against (from atscale-list-repos). Either this or --repository-name is required.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "repository-name";
      description = "Name of the repository to deploy against. Looked up via atscale-list-repos. Either this or --repository-id is required.";
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
  "catalog-xml-file": string;
  "repository-id"?: string;
  "repository-name"?: string;
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

export class AtScaleDeployModelOperation extends Operation<Params> {
  name        = "atscale-deploy-model";
  description = "Deploy a catalog (semantic model) to an AtScale instance";
  parameters  = new AtScaleDeployModelParams();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    if (!params["repository-id"] && !params["repository-name"]) {
      throw new Error("Either --repository-id or --repository-name is required");
    }

    const yaml       = this.services.get<YamlService>("yaml");
    const atScaleSvc = this.services.get<AtScaleRestClientService>("atscale-rest");

    const config     = yaml.readFromFile<Record<string, any>>(params["connection-file"]);
    const env        = resolveAtScaleEnv(config, params["atscale-connection-name"], params["insecure"]);
    const catalogXml = fs.readFileSync(params["catalog-xml-file"], "utf-8");

    let repositoryId = params["repository-id"];

    if (!repositoryId) {
      const repoName = params["repository-name"]!;
      this.logger.verbose(`[AtScaleDeployModel] Looking up repository '${repoName}'`);
      const repos = await atScaleSvc.listRepos(env);
      const repo = repos.find(r => r.name === repoName);
      if (!repo) {
        throw new Error(
          `Repository '${repoName}' not found. Available: ${repos.map(r => r.name).join(", ") || "(none)"}`,
        );
      }
      repositoryId = repo.id;
      this.logger.verbose(`[AtScaleDeployModel] Resolved repository '${repoName}' → ${repositoryId}`);
    }

    let tableauServers: TableauServerTarget[] | undefined;
    if (params["tableau-servers"]) {
      tableauServers = JSON.parse(params["tableau-servers"]) as TableauServerTarget[];
    }

    this.logger.verbose(`[AtScaleDeployModel] Deploying catalog from '${params["catalog-xml-file"]}' to ${env.baseUrl}`);

    const result = await atScaleSvc.deployModel(env, {
      catalogXml,
      repositoryId,
      tableauServers,
    });

    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
}
