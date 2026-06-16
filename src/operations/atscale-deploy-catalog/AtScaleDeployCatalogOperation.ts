/**
 * AtScaleDeployCatalog
 *
 * Reads SML files from a local directory and deploys them to an AtScale
 * instance via the Design Center git-deploy endpoint.  AtScale stores the
 * files in the configured git repository and publishes the compiled catalog.
 *
 * Before deploying, the operation calls the same endpoint as
 * atscale-list-deployments (GET /wapi/p/projects/deployed) to check whether
 * the model is already deployed.  If a matching project is found the existing
 * project UUID is reused, making repeated deploys idempotent.  For first-time
 * deploys a new UUID is generated automatically.
 *
 * Authentication: the deploy endpoint requires the Design Center `auth_session`
 * cookie.  The cookie is acquired automatically via the Keycloak
 * authorization-code flow — no manual browser cookie is needed.  Ensure the
 * `atscale:` block includes `user:` (or inline `username:`/`password:`) so the
 * credentials are available for the cookie flow, even when `apiToken:` is also
 * set.
 *
 * Example:
 *
 *   atscale-deploy-catalog \
 *     --connection-file connections.yaml \
 *     --atscale-connection-name my_atscale \
 *     --sml-dir ./sml \
 *     --repo-name my-sml-repo
 */
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { v4 as uuidv4 } from "uuid";
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter, BooleanParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import {
  AtScaleRestClientService,
  AtScaleEnvironment,
  type TableauServerTarget,
  type SmlRawFile,
} from "../../services/AtScaleRestClientService.js";
import {
  buildCatalogXml,
  type SmlCatalog,
  type SmlModel,
  type SmlDimension,
  type SmlDataset,
  type SmlMetric,
  type SmlConnection,
} from "../../algorithm/catalog-xml-builder.js";

// ── Parameters ────────────────────────────────────────────────────────────────

class AtScaleDeployCatalogParamsSet extends ParameterSet {
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
      name        = "sml-dir";
      description = "Path to the directory containing SML files to deploy";
      required    = true;
    })(),
    new (class extends StringParameter {
      name        = "repo-id";
      description = "UUID of the git repository already configured in AtScale (from atscale-list-repos). Either repo-id or repo-name is required.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "repo-name";
      description = "Name of the git repository already configured in AtScale. Used to look up the repo-id when repo-id is not provided.";
      required    = false;
    })(),
    new (class extends StringParameter {
      name        = "project-name";
      description = "Catalog project name to deploy as. Defaults to {catalog.unique_name}_{repo.defaultBranch}.";
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
  "sml-dir": string;
  "repo-id"?: string;
  "repo-name"?: string;
  "project-name"?: string;
  "tableau-servers"?: string;
  "insecure"?: boolean;
};
export type AtScaleDeployCatalogParams = Params;

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveAtScaleEnv(
  config: Record<string, any>,
  connectionName: string,
  insecureOverride?: boolean,
  cookieAuth = false,
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
  if (!atscale.apiToken && !atscale.sessionCookie) {
    if (!username) {
      throw new Error(
        `Connection '${connectionName}'.atscale is missing 'username' (or a 'user' key referencing the users block). ` +
        "Alternatively, set 'apiToken' or 'sessionCookie'.",
      );
    }
    if (!password) {
      throw new Error(
        `Connection '${connectionName}'.atscale is missing 'password'. ` +
        "Alternatively, set 'apiToken' or 'sessionCookie'.",
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
    apiToken:      cookieAuth ? undefined : atscale.apiToken,
    sessionCookie: atscale.sessionCookie,
    cookieAuth,
    insecure:      insecureOverride ?? atscale.insecure,
  });
}

/** Recursively collect all *.yml files under `dir`, returning {relativePath, rawContent}. */
function collectSmlFiles(dir: string): SmlRawFile[] {
  const results: SmlRawFile[] = [];
  function walk(current: string, base: string): void {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, base);
      } else if (entry.isFile() && entry.name.endsWith(".yml")) {
        const relativePath = path.relative(base, fullPath);
        const rawContent   = fs.readFileSync(fullPath, "utf8");
        results.push({ relativePath, rawContent });
      }
    }
  }
  walk(dir, dir);
  return results;
}

/** Scan all SML files for connection_id values and return unique ones. */
function inferConIds(smlFiles: SmlRawFile[]): string[] {
  const ids = new Set<string>();
  for (const { rawContent } of smlFiles) {
    for (const match of rawContent.matchAll(/^connection_id:\s*(.+)$/gm)) {
      ids.add(match[1].trim());
    }
  }
  return Array.from(ids);
}

// ── Operation ─────────────────────────────────────────────────────────────────

