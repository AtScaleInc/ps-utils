/**
 * AtScaleCreateRepo
 *
 * Registers a git repository in an AtScale instance.
 */
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, BooleanParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import {
  AtScaleRestClientService,
  AtScaleEnvironment,
  type RepoType,
} from "../../services/AtScaleRestClientService.js";

// ── Parameters ────────────────────────────────────────────────────────────────

class AtScaleCreateRepoParams extends ParameterSet {
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
      name        = "name";
      description = "Human-readable name for the repository";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "url";
      description = "Git remote URL (HTTPS or SSH)";
      required    = true;
    })(),
    new (class extends StringParameter {
      name         = "type";
      description  = "Repository type: 'catalog' (default) or 'global_settings'";
      required     = false;
      defaultValue = "catalog";
    })(),
    new (class extends StringParameter {
      name        = "visible-branches-pattern";
      description = "Glob pattern controlling which branches are visible in the UI";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "default-branch";
      description = "Default branch name (e.g. 'main')";
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
  "name": string;
  "url": string;
  "type": string;
  "visible-branches-pattern"?: string;
  "default-branch"?: string;
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

export class AtScaleCreateRepoOperation extends Operation<Params> {
  name        = "atscale-create-repo";
  description = "Register a git repository in an AtScale instance";
  parameters  = new AtScaleCreateRepoParams();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const yaml       = this.services.get<YamlService>("yaml");
    const atScaleSvc = this.services.get<AtScaleRestClientService>("atscale-rest");

    const config = yaml.readFromFile<Record<string, any>>(params["connection-file"]);
    const env    = resolveAtScaleEnv(config, params["atscale-connection-name"], params["insecure"]);

    this.logger.verbose(`[AtScaleCreateRepo] Registering repo '${params["name"]}' on ${env.baseUrl}`);

    const result = await atScaleSvc.connectGitRepo(env, {
      name:                   params["name"],
      url:                    params["url"],
      type:                   params["type"] as RepoType,
      visibleBranchesPattern: params["visible-branches-pattern"],
      defaultBranch:          params["default-branch"],
    });

    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
}
