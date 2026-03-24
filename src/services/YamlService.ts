import fs from "fs";
import yaml, { dump } from "js-yaml";
import { ServiceProvider } from "./ServiceProvider.js";

/**
 * YAML file read/write service.
 */
export class YamlService extends ServiceProvider {
  name = "yaml";

  /**
   * Read a YAML file and parse it into an object.
   */
  readFromFile<T = unknown>(path: string): T {
    return yaml.load(fs.readFileSync(path, 'utf8')) as T;
  }

  /**
   * Augment model data with aliases from an aliases file.
   *
   * The aliases file is a flat YAML map of aliasName → originalColumnKey.
   *
   * For each model in modelData:
   *   - sql.columns  is preserved and extended: alias entries are added as copies
   *                  of the column they point to, so namespaces can reference
   *                  either the original column key or any alias name.
   *   - sql.rawColumns is added as a snapshot of the original sql.columns before
   *                  aliases are merged in.
   *   - aliases      is set to the aliasesData map for downstream inspection.
   *
   * If an alias points to a column that does not exist in the model the entry is
   * silently skipped.
   *
   * Returns a new object; the inputs are not mutated.
   */
  augmentModelData(
    modelData: Record<string, unknown>,
    aliasesData: Record<string, unknown> | null,
  ): Record<string, unknown> {
    if (!aliasesData) return modelData;

    // The aliases file is a flat aliasName → originalColumnKey map.
    const allAliases = aliasesData as Record<string, string>;

    const result: Record<string, unknown> = {};

    for (const [modelName, modelValue] of Object.entries(modelData)) {
      if (!modelValue || typeof modelValue !== "object") {
        result[modelName] = modelValue;
        continue;
      }

      const model      = modelValue as Record<string, unknown>;
      const sql        = (model["sql"] ?? {}) as Record<string, unknown>;
      const columns    = (sql["columns"] ?? {}) as Record<string, unknown>;
      const rawColumns = { ...columns };

      // Build merged columns: originals + one copy per alias
      const mergedColumns: Record<string, unknown> = { ...columns };
      for (const [aliasName, originalKey] of Object.entries(allAliases)) {
        if (rawColumns[originalKey] !== undefined) {
          mergedColumns[aliasName] = rawColumns[originalKey];
        }
      }

      result[modelName] = {
        ...model,
        aliases: aliasesData,
        sql: {
          ...sql,
          rawColumns,
          columns: mergedColumns,
        },
      };
    }

    return result;
  }


  /**
   * Serialize data to YAML and save it to a file.
   */
  dump(models: Record<string, any> , opts?: yaml.DumpOptions | undefined): string {
    return yaml.dump(models, opts);
  }

  /**
   * Serialize data to YAML and save it to a file.
   */
  saveToFile(path: string, data: Record<string, any>): void {
    const contents = this.dump(data,{ noRefs: true, quotingType: '"' });
    fs.writeFileSync(path, contents, "utf8");
  }
}
