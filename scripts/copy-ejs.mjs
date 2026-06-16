import fs from "fs/promises";
import path from "path";

const srcRoot = path.resolve("src");
const distRoot = path.resolve("dist");

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(fullPath)));
    } else if (entry.isFile() && (entry.name.endsWith(".ejs") || entry.name.endsWith(".py"))) {
      files.push(fullPath);
    }
  }
  return files;
}

async function main() {
  const files = await walk(srcRoot);
  await Promise.all(
    files.map(async (file) => {
      const rel = path.relative(srcRoot, file);
      const dest = path.join(distRoot, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(file, dest);
    })
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
