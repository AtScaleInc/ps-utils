/**
 * Read connection names from a ps-utils connections file.
 *
 * The connections YAML holds named entries under a top-level `connections:` map;
 * each key is a connection name (see example/connections.yaml). We return those
 * keys to populate the `--connection-name` dropdown.
 */
import * as fs from "fs";
import { parse } from "yaml";

export function readConnectionNames(filePath: string | undefined): string[] {
  if (!filePath || !filePath.trim()) return [];
  try {
    const doc = parse(fs.readFileSync(filePath, "utf8")) as unknown;
    const conns = (doc as { connections?: unknown } | null)?.connections;
    if (conns && typeof conns === "object" && !Array.isArray(conns)) {
      return Object.keys(conns as Record<string, unknown>);
    }
    return [];
  } catch {
    // Missing, unreadable, or invalid YAML — fall back to a free-text field.
    return [];
  }
}
