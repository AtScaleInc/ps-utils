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
