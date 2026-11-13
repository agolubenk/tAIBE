import { buildSchema } from "./schema-build.mjs";
import { loadLocales, schemaPath, writeJson } from "./shared.mjs";

const { reference } = await loadLocales();

await writeJson(schemaPath, buildSchema(reference.data));
console.log(`Wrote ${schemaPath}`);
