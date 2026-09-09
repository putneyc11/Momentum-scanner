import fs from "node:fs/promises";
import { parse } from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
const schemaURL = "https://render.com/schema/render.yaml.json";
const response = await fetch(schemaURL, {
  signal: AbortSignal.timeout(20000),
  redirect: "error",
});
if (!response.ok)
  throw new Error(`Cannot load Render schema: HTTP ${response.status}`);
const schema = await response.json();
const blueprint = parse(
  await fs.readFile(new URL("../render.yaml", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);
if (!validate(blueprint)) {
  console.error(JSON.stringify(validate.errors, null, 2));
  process.exitCode = 1;
} else
  console.log(
    "Render Blueprint passes the current official JSON schema. This does not create resources or replace Render account-side validation.",
  );
