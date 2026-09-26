import { readFile } from "node:fs/promises";
import Ajv from "ajv/dist/2020.js";

const ajv = new Ajv({ allErrors: true, strict: true });
for (const name of [
  "common",
  "adapter-request",
  "adapter-response",
  "case-index",
  "capabilities",
  "implementation",
  "report",
]) {
  ajv.addSchema(
    JSON.parse(await readFile(new URL(`../schemas/${name}.schema.json`, import.meta.url), "utf8")),
  );
}

export function validate(name, value) {
  const check = ajv.getSchema(`urn:inflow:conformance:${name}`);
  if (!check || !check(value)) {
    throw new Error(`Invalid ${name}: ${check ? ajv.errorsText(check.errors) : "unknown schema"}`);
  }
}

export function selectCases(index, capabilities) {
  validate("case-index", index);
  validate("capabilities", capabilities);
  const identifiers = new Set();
  for (const item of index.cases) {
    if (identifiers.has(item.id)) throw new Error(`Duplicate case: ${item.id}`);
    identifiers.add(item.id);
  }
  const suites = new Set(index.cases.map((item) => item.suite));
  for (const suite of capabilities.suites) {
    if (!suites.has(suite)) throw new Error(`Unknown suite: ${suite}`);
  }
  const selected = index.cases.filter((item) => capabilities.suites.includes(item.suite));
  const features = new Set(selected.flatMap((item) => (item.feature ? [item.feature] : [])));
  const declarations = new Map();
  for (const feature of capabilities.supported_features) declarations.set(feature, null);
  for (const feature of capabilities.unsupported_features) {
    if (declarations.has(feature.id))
      throw new Error(`Duplicate feature declaration: ${feature.id}`);
    if (!feature.reason.trim()) throw new Error(`Empty omission reason: ${feature.id}`);
    declarations.set(feature.id, feature.reason);
  }
  for (const feature of declarations.keys()) {
    if (!features.has(feature)) throw new Error(`Unknown feature for selected suites: ${feature}`);
  }
  for (const feature of features) {
    if (!declarations.has(feature)) throw new Error(`Undeclared feature: ${feature}`);
  }
  const cases = selected.map((item) => ({
    item,
    omission: item.feature ? declarations.get(item.feature) : null,
  }));
  if (!cases.some(({ omission }) => omission === null))
    throw new Error("No executable cases selected");
  return cases;
}
