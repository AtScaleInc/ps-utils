/**
 * Extract AtScale model metadata and serialize it into YAML.
 */
import { Operation } from "../Operation.js";
import { ParameterSet, StringParameter } from "../../Parameters.js";
import type { ServiceRegistry } from "../../services/registry.js";
import type { Logger } from "../../logging.js";
import { YamlService } from "../../services/YamlService.js";
import axios from 'axios';
import { Parser } from 'xml2js';
import { stringify } from "yaml";

class ExtractAtScaleParameterSet extends ParameterSet {
  parameters = [
    new (class extends StringParameter {
      name = "model";
      description = "AtScale model identifier";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "connection-file";
      description = "Path to connection file";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "connection-name";
      description = "Connection name";
      required = true;
    })(),
    new (class extends StringParameter {
      name = "output-model-file";
      description = "Output file path for extracted model";
      required = false;
    })(),
  ];
}

type ExtractAtScaleParams = {
  model: string;
  "connection-file": string;
  "connection-name": string;
  "output-model-file"?: string;
};
export type ExtractModelFromAtScaleParams = ExtractAtScaleParams;

/**
 * Stub operation for extracting an AtScale model.
 */
export class ExtractAtScaleModelOperation extends Operation<ExtractAtScaleParams> {
  name = "extract-model-from-atscale";
  description = "Extract an AtScale model (stub)";
  parameters = new ExtractAtScaleParameterSet();

  constructor(services: ServiceRegistry, logger: Logger) {
    super(services, logger);
  }

  // --- Lookups ---
  aggTypeLookup: Record<number, string> = {
    1: "sum", 5: "avg", 4: "max", 3: "min", 8: "count",
    1000: "count", 2: "count", 7: "std", 333: "std",
    0: "var", 6: "var", 9: "calculated"
  };

  dataTypeLookup: Record<number, string> = {
    0: "EMPTY", 16: "INT1", 2: "INT2", 3: "INT4", 20: "INT8",
    17: "INT_UNSIGNED1", 18: "INT_UNSIGNED2", 19: "INT_UNSIGNED4",
    21: "INT_UNSIGNED8", 4: "FLOAT32", 5: "FLOAT64", 6: "CURRENCY",
    7: "DATE_DOUBLE", 8: "BSTR", 11: "BOOL", 14: "DECIMAL",
    72: "GUID", 128: "BYTES", 129: "STRING", 130: "WSTR",
    131: "NUMERIC", 133: "DATE", 134: "TIME", 135: "DATETIME"
  };

