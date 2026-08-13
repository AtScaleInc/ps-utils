/**
 * Runtime asset resolution for operations that read templates from disk.
 *
 * Two layouts must both work:
 *
 *   dist/    — `npm run build` output: one directory per operation with its
 *              `.ejs` templates sitting beside the compiled JS. The directory
 *              is derived from the calling module's own `import.meta.url`.
 *
 *   bundle/  — the single-file esbuild bundle the VS Code extension ships (see
 *              `src/scripts/bundle-cli.ts`). A bundle has no per-module URL, so
 *              the build injects `__PS_UTILS_BUNDLE_DIR__` and copies templates
 *              to `<bundle>/operations/<operation-name>/`.
 *
 * `import.meta.url` must never be *evaluated* in the bundled build: esbuild's
 * cjs output leaves `import.meta` as an empty object, and `fileURLToPath`
 * throws `ERR_INVALID_ARG_TYPE` on the resulting `undefined`. That is why the
 * URL is passed as a thunk rather than a value — in the bundle the thunk is
 * created but never called.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Directory of the running bundle, injected by the esbuild banner. Absent in dist builds. */
function bundleDir(): string | undefined {
  const dir = (globalThis as Record<string, unknown>)["__PS_UTILS_BUNDLE_DIR__"];
  return typeof dir === "string" && dir ? dir : undefined;
}

/** True when running from the single-file bundle rather than the dist tree. */
export function isBundled(): boolean {
  return bundleDir() !== undefined;
}

/**
 * Directory holding one operation's template assets.
 *
 * @param metaUrl  Thunk returning the calling module's `import.meta.url`.
 *                 Always pass `() => import.meta.url`, never the value.
 * @param opName   The operation's directory name under `src/operations/`.
 */
export function operationAssetDir(metaUrl: () => string, opName: string): string {
  const bundled = bundleDir();
  if (bundled) return path.join(bundled, "operations", opName);
  return path.dirname(fileURLToPath(requireUrl(metaUrl(), opName)));
}

/**
 * Guard the one way this can fail silently: a bundle built without the banner
 * would fall through to the dist branch with an empty `import.meta`, and
 * `fileURLToPath(undefined)` reports only `ERR_INVALID_ARG_TYPE`.
 */
function requireUrl(url: string | undefined, what: string): string {
  if (!url) {
    throw new Error(
      `Cannot resolve assets for '${what}': import.meta.url is unavailable and ` +
        "__PS_UTILS_BUNDLE_DIR__ is not set. A bundled build must inject it — see src/scripts/bundle-cli.ts.",
    );
  }
  return url;
}

/**
 * The package version. The bundle has no `package.json` to walk up to, so the
 * build injects the value; dist builds read the file as before.
 */
export function packageVersion(metaUrl: () => string): { name: string; version: string } {
  const injected = (globalThis as Record<string, unknown>)["__PS_UTILS_VERSION__"];
  if (typeof injected === "string" && injected) {
    const at = injected.lastIndexOf("@");
    return { name: injected.slice(0, at), version: injected.slice(at + 1) };
  }
  const base = path.dirname(fileURLToPath(requireUrl(metaUrl(), "package version")));
  const pkgPath = path.resolve(base, "../../../package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { name: string; version: string };
  return { name: pkg.name, version: pkg.version };
}
