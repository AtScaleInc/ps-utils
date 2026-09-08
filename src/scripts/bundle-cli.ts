/**
 * Bundle the CLI into the VS Code extension.
 *
 * The extension ships its own copy of ps-utils so the two can never be version
 * mismatched on a client machine — there is deliberately no setting to point at
 * an external CLI. A full production `node_modules` would be ~185 MB, so the
 * CLI is bundled to a single file with esbuild instead (~12 MB, ~4 MB packed).
 *
 * Two things make the bundle work, and both are load-bearing:
 *
 *   1. **cjs, not esm.** The esm output fails at import time on `form-data`'s
 *      `require("util")` — esbuild cannot turn a dynamic require into an esm
 *      import. The cjs output resolves it natively.
 *
 *   2. **`__PS_UTILS_BUNDLE_DIR__`.** A bundle has no per-module
 *      `import.meta.url`, so operations resolve their `.ejs` templates through
 *      `src/assets.ts` against this banner-injected directory instead. The
 *      templates are copied next to the bundle here.
 *
 * Run via `npm run bundle:cli`; part of `npm run build`.
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const OUT_DIR = path.join(ROOT, "vscode-extension", "cli");

type Pkg = { name: string; version: string };
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as Pkg;

/** Copy every operation's runtime template assets to <out>/operations/<op>/. */
function copyTemplates(): number {
  const srcOps = path.join(ROOT, "src", "operations");
  let copied = 0;
  for (const opDir of fs.readdirSync(srcOps)) {
    const from = path.join(srcOps, opDir);
    if (!fs.statSync(from).isDirectory()) continue;
    const assets = fs.readdirSync(from).filter((f) => f.endsWith(".ejs") || f.endsWith(".py"));
    if (assets.length === 0) continue;
    const to = path.join(OUT_DIR, "operations", opDir);
    fs.mkdirSync(to, { recursive: true });
    for (const asset of assets) {
      fs.copyFileSync(path.join(from, asset), path.join(to, asset));
      copied += 1;
    }
  }
  return copied;
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const outfile = path.join(OUT_DIR, "cli.cjs");

  await build({
    entryPoints: [path.join(ROOT, "dist", "cli.js")],
    outfile,
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    // pg-native is an optional peer of pg; it is never installed here and
    // requiring it would fail the bundle.
    external: ["pg-native"],
    banner: {
      js: [
        "globalThis.__PS_UTILS_BUNDLE_DIR__ = __dirname;",
        `globalThis.__PS_UTILS_VERSION__ = ${JSON.stringify(`${pkg.name}@${pkg.version}`)};`,
      ].join("\n"),
    },
    // Every `import.meta.url` in the tree is inside a thunk that the bundled
    // build never calls (see src/assets.ts), so esbuild's empty-import-meta
    // warning is expected here and only hides real warnings. `assets.ts` throws
    // a named error if one ever is evaluated.
    logOverride: { "empty-import-meta": "silent" },
    logLevel: "warning",
  });

  const templates = copyTemplates();
  const bytes = fs.statSync(outfile).size;

  fs.writeFileSync(
    path.join(OUT_DIR, "BUNDLE.json"),
    JSON.stringify({ name: pkg.name, version: pkg.version, entry: "cli.cjs" }, null, 2) + "\n",
  );

  console.log(
    `Bundled ${pkg.name}@${pkg.version} → vscode-extension/cli/cli.cjs ` +
      `(${(bytes / 1024 / 1024).toFixed(1)} MB, ${templates} template asset(s))`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
