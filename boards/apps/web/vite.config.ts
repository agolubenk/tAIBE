import path from "node:path";
import { gzipSync } from "node:zlib";
import babel from "@rolldown/plugin-babel";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins } from "vite-plus";
import packageJson from "../../package.json";

const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
const sentryOrg = process.env.SENTRY_ORG;
const sentryProject = process.env.SENTRY_PROJECT;
const uploadSourceMaps = Boolean(sentryAuthToken && sentryOrg && sentryProject);

export default defineConfig({
  run: {
    tasks: {
      compile: {
        command: "vp build",
        dependsOn: [
          { task: "build", from: ["dependencies", "devDependencies"] },
        ],
        cache: false,
      },
      "check:types": {
        command:
          "tsc --noEmit -p tsconfig.app.json && tsc --noEmit -p tsconfig.node.json",
        dependsOn: [
          { task: "build", from: ["dependencies", "devDependencies"] },
        ],
        // Typechecks read sources across the workspace and `auto` can't trace
        // tsc 7, so a cached result can be stale; always run them (like cli).
        cache: false,
      },
      "test:run": {
        command: "vp test run --config vitest.config.ts",
        dependsOn: [
          { task: "build", from: ["dependencies", "devDependencies"] },
        ],
        cache: false,
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  base: "/",
  plugins: lazyPlugins(() => [
    tanstackRouter({
      autoCodeSplitting: true,
      // Keep co-located route tests out of the generated route tree.
      routeFileIgnorePattern: "\\.test\\.tsx?$",
    }),
    tailwindcss(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    // TEMP TB-173 (#357): module sizes of three chunks in the CI build log
    // for the bundle check; removed before the PR leaves draft.
    {
      name: "tb173-chunk-report",
      apply: "build",
      generateBundle(_options, bundle) {
        const chunks = new Set([
          "index",
          "task-shortcuts",
          "task-forms-section",
        ]);
        for (const file of Object.values(bundle)) {
          if (file.type !== "chunk" || !chunks.has(file.name)) continue;
          const gz = (text: string) => gzipSync(text).length;
          const deps =
            /const __vite__mapDeps=[^;]*;/.exec(file.code)?.[0] ?? "";
          console.log(
            `[tb173] ${file.name} =chunk code ${file.code.length} gz ${gz(file.code)} mapDeps ${deps.length} gz-without-mapDeps ${gz(file.code.replace(deps, ""))}`,
          );
          console.log(
            `[tb173] ${file.name} =imports ${file.imports.join(" ")}`,
          );
          console.log(
            `[tb173] ${file.name} =dynamic ${file.dynamicImports.join(" ")}`,
          );
          console.log(`[tb173] ${file.name} =mapDeps ${deps.slice(0, 1500)}`);
          for (const [id, info] of Object.entries(file.modules ?? {})) {
            const name = id
              .replace(/^.*node_modules\//, "")
              .replace(/^.*\/boards\//, "");
            console.log(`[tb173] ${file.name} ${info.renderedLength} ${name}`);
          }
        }
      },
    },
    // Hidden when Sentry env vars are absent so local dev does not depend on it.
    ...(uploadSourceMaps
      ? [
          sentryVitePlugin({
            authToken: sentryAuthToken,
            org: sentryOrg,
            project: sentryProject,
            release: { name: packageJson.version },
            sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
          }),
        ]
      : []),
  ]),
  server: {
    host: true,
    hmr: true,
    port: 5173,
  },
  optimizeDeps: {
    exclude: ["better-auth"],
  },
  ssr: {
    noExternal: ["better-auth"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@i18n": path.resolve(__dirname, "../../i18n"),
    },
  },
  build: {
    // Generate maps only for private symbolication, then delete after upload.
    // "hidden" alone still writes publicly servable .map files.
    sourcemap: uploadSourceMaps ? "hidden" : false,
    rollupOptions: {},
    commonjsOptions: {
      include: [/better-auth/, /node_modules/],
      transformMixedEsModules: true,
    },
    target: "esnext",
  },
});