  /**
   * Gets the Bearer Token from AtScale
   */
  async getToken(
    installer: boolean,
    atscaleUrl: string,
    organizationId: string,
    username: string,
    password: string
  ): Promise<any> {
    try {
      if (installer) {
        const url = `${atscaleUrl}:10500/${organizationId}/auth`;
        this.logger.verbose("Auth URL: " + atscaleUrl);

        const response = await axios.get(url, {
          auth: { username, password }
        });
        return response.data;
      } else {
        const url = `${atscaleUrl}/auth/realms/atscale/protocol/openid-connect/token`;
        this.logger.verbose("Auth URL: " + url);

        const params = new URLSearchParams();
        params.append('client_id', 'atscale-ai-link');
        params.append('grant_type', 'password');
        params.append('username', username);
        params.append('password', password);

        const response = await axios.post(url, params);
        return response.data.access_token;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Authentication failed:", message);
      throw error;
    }
  }

  /**
   * Executes a DMV Query via XMLA
   */
  async getDmvData(
    token: string,
    installer: boolean,
    atscaleUrl: string,
    statement: string,
    organizationId: string,
    catalogName: string,
    modelName: string
  ): Promise<any[]> {
    this.logger.verbose("XMLA Request Data: " + atscaleUrl);

    const data = `<?xml version="1.0" encoding="UTF-8"?>
    <Envelope xmlns="http://schemas.xmlsoap.org/soap/envelope/">
        <Body>
            <Execute xmlns="urn:schemas-microsoft-com:xml-analysis">
                <Command><Statement>${statement}</Statement></Command>
                <Properties>
                    <PropertyList><Catalog>${catalogName}</Catalog></PropertyList>
                </Properties>
                <Parameters>
                    <Parameter>
                        <Name>CubeName</Name>
                        <Value>${modelName}</Value>
                    </Parameter>
                </Parameters>
            </Execute>
        </Body>
    </Envelope>`;


    const xmlaUrl = installer
      ? `${atscaleUrl}:10502/xmla/${organizationId}`
      : `${atscaleUrl}/engine/xmla`;

    const response = await axios.post(xmlaUrl, data, {
      headers: {
        'Content-Type': 'text/xml',
        'Authorization': `Bearer ${token}`
      }
    });

    // Parse XML response to JSON for easier handling
    const parser = new Parser({ explicitArray: false, ignoreAttrs: true });
    const result: any = await parser.parseStringPromise(response.data);

    // Drill down to the row objects
    // Note: Structure depends on AtScale SOAP response, usually under Body -> ExecuteResponse -> return -> root -> row
    try {
      const rows = result['soap:Envelope']['soap:Body']['ExecuteResponse']['return']['root']['row'];
      return Array.isArray(rows) ? rows : [rows];
    } catch (e) {
      return [];
    }
  }

  /**
   * Retrieves Metrics
   */
  async getMetrics(
    token: string,
    installer: boolean,
    atscaleUrl: string,
    organizationId: string,
    catalogName: string,
    modelName: string
  ): Promise<any[]> {
    const statement = "SELECT MEASURE_NAME, DATA_TYPE, MEASURE_CAPTION, MEASURE_AGGREGATOR, MEASURE_DISPLAY_FOLDER, DEFAULT_FORMAT_STRING, DESCRIPTION FROM $system.MDSCHEMA_MEASURES WHERE [CUBE_NAME] = @CubeName";
    const rows = await this.getDmvData(token, installer, atscaleUrl, statement, organizationId, catalogName, modelName);

    this.logger.verbose("Metric Rows: " + rows);
    return rows ? rows.map((row) => {
      if (!row) return null;
      let aggType = parseInt(row.MEASURE_AGGREGATOR);
      if (aggType === 9) aggType = 1;

      return {
        query_name: row.MEASURE_NAME,
        caption: row.MEASURE_CAPTION,
        agg_type: aggType,
        agg_type_string: this.aggTypeLookup[aggType] || "unknown",
        format_string: row.DEFAULT_FORMAT_STRING || "",
        description: row.DESCRIPTION || "",
        data_type: parseInt(row.DATA_TYPE),
        data_type_string: this.dataTypeLookup[parseInt(row.DATA_TYPE)] || "unknown",
        folder: row.MEASURE_DISPLAY_FOLDER || ""
      };
    }) : [];
  }

  /**
   * Retrieves Attributes and Hierarchies
   */
  async getAttributes(
    token: string,
    installer: boolean,
    atscaleUrl: string,
    organizationId: string,
    catalogName: string,
    modelName: string
  ): Promise<Record<string, any>> {
    const levelStatement = "SELECT LEVEL_NAME, HIERARCHY_UNIQUE_NAME, LEVEL_NUMBER, LEVEL_CAPTION, DESCRIPTION, LEVEL_DBTYPE FROM $system.MDSCHEMA_LEVELS WHERE [CUBE_NAME] = @CubeName and [LEVEL_NAME] &lt;&gt; '(All)' and [DIMENSION_UNIQUE_NAME] &lt;&gt; '[Measures]'";
    const hierStatement = "SELECT HIERARCHY_UNIQUE_NAME, HIERARCHY_DISPLAY_FOLDER FROM $system.MDSCHEMA_HIERARCHIES WHERE [CUBE_NAME] = @CubeName";

    const [levelRows, hierRows] = await Promise.all([
      this.getDmvData(token, installer, atscaleUrl, levelStatement, organizationId, catalogName, modelName),
      this.getDmvData(token, installer, atscaleUrl, hierStatement, organizationId, catalogName, modelName)
    ]);

    const folderLookup: Record<string, string> = {};
    hierRows.forEach(row => {
      if (!row) return null;
      folderLookup[row.HIERARCHY_UNIQUE_NAME] = row.HIERARCHY_DISPLAY_FOLDER || "";
    });

    const attributes: Record<string, Record<string, any[]>> = {};

    levelRows.forEach(row => {
      if (!row) return;
      const hUniqueName = row.HIERARCHY_UNIQUE_NAME;
      const folder = folderLookup[hUniqueName] || "";

      // Extract Dimension and Hierarchy names from [Dim].[Hier] format
      const parts = hUniqueName.match(/\[(.*?)\]\.\[(.*?)\]/);
      const dimensionName = parts ? parts[1] : hUniqueName;
      const hierarchyName = parts ? parts[2] : hUniqueName;

      const level = {
        query_name: row.LEVEL_NAME,
        caption: row.LEVEL_CAPTION,
        level_number: parseInt(row.LEVEL_NUMBER),
        description: row.DESCRIPTION || "",
        //            data_type: parseInt(row.LEVEL_DBTYPE || 130),
        data_type_string: this.dataTypeLookup[parseInt(row.LEVEL_DBTYPE || 130)],
        folder: folder
      };

      if (!attributes[dimensionName]) attributes[dimensionName] = {};
      if (!attributes[dimensionName][hierarchyName]) attributes[dimensionName][hierarchyName] = [];

      attributes[dimensionName][hierarchyName].push(level);
    });

    return attributes;
  }


  convertToSQL(tableName: string, mdxObjects: any) {
    const sqlObjects: Record<string, any> = {};
    (mdxObjects.metrics || []).forEach((objType: any) => {
      if (!objType) return;
      sqlObjects[objType.query_name] = {};
      sqlObjects[objType.query_name]["alias"] = false;
      sqlObjects[objType.query_name]["name"] = objType.query_name;
      sqlObjects[objType.query_name]["data_type"] = objType.data_type_string;
      sqlObjects[objType.query_name]["label"] = objType.caption;
      sqlObjects[objType.query_name]["description"] = objType.description;
      sqlObjects[objType.query_name]["role"] = "measure";
      sqlObjects[objType.query_name]["type"] = "quantitative";
      sqlObjects[objType.query_name]["aggregation"] = objType.agg_type_string;
      sqlObjects[objType.query_name]["folder"] = objType.folder;
    });
    
    Object.keys(mdxObjects.attributes || {}).forEach((attributeName) => {
      const attribute = mdxObjects.attributes[attributeName];
      Object.keys(attribute || {}).forEach((hierarchyName) => {
        const hierarchy = attribute[hierarchyName];
        hierarchy.forEach((level: any) => {
          sqlObjects[level.query_name] = {};
          sqlObjects[level.query_name]["alias"] = false;
          sqlObjects[level.query_name]["name"] = level.query_name;
          sqlObjects[level.query_name]["data_type"] = level.data_type_string;
          sqlObjects[level.query_name]["label"] = level.caption;
          sqlObjects[level.query_name]["description"] = level.description;
          sqlObjects[level.query_name]["role"] = "dimension";
          sqlObjects[level.query_name]["type"] = "nominal";
          sqlObjects[level.query_name]["folder"] = level.folder;
        });
      });
    });

    return { table_name: tableName, columns: sqlObjects };
  }


  async run(_params: ExtractAtScaleParams): Promise<void> {
    this.logger.verbose("ExtractAtScaleModelOperation stub invoked.");

    this.logger.info("Reading connection file " + _params["connection-file"]);
    const yaml = this.services.get<YamlService>("yaml");
    const connectionFile = yaml.readFromFile<any>(_params["connection-file"]);


    this.logger.info("Authenticating against connection named " + _params["connection-name"]);
    this.logger.verbose("Connection detail: " + JSON.stringify(connectionFile.connections[_params["connection-name"]]));

    const connection = connectionFile.connections?.[_params["connection-name"]];
    if (!connection) {
      throw new Error(
        `Connection '${_params["connection-name"]}' not found in ${_params["connection-file"]}`,
      );
    }
    if (!connection.mdx) {
      throw new Error(
        `Connection '${_params["connection-name"]}' is missing an 'mdx:' block in ${_params["connection-file"]}`,
      );
    }
    const user = (connectionFile.users ?? {})[connection.mdx.user] ?? {};
    this.logger.verbose("User detail: " + user.username);
    const token = await this.getToken(connection.installer,
      connection.mdx.url,
      connection.mdx.organization_id, user.username, user.password);


    this.logger.info("Fetching Metrics...");
    const metrics = await this.getMetrics(token, connection.installer,
      connection.mdx.url,
      connection.mdx.organization_id,
      connection.mdx.catalog_name,
      _params.model);

    this.logger.info("Fetching Attributes...");
    const attributes = await this.getAttributes(token, connection.installer,
      connection.mdx.url,
      connection.mdx.organization_id,
      connection.mdx.catalog_name,
      _params.model);

    const output = { metrics, attributes };

    const models: Record<string, any> = {};
    models[_params.model] = {};
    models[_params.model]["data_source"] = _params["connection-name"];
    models[_params.model]["mdx"] = output;
    models[_params.model]["sql"] = this.convertToSQL(_params.model, output);

    // console.log(yaml.dump(models, { noRefs: true, quotingType: '"' }));



    const outputYaml = stringify(models);
    if (_params["output-model-file"] && _params["output-model-file"].trim().length > 0) {
      yaml.saveToFile(_params["output-model-file"], models);
      this.logger.info(`Wrote model output to ${_params["output-model-file"]}`);
      return;
    }

    this.logger.log(outputYaml);

  }
}
