/**
 * Service registry factory for shared CLI services.
 */
import { EjsTemplateService } from "./EjsTemplateService.js";
import { YamlService } from "./YamlService.js";
import { PythonService } from "./PythonService.js";
import { ExcelService } from "./ExcelService.js";
import { ServiceRegistry } from "./registry.js";
import type { Logger } from "../logging.js";

export type ServiceRegistryOptions = {
  includeSql?: boolean;
  logger?: Logger;
};

/**
 * Build a service registry with default providers.
 */
export async function buildServiceRegistry(
  options: ServiceRegistryOptions = {}
): Promise<ServiceRegistry> {
  const registry = new ServiceRegistry();
  registry.register(new EjsTemplateService());
  registry.register(new YamlService());
  registry.register(new PythonService());  // retained for PythonHelloWorldOperation
  registry.register(new ExcelService());
  if (options.includeSql !== false) {
    const { SqlService } = await import("./SqlService.js");
    registry.register(new SqlService(options.logger));
  }
  return registry;
}