export class AtScaleDeployCatalogOperation extends Operation<Params> {
  name        = "atscale-deploy-catalog";
  description = "Deploy local SML files to an AtScale git repository and publish the catalog";
  parameters  = new AtScaleDeployCatalogParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  async run(params: Params): Promise<void> {
    const yamlSvc    = this.services.get<YamlService>("yaml");
    const atScaleSvc = this.services.get<AtScaleRestClientService>("atscale-rest");

    const config   = yamlSvc.readFromFile<Record<string, any>>(params["connection-file"]);
    const connName = params["atscale-connection-name"];
    const insecure = params["insecure"];

    // /wapi/p/ endpoints use Bearer JWT (API token exchange).
    // /wapi/git/deploy/catalog requires the auth_session cookie — acquired
    // automatically via the Keycloak authorization-code flow when not set
    // explicitly.  The two envs use different auth strategies.
    const envApi    = resolveAtScaleEnv(config, connName, insecure, false);
    const envDeploy = resolveAtScaleEnv(config, connName, insecure, true);

    // Collect SML files from the directory.
    const smlDir   = params["sml-dir"];
    const smlFiles = collectSmlFiles(smlDir);
    this.logger.verbose(`[AtScaleDeployCatalog] Collected ${smlFiles.length} SML files from ${smlDir}`);

    // Parse all SML files into typed maps.
    let catalogObj: SmlCatalog | undefined;
    let modelObj: SmlModel | undefined;
    const dimensionsMap  = new Map<string, SmlDimension>();
    const datasetsMap    = new Map<string, SmlDataset>();
    const metricsMap     = new Map<string, SmlMetric>();
    const connectionsMap = new Map<string, SmlConnection>();

    for (const { rawContent } of smlFiles) {
      const obj = yaml.load(rawContent) as Record<string, any>;
      if (!obj || typeof obj !== "object") continue;
      switch (obj.object_type) {
        case "catalog":    catalogObj = obj; break;
        case "model":      modelObj   ??= obj; break; // use first model found
        case "dimension":  dimensionsMap.set(obj.unique_name, obj); break;
        case "dataset":    datasetsMap.set(obj.unique_name, obj); break;
        case "metric":     metricsMap.set(obj.unique_name, obj); break;
        case "connection": connectionsMap.set(obj.unique_name, obj); break;
      }
    }

    if (!catalogObj) {
      throw new Error(`No catalog.yml (object_type: catalog) found in ${smlDir}`);
    }
    if (!modelObj) {
      throw new Error(`No model file (object_type: model) found in ${smlDir}`);
    }

    // Infer connection IDs from SML dataset files.
    const conIds = inferConIds(smlFiles);
    this.logger.verbose(`[AtScaleDeployCatalog] Inferred connection IDs: ${conIds.join(", ")}`);

    // Parse optional Tableau servers.
    let tableauServers: TableauServerTarget[] | undefined;
    if (params["tableau-servers"]) {
      tableauServers = JSON.parse(params["tableau-servers"]) as TableauServerTarget[];
    }

    // Resolve repo-id: use it directly, or look it up by repo-name.
    // Also capture defaultBranch for projectName derivation.
    let repoId = params["repo-id"];
    let defaultBranch = "main";
    if (!repoId) {
      const repoName = params["repo-name"];
      if (!repoName) {
        throw new Error("Either --repo-id or --repo-name must be provided");
      }
      const repos = await atScaleSvc.listRepos(envApi);
      const match = repos.find((r) => r.name === repoName);
      if (!match) {
        throw new Error(
          `No repository named '${repoName}' found in AtScale. ` +
          `Available repos: ${repos.map((r) => r.name).join(", ")}`,
        );
      }
      repoId        = match.id;
      defaultBranch = match.defaultBranch ?? "main";
      this.logger.verbose(`[AtScaleDeployCatalog] Resolved repo '${repoName}' → ${repoId} (branch: ${defaultBranch})`);
    }

    // Derive projectName: {catalog.unique_name}_{defaultBranch}
    // The explicit --project-name flag overrides this.
    const catalogUniqueName = catalogObj.unique_name as string;
    const projectName = params["project-name"] ?? `${catalogUniqueName}_${defaultBranch}`;
    this.logger.verbose(`[AtScaleDeployCatalog] Project name: ${projectName}`);

    // Check whether this model is already deployed by calling the same endpoint
    // as atscale-list-deployments (GET /wapi/p/projects/deployed).  Reuse the
    // existing project UUID if found so repeated deploys are idempotent.
    // The API always requires projectId, so generate a new UUID for new deploys.
    let projectId: string;
    const deployed = await atScaleSvc.listModels(envApi);
    const repoEntry = deployed.find((e) => e.repoId === repoId);
    const existingProject = repoEntry?.projects.find((p) => p.name === projectName);
    if (existingProject) {
      projectId = existingProject.id;
      this.logger.verbose(`[AtScaleDeployCatalog] Found existing deployment — reusing projectId: ${projectId}`);
    } else {
      projectId = uuidv4();
      this.logger.verbose(`[AtScaleDeployCatalog] No existing deployment — generated projectId: ${projectId}`);
    }

    // Generate catalog XML from the SML objects.
    this.logger.verbose(`[AtScaleDeployCatalog] Generating catalog XML...`);
    const projectXml = buildCatalogXml({
      catalog:        catalogObj,
      model:          modelObj,
      dimensionsMap,
      datasetsMap,
      metricsMap,
      connectionsMap,
      projectName,
      projectId,
    });
    this.logger.verbose(`[AtScaleDeployCatalog] Generated projectXml (${projectXml.length} bytes)`);

    this.logger.verbose(
      `[AtScaleDeployCatalog] Deploying '${projectName}' (${smlFiles.length} files) ` +
      `to repo ${repoId} on ${envDeploy.baseUrl}`,
    );

    const result = await atScaleSvc.deployRepo(envDeploy, {
      repoId,
      smlRawFiles:  smlFiles,
      projectXml,
      projectName,
      conIds,
      projectId,
      tableauServers,
    });

    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
}
