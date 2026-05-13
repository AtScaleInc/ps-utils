import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { Operation } from "../Operation.js";
import { ParameterSet } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";

class VersionParamsSet extends ParameterSet {
  parameters = [];
}

type Params = Record<string, never>;
export type VersionParams = Params;

export class VersionOperation extends Operation<Params> {
  name        = "version";
  description = "Print the installed version of atscale-utils";
  parameters  = new VersionParamsSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  run(_params: Params): void {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string; name: string };
    this.logger.log(`${pkg.name}@${pkg.version}`);
  }
}
