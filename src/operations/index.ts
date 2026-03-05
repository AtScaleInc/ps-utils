/**
 * Operation registry entrypoint.
 */
import { EchoOperation } from "./echo/EchoOperation.js";
import { ToggleOperation } from "./toggle/ToggleOperation.js";
import { ExtractAtScaleModelOperation } from "./extract-atscale-model/ExtractAtScaleModelOperation.js";
import { GenerateTableauFromNamespaceOperation } from "./generate-tableau-from-namespace/GenerateTableauFromNamespaceOperation.js";
import { EchoConnectionMetaDataOperation } from "./sql/EchoConnectionMetaDataOperation.js";
import { PythonHelloWorldOperation } from "./python/PythonHelloWorldOperation.js";
import { OperationRegistry } from "./registry.js";
import { buildServiceRegistry, type ServiceRegistryOptions } from "../services/index.js";
import type { Logger } from "../logging.js";

/**
 * Build an operation registry with default services.
 */
export async function buildRegistry(
  logger: Logger,
  serviceOptions: ServiceRegistryOptions = {}
): Promise<OperationRegistry> {
  const services = await buildServiceRegistry(serviceOptions);
  const registry = new OperationRegistry();
  registry.register(new EchoOperation(services, logger));
  registry.register(new ToggleOperation(services, logger));
  registry.register(new ExtractAtScaleModelOperation(services, logger));
  registry.register(new GenerateTableauFromNamespaceOperation(services, logger));
  registry.register(new EchoConnectionMetaDataOperation(services, logger));
  registry.register(new PythonHelloWorldOperation(services, logger));
  return registry;
}
