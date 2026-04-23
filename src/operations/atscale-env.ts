/**
 * Shared helper for resolving an AtScaleEnvironment from a connections YAML config.
 *
 * Credential resolution order:
 *   1. `atscale.username` / `atscale.password` — inline on the connection block
 *   2. `users[atscale.user].username` / `.password` — referenced user entry
 *   3. `users[atscale.user].apiToken` — API token on the referenced user entry (preferred)
 *   4. `atscale.apiToken` — API token inline on the connection block (legacy fallback)
 *
 * Recommended connections.yaml layout:
 *
 *   users:
 *     my_user:
 *       username: admin          # for Keycloak / Basic auth
 *       password: secret
 *       apiToken: abc123...      # Design Center API token (SSO-compatible)
 *
 *   connections:
 *     my_atscale:
 *       atscale:
 *         url: https://atscale.example.com
 *         user: my_user
 */

import {
  AtScaleEnvironment,
} from "../services/AtScaleRestClientService.js";

export type AtScaleEnvOpts = {
  authType?:       "keycloak" | "basic";
  useRawApiToken?: boolean;
  cookieAuth?:     boolean;
};

/**
 * Build an AtScaleEnvironment from a parsed connections YAML config.
 *
 * @param config          Parsed contents of connections.yaml
 * @param connectionName  Key under `connections:` to look up
 * @param insecureOverride  When provided, overrides the `insecure` flag from the file
 * @param opts            Optional auth overrides (cookieAuth, useRawApiToken, authType)
 */
export function resolveAtScaleEnv(
  config: Record<string, any>,
  connectionName: string,
  insecureOverride?: boolean,
  opts: AtScaleEnvOpts = {},
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
  let apiToken: string | undefined = atscale.apiToken;

  if (atscale.user) {
    const users: Record<string, any> = config.users ?? {};
    const userEntry = users[atscale.user];
    if (userEntry) {
      username ??= userEntry.username;
      password ??= userEntry.password;
      apiToken  ??= userEntry.apiToken;
    }
  }

  const sessionCookie: string | undefined = atscale.sessionCookie;

  if (!apiToken && !sessionCookie) {
    if (!username) {
      throw new Error(
        `Connection '${connectionName}'.atscale is missing 'username' (or a 'user' key referencing the users block). ` +
        "Alternatively, set 'apiToken' on the user entry or the atscale block to use a Design Center API token.",
      );
    }
    if (!password) {
      throw new Error(
        `Connection '${connectionName}'.atscale is missing 'password'. ` +
        "Alternatively, set 'apiToken' on the user entry or the atscale block to use a Design Center API token.",
      );
    }
  }

  return new AtScaleEnvironment({
    baseUrl:        url,
    username,
    password,
    realm:          atscale.realm,
    clientId:       atscale.clientId,
    clientSecret:   atscale.clientSecret,
    authType:       opts.authType ?? atscale.authType,
    apiToken:       opts.cookieAuth ? undefined : apiToken,
    sessionCookie,
    insecure:       insecureOverride ?? atscale.insecure,
    useRawApiToken: opts.useRawApiToken,
    cookieAuth:     opts.cookieAuth,
  });
}
