import { EjsTemplateService } from "./EjsTemplateService.js";
import { YamlService } from "./YamlService.js";
import { ServiceRegistry } from "./registry.js";

export type ServiceRegistryOptions = {
  includeSql?: boolean;
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
  if (options.includeSql !== false) {
    const { SqlService } = await import("./SqlService.js");
    registry.register(new SqlService());
  }
  return registry;
}
