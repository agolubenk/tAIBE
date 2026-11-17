// Static, no docker build: each Dockerfile stage that copies apps/<app> also copies every workspace package the app
// needs, direct or through another package (dependencies and devDependencies with "workspace:").
// The walk goes through packages/* only: a package that names an app (libs -> @kaneo/api) uses its types, and the
// stage does not build that app. A missing package fails only in `docker build`, which CI does not run
// (TB-234: web-builder without @kaneo/forms).
// Only COPY of the whole directory counts (`COPY packages/forms ./packages/forms`); a COPY of package.json does not.
// Usage (from boards/): node deploy/check-dockerfile-deps.mjs [boards dir] [Dockerfile]. Exit 1 lists each problem.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? join(import.meta.dirname, ".."));
const dockerfile = resolve(root, process.argv[3] ?? "Dockerfile.kaneo");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const workspaceDeps = (pkg) =>
  Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter(([, version]) => String(version).startsWith("workspace:"))
    .map(([name]) => name);

// Workspace packages: name -> { dir, deps }.
const packages = new Map();
for (const group of ["packages", "apps"]) {
  const base = join(root, group);
  if (!existsSync(base)) continue;
  for (const dir of readdirSync(base).sort()) {
    const file = join(base, dir, "package.json");
    if (!existsSync(file)) continue;
    const pkg = readJson(file);
    if (pkg.name)
      packages.set(pkg.name, {
        dir: `${group}/${dir}`,
        deps: workspaceDeps(pkg),
      });
  }
}

const norm = (path) => path.replace(/^\.\//, "").replace(/\/+$/, "");

// Stages: name and the sources of each COPY without --from (continuation lines joined).
const stages = [];
const lines = readFileSync(dockerfile, "utf8")
  .replace(/\\\r?\n/g, " ")
  .split(/\r?\n/);
for (const line of lines) {
  const words = line.trim().split(/\s+/);
  const op = words[0]?.toUpperCase();
  if (op === "FROM") {
    const as = words.findIndex((w) => w.toUpperCase() === "AS");
    stages.push({
      name: as > 0 ? words[as + 1] : `#${stages.length}`,
      copied: new Set(),
    });
  } else if (op === "COPY" && stages.length) {
    const args = words.slice(1).filter((w) => !w.startsWith("--"));
    if (words.slice(1).some((w) => w.startsWith("--from="))) continue;
    for (const src of args.slice(0, -1)) stages.at(-1).copied.add(norm(src));
  }
}

const problems = [];
let checked = 0;
for (const stage of stages) {
  for (const [name, app] of packages) {
    if (!app.dir.startsWith("apps/") || !stage.copied.has(app.dir)) continue;
    checked++;
    const need = new Set();
    const queue = [...app.deps];
    while (queue.length) {
      const dep = queue.shift();
      if (
        need.has(dep) ||
        !packages.has(dep) ||
        !packages.get(dep).dir.startsWith("packages/")
      )
        continue;
      need.add(dep);
      queue.push(...packages.get(dep).deps);
    }
    for (const dep of [...need].sort()) {
      const { dir } = packages.get(dep);
      if (!stage.copied.has(dir)) {
        problems.push(
          `${stage.name} copies ${app.dir} (${name}) but not ${dir} (${dep})`,
        );
      }
    }
  }
}

const label = relative(root, dockerfile);
if (checked === 0) {
  console.error(
    `${label}: no stage copies an apps/* directory; nothing was checked`,
  );
  process.exit(1);
}
if (problems.length) {
  console.error(`${label}: a workspace package is missing in a stage:`);
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    "Add `COPY <dir> ./<dir>` to that stage (and its build step if the app imports its dist).",
  );
  process.exit(1);
}
console.log(`${label} deps check: ok, ${checked} app stage(s)`);
