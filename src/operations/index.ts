/**
 * Operation registry entrypoint.
 */
import { EchoOperation } from "./echo/EchoOperation.js";
import { ToggleOperation } from "./toggle/ToggleOperation.js";
import { ExtractAtScaleModelOperation } from "./extract-model-from-atscale/ExtractAtScaleModelOperation.js";
import { GeneratePowerBIFromNamespaceOperation } from "./generate-powerbi-from-namespace/GeneratePowerBIFromNamespaceOperation.js";
import { GenerateTableauFromNamespaceOperation } from "./generate-tableau-from-namespace/GenerateTableauFromNamespaceOperation.js";
import { EchoConnectionMetaDataOperation } from "./sql/EchoConnectionMetaDataOperation.js";
import { PythonHelloWorldOperation } from "./python/PythonHelloWorldOperation.js";
import { GenerateSMLFromConnectionOperation } from "./generate-sml-from-connection/GenerateSMLFromConnectionOperation.js";
import { GenerateSMLFromDDLOperation } from "./generate-sml-from-ddl/GenerateSMLFromDDLOperation.js";
import { ExtractModelFromSMLOperation } from "./extract-model-from-sml/ExtractModelFromSMLOperation.js";
import { GenerateNamespaceFromModelOperation } from "./generate-namespace-from-model/GenerateNamespaceFromModelOperation.js";
import { ExecuteSQLOnConnectionOperation } from "./execute-sql-on-connection/ExecuteSQLOnConnectionOperation.js";
import { ExtractDDLFromConnectionOperation } from "./extract-ddl-from-connection/ExtractDDLFromConnectionOperation.js";
import { GenerateExcelFromNamespaceOperation } from "./generate-excel-from-namespace/GenerateExcelFromNamespaceOperation.js";
import { ExtractQueryStatsFromAtScaleOperation } from "./extract-query-stats-from-atscale/ExtractQueryStatsFromAtScaleOperation.js";
import { ExtractQueriesFromAtScaleOperation } from "./extract-queries-from-atscale/ExtractQueriesFromAtScaleOperation.js";
import { ExecuteAtScaleQueryHarnessOperation } from "./execute-atscale-query-harness/ExecuteAtScaleQueryHarnessOperation.js";
import { GenerateAtScaleInstallYamlOperation } from "./generate-atscale-install-yaml/GenerateAtScaleInstallYamlOperation.js";
import { AtScaleListDataSourcesOperation } from "./atscale-list-data-sources/AtScaleListDataSourcesOperation.js";
import { AtScaleCreateDataSourceOperation } from "./atscale-create-data-source/AtScaleCreateDataSourceOperation.js";
import { AtScaleListReposOperation } from "./atscale-list-repos/AtScaleListReposOperation.js";
import { AtScaleCreateRepoOperation } from "./atscale-create-repo/AtScaleCreateRepoOperation.js";
import { AtScaleListDeploymentsOperation } from "./atscale-list-deployments/AtScaleListDeploymentsOperation.js";
import { AtScaleDeployModelOperation } from "./atscale-deploy-model/AtScaleDeployModelOperation.js";
import { AtScaleListModelErrorsOperation } from "./atscale-list-model-errors/AtScaleListModelErrorsOperation.js";
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
  const services = await buildServiceRegistry({ ...serviceOptions, logger });
  const registry = new OperationRegistry();
  registry.register(new EchoOperation(services, logger));
  registry.register(new ToggleOperation(services, logger));
  registry.register(new ExtractAtScaleModelOperation(services, logger));
  registry.register(new GeneratePowerBIFromNamespaceOperation(services, logger));
  registry.register(new GenerateTableauFromNamespaceOperation(services, logger));
  registry.register(new EchoConnectionMetaDataOperation(services, logger));
  registry.register(new PythonHelloWorldOperation(services, logger));
  registry.register(new GenerateSMLFromConnectionOperation(services, logger));
  registry.register(new GenerateSMLFromDDLOperation(services, logger));
  registry.register(new ExtractModelFromSMLOperation(services, logger));
  registry.register(new GenerateNamespaceFromModelOperation(services, logger));
  registry.register(new ExecuteSQLOnConnectionOperation(services, logger));
  registry.register(new ExtractDDLFromConnectionOperation(services, logger));
  registry.register(new GenerateExcelFromNamespaceOperation(services, logger));
  registry.register(new ExtractQueryStatsFromAtScaleOperation(services, logger));
  registry.register(new ExtractQueriesFromAtScaleOperation(services, logger));
  registry.register(new ExecuteAtScaleQueryHarnessOperation(services, logger));
  registry.register(new GenerateAtScaleInstallYamlOperation(services, logger));
  registry.register(new AtScaleListDataSourcesOperation(services, logger));
  registry.register(new AtScaleCreateDataSourceOperation(services, logger));
  registry.register(new AtScaleListReposOperation(services, logger));
  registry.register(new AtScaleCreateRepoOperation(services, logger));
  registry.register(new AtScaleListDeploymentsOperation(services, logger));
  registry.register(new AtScaleDeployModelOperation(services, logger));
  registry.register(new AtScaleListModelErrorsOperation(services, logger));
  return registry;
}
