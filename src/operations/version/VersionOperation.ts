import { Operation } from "../Operation.js";
import { packageVersion } from "../../assets.js";
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
    const pkg = packageVersion(() => import.meta.url);
    this.logger.log(`${pkg.name}@${pkg.version}`);
  }
}
