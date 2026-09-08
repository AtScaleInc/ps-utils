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
  type RepoType,
} from "../../services/AtScaleRestClientService.js";
import { resolveAtScaleEnv } from "../atscale-env.js";

// ── Parameters ────────────────────────────────────────────────────────────────

class AtScaleCreateRepoParamsSet extends ParameterSet {
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
export type AtScaleCreateRepoParams = Params;

// ── Helpers ───────────────────────────────────────────────────────────────────


// ── Operation ─────────────────────────────────────────────────────────────────

export class AtScaleCreateRepoOperation extends Operation<Params> {
  name        = "atscale-create-repo";
  description = "Register a git repository in an AtScale instance";
  parameters  = new AtScaleCreateRepoParamsSet();

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
