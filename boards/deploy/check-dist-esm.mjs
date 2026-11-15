// After `pnpm build`: every ESM package in packages/* must load under plain Node, as it does in the image.
// Vitest and typecheck resolve "./x" to x.ts, plain Node does not: ESM adds no ".js" and no "/index.js".
// 1. Static, all files: each relative specifier in dist/**/*.{js,mjs} names an existing file.
// 2. Runtime, library entries only ("exports" and "main"; bins are not run): import() has no error.
// Usage (from boards/): node deploy/check-dist-esm.mjs [packages dir]. Exit 1 lists each problem.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(
  process.argv[2] ?? join(import.meta.dirname, "..", "packages"),
);
const SPEC =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"'\n]*)\1/g;
const problems = [];
let checked = 0;

function* jsFiles(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* jsFiles(path);
    else if (/\.m?js$/.test(name)) yield path;
  }
}

function entries(exp, main) {
  const out = new Set(main ? [join(main)] : []);
  const walk = (value) => {
    if (typeof value === "string") {
      if (/\.m?js$/.test(value)) out.add(join(value));
    } else if (value && typeof value === "object") {
      for (const [key, sub] of Object.entries(value))
        if (key !== "types") walk(sub);
    }
  };
  walk(exp);
  return [...out];
}

const isFile = (path) => existsSync(path) && statSync(path).isFile();

for (const name of readdirSync(root).sort()) {
  const dir = join(root, name);
  const manifest = join(dir, "package.json");
  if (!isFile(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  if (pkg.type !== "module") continue;
  const dist = join(dir, "dist");
  if (existsSync(dist)) {
    for (const file of jsFiles(dist)) {
      checked++;
      for (const m of readFileSync(file, "utf8").matchAll(SPEC)) {
        if (!isFile(resolve(dirname(file), m[2]))) {
          problems.push(
            `${name}/${relative(dir, file)}: "${m[2]}" names no file`,
          );
        }
      }
    }
  }
  for (const entry of entries(pkg.exports, pkg.main)) {
    try {
      await import(pathToFileURL(join(dir, entry)).href);
    } catch (err) {
      problems.push(
        `${name}/${entry}: import fails: ${err.code ?? ""} ${String(err.message).split("\n")[0]}`,
      );
    }
  }
}

if (problems.length) {
  console.error(`dist ESM check: ${problems.length} problem(s) in ${root}`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    'Fix: write relative imports with ".js" (module and moduleResolution "NodeNext" make tsc enforce it).',
  );
  process.exit(1);
}
console.log(`dist ESM check: ok, ${checked} files`);
process.exit(0); // an imported entry may keep a handle open
