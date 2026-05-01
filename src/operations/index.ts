/**
 * Operation registry entrypoint.
 */
import { ExtractAtScaleModelOperation } from "./extract-model-from-atscale/ExtractAtScaleModelOperation.js";
import { GeneratePowerBIFromNamespaceOperation } from "./generate-powerbi-from-namespace/GeneratePowerBIFromNamespaceOperation.js";
import { GenerateNotebookFromConnectionOperation } from "./generate-notebook-from-connection/GenerateNotebookFromConnectionOperation.js";
import { GenerateTableauFromNamespaceOperation } from "./generate-tableau-from-namespace/GenerateTableauFromNamespaceOperation.js";
import { EchoConnectionMetaDataOperation } from "./sql/EchoConnectionMetaDataOperation.js";
import { GenerateSMLFromConnectionOperation } from "./generate-sml-from-connection/GenerateSMLFromConnectionOperation.js";
import { GenerateSMLFromDDLOperation } from "./generate-sml-from-ddl/GenerateSMLFromDDLOperation.js";
import { GenerateSMLFromXMLOperation } from "./generate-sml-from-xml/GenerateSMLFromXMLOperation.js";
import { ExtractModelFromSMLOperation } from "./extract-model-from-sml/ExtractModelFromSMLOperation.js";
import { GenerateNamespaceFromModelOperation } from "./generate-namespace-from-model/GenerateNamespaceFromModelOperation.js";
import { GenerateMetricsFromModelOperation } from "./generate-metrics-from-model/GenerateMetricsFromModelOperation.js";
import { ExecuteSQLOnConnectionOperation } from "./execute-sql-on-connection/ExecuteSQLOnConnectionOperation.js";
import { ExtractDDLFromConnectionOperation } from "./extract-ddl-from-connection/ExtractDDLFromConnectionOperation.js";
import { GenerateExcelFromNamespaceOperation } from "./generate-excel-from-namespace/GenerateExcelFromNamespaceOperation.js";
import { ExtractQueryStatsFromAtScaleOperation } from "./extract-query-stats-from-atscale/ExtractQueryStatsFromAtScaleOperation.js";
import { ExtractQueriesFromAtScaleOperation } from "./extract-queries-from-atscale/ExtractQueriesFromAtScaleOperation.js";
import { ExecuteAtScaleQueryHarnessOperation } from "./execute-atscale-query-harness/ExecuteAtScaleQueryHarnessOperation.js";
import { ExecuteQueryOnConnectionOperation } from "./execute-query-on-connection/ExecuteQueryOnConnectionOperation.js";
import { GenerateAtScaleInstallYamlOperation } from "./generate-atscale-install-yaml/GenerateAtScaleInstallYamlOperation.js";
import { AtScaleListDataSourcesOperation } from "./atscale-list-data-sources/AtScaleListDataSourcesOperation.js";
import { AtScaleCreateDataSourceOperation } from "./atscale-create-data-source/AtScaleCreateDataSourceOperation.js";
import { AtScaleListReposOperation } from "./atscale-list-repos/AtScaleListReposOperation.js";
import { AtScaleCreateRepoOperation } from "./atscale-create-repo/AtScaleCreateRepoOperation.js";
import { AtScaleListDeploymentsOperation } from "./atscale-list-deployments/AtScaleListDeploymentsOperation.js";
import { AtScaleDeployCatalogOperation } from "./atscale-deploy-catalog/AtScaleDeployCatalogOperation.js";
import { AtScaleListModelErrorsOperation } from "./atscale-list-model-errors/AtScaleListModelErrorsOperation.js";
import { GenerateDDLFromAtScaleOperation } from "./generate-ddl-from-atscale/GenerateDDLFromAtScaleOperation.js";
import { ExtractDataShapeFromConnectionOperation } from "./extract-data-shape-from-connection/ExtractDataShapeFromConnectionOperation.js";
import { GenerateDDLFromDataShapeOperation } from "./generate-ddl-from-data-shape/GenerateDDLFromDataShapeOperation.js";
import { GenerateDataFromDataShapeOperation } from "./generate-data-from-data-shape/GenerateDataFromDataShapeOperation.js";
import { GenerateDataFromDataShapeToConnectionOperation } from "./generate-data-from-data-shape-to-connection/GenerateDataFromDataShapeToConnectionOperation.js";
import { GenerateEnhancedQueryResultsOperation } from "./generate-enhanced-query-results/GenerateEnhancedQueryResultsOperation.js";
import { ExecuteRunAnalysisOperation } from "./execute-run-analysis/ExecuteRunAnalysisOperation.js";
import { GenerateQueriesFromSMLOperation } from "./generate-queries-from-sml/GenerateQueriesFromSMLOperation.js";
import { GenerateQueriesFromModelOperation } from "./generate-queries-from-model/GenerateQueriesFromModelOperation.js";
import { GenerateSharedModelPlanOperation } from "./generate-shared-model-plan/GenerateSharedModelPlanOperation.js";
import { GenerateSharedDesignOperation } from "./generate-shared-design/GenerateSharedDesignOperation.js";
import { ExecuteWebServicesOperation } from "./execute-web-services/ExecuteWebServicesOperation.js";
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
  registry.register(new ExtractAtScaleModelOperation(services, logger));
  registry.register(new GeneratePowerBIFromNamespaceOperation(services, logger));
  registry.register(new GenerateNotebookFromConnectionOperation(services, logger));
  registry.register(new GenerateTableauFromNamespaceOperation(services, logger));
  registry.register(new EchoConnectionMetaDataOperation(services, logger));
  registry.register(new GenerateSMLFromConnectionOperation(services, logger));
  registry.register(new GenerateSMLFromDDLOperation(services, logger));
  registry.register(new GenerateSMLFromXMLOperation(services, logger));
  registry.register(new GenerateSharedModelPlanOperation(services, logger));
  registry.register(new GenerateSharedDesignOperation(services, logger));
  registry.register(new ExtractModelFromSMLOperation(services, logger));
  registry.register(new GenerateNamespaceFromModelOperation(services, logger));
  registry.register(new GenerateMetricsFromModelOperation(services, logger));
  registry.register(new ExecuteSQLOnConnectionOperation(services, logger));
  registry.register(new ExtractDDLFromConnectionOperation(services, logger));
  registry.register(new GenerateExcelFromNamespaceOperation(services, logger));
  registry.register(new ExtractQueryStatsFromAtScaleOperation(services, logger));
  registry.register(new ExtractQueriesFromAtScaleOperation(services, logger));
  registry.register(new ExecuteAtScaleQueryHarnessOperation(services, logger));
  registry.register(new ExecuteQueryOnConnectionOperation(services, logger));
  registry.register(new GenerateAtScaleInstallYamlOperation(services, logger));
  registry.register(new AtScaleListDataSourcesOperation(services, logger));
  registry.register(new AtScaleCreateDataSourceOperation(services, logger));
  registry.register(new AtScaleListReposOperation(services, logger));
  registry.register(new AtScaleCreateRepoOperation(services, logger));
  registry.register(new AtScaleListDeploymentsOperation(services, logger));
  registry.register(new AtScaleDeployCatalogOperation(services, logger));
  registry.register(new AtScaleListModelErrorsOperation(services, logger));
  registry.register(new GenerateDDLFromAtScaleOperation(services, logger));
  registry.register(new ExtractDataShapeFromConnectionOperation(services, logger));
  registry.register(new GenerateDDLFromDataShapeOperation(services, logger));
  registry.register(new GenerateDataFromDataShapeOperation(services, logger));
  registry.register(new GenerateDataFromDataShapeToConnectionOperation(services, logger));
  registry.register(new GenerateEnhancedQueryResultsOperation(services, logger));
  registry.register(new ExecuteRunAnalysisOperation(services, logger));
  registry.register(new GenerateQueriesFromSMLOperation(services, logger));
  registry.register(new GenerateQueriesFromModelOperation(services, logger));
  // execute-web-services receives the registry itself so it can build the schema
  // dynamically without a circular import back to this file.
  registry.register(new ExecuteWebServicesOperation(services, logger, registry));
  return registry;
}
