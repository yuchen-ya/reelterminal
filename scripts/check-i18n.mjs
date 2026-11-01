import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(path.join(repo, "apps/web/package.json"))("typescript");
const CJK = /[\u3400-\u9fff]/;
// Units, revision prefixes, stable table field names and upstream attribution.
const TECHNICAL_UI_COPY = new Set(["v", "r", "s", "B", "ms", "NULL", "3D", "· v", "· r", "→ r", "B ·", "AI:", "rowId / columnId", "Excalidraw · MIT"]);
const normal = value => value.replace(/\s+/g, " ").trim();
export const literalHash = value => crypto.createHash("sha256").update(normal(value)).digest("hex");
const stringLike = node => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
const templateKey = node => ts.isTemplateExpression(node)
  ? node.head.text + node.templateSpans.map((span, index) => `{{v${index}}}${span.literal.text}`).join("")
  : node.text;

function pairedBilingualField(node) {
  const property = node.parent;
  if (!ts.isPropertyAssignment(property) || !["zh", "zhCN", "zh-CN"].includes(property.name.getText().replaceAll('"', "").replaceAll("'", ""))) return false;
  const object = property.parent;
  return ts.isObjectLiteralExpression(object) && object.properties.some(sibling =>
    ts.isPropertyAssignment(sibling) && sibling.name.getText().replaceAll('"', "") === "en" &&
    stringLike(sibling.initializer) && sibling.initializer.text.trim() && !CJK.test(sibling.initializer.text));
}

/** AST scan: comments, test fixtures and user data exemptions are never inferred from a CJK regex line count. */
export function inspectSource(text, file, { allowed = new Map(), keyAvailable = () => true, checkEnglishUi = false } = {}) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings = [], keys = [], prefixes = [], exemptions = new Map();
  const translators = new Set(), canonical = new Set(), markers = new Set(), instances = new Set(), hooks = new Set();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !stringLike(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    if (module === "i18next" || /(?:^|\/)i18n$/.test(module)) {
      if (statement.importClause.name) instances.add(statement.importClause.name.text);
    }
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
      const name = binding.propertyName?.text ?? binding.name.text;
      if (module === "react-i18next" && name === "useTranslation") hooks.add(binding.name.text);
      if (/(?:^|\/)i18n$/.test(module) && name === "t") translators.add(binding.name.text);
      if (/i18n\/messages$/.test(module) && name === "uiMessage") canonical.add(binding.name.text);
      if (/ui-message$/.test(module) && name === "uiMessageKey") markers.add(binding.name.text);
    }
  }
  function collectBindings(node) {
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type && ts.isTypeQueryNode(node.type) && translators.has(node.type.exprName.getText(source))) translators.add(node.name.text);
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) && hooks.has(node.initializer.expression.text)) {
      if (ts.isObjectBindingPattern(node.name)) for (const binding of node.name.elements) {
        if ((binding.propertyName?.getText(source) ?? binding.name.getText(source)) === "t" && ts.isIdentifier(binding.name)) translators.add(binding.name.text);
      }
      if (ts.isIdentifier(node.name)) instances.add(node.name.text);
    }
    ts.forEachChild(node, collectBindings);
  }
  collectBindings(source);
  const report = (node, kind, detail) => findings.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, kind, detail });
  function translationCall(node) {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (ts.isIdentifier(callee)) {
      if (translators.has(callee.text)) return "localized";
      if (canonical.has(callee.text)) return "canonical";
      if (markers.has(callee.text)) return "marker";
    }
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "t" && ts.isIdentifier(callee.expression) && instances.has(callee.expression.text)) return "localized";
  }
  function visit(node) {
    if (stringLike(node) || ts.isJsxText(node) || ts.isTemplateExpression(node)) {
      const value = templateKey(node);
      const visibleEnglish = checkEnglishUi && /[A-Za-z]/.test(value) && !TECHNICAL_UI_COPY.has(normal(value)) &&
        (ts.isJsxText(node) || stringLike(node) && (ts.isJsxExpression(node.parent) ||
          ts.isJsxAttribute(node.parent) && ["aria-label", "title", "placeholder", "alt"].includes(node.parent.name.getText(source))));
      if (visibleEnglish) report(node, "unlocalized-english-ui", normal(value));
      if (CJK.test(value) && !pairedBilingualField(node)) {
        const hash = literalHash(value), entry = allowed.get(`${file}:${hash}`);
        if (entry) {
          const id = `${file}:${hash}`, count = (exemptions.get(id) ?? 0) + 1;
          exemptions.set(id, count);
          if (entry.occurrences !== undefined && count > entry.occurrences) report(node, "expanded-data-exemption", hash);
        }
        else report(node, "unlocalized-cjk", hash);
      }
      if (ts.isTemplateExpression(node)) { for (const span of node.templateSpans) visit(span.expression); return; }
    }
    const type = translationCall(node);
    if (type) {
      const first = node.arguments[0];
      const choices = argument => argument && ts.isConditionalExpression(argument)
        ? [...choices(argument.whenTrue), ...choices(argument.whenFalse)] : argument ? [argument] : [];
      for (const argument of choices(first)) {
        if (stringLike(argument) || type === "marker" && ts.isTemplateExpression(argument)) {
          const key = templateKey(argument);
          if (key.trim()) {
            keys.push({ file, key });
            if (!keyAvailable(key)) report(argument, "missing-catalog-key", key);
          }
        } else {
          let prefix;
          if (ts.isTemplateExpression(argument)) prefix = argument.head.text;
          else if (ts.isBinaryExpression(argument) && stringLike(argument.left)) prefix = argument.left.text;
          if (prefix && /^[A-Za-z][\w-]*\./.test(prefix)) prefixes.push({ file, prefix });
        }
      }
      if (type === "localized") {
        let parent = node.parent, inFunction = false, declaration;
        while (parent) {
          if (ts.isFunctionLike(parent)) inFunction = true;
          if (ts.isVariableDeclaration(parent)) declaration = parent;
          parent = parent.parent;
        }
        if (!inFunction && declaration && declaration.initializer && !ts.isAwaitExpression(declaration.initializer)) {
          report(node, "frozen-module-translation", "Store keys or use a render-time lookup; persisted data creation is separate.");
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { findings, keys, prefixes, exemptions };
}

export function flatten(value, prefix = "", result = {}) {
  for (const [key, child] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "string") result[name] = child;
    else if (child && typeof child === "object") flatten(child, name, result);
  }
  return result;
}
/** Every shipped manual key and every dynamically selected family must exist in both languages. */
export function inspectCatalogs(en, zh, upstream = {}, prefixes = []) {
  const findings = [];
  for (const key of new Set([...Object.keys(en), ...Object.keys(zh)])) {
    if (!en[key]?.trim() || !zh[key]?.trim()) findings.push({ file: "i18n", kind: "manual-catalog-parity", detail: key });
  }
  for (const [key, value] of Object.entries(upstream)) {
    if (!key.trim() || typeof value !== "string" || !value.trim()) findings.push({ file: "i18n", kind: "empty-upstream-translation", detail: key });
  }
  for (const prefix of new Set(prefixes)) {
    const family = [...new Set([...Object.keys(en), ...Object.keys(zh)])].filter(key => key.startsWith(prefix));
    if (!family.length) findings.push({ file: "i18n", kind: "missing-dynamic-family", detail: prefix });
  }
  return findings;
}
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
export function checkRepository(root = repo) {
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  const base = "apps/web/src/i18n/locales/";
  const en = flatten(read(base + "en/translation.json")), zh = flatten(read(base + "zh-CN/translation.json"));
  const upstream = read(base + "zh-CN/upstream-translation.json");
  // Retained editor copy uses literal English keys: the key itself is its English fallback.
  const english = { ...Object.fromEntries(Object.keys(upstream).map(key => [key, key])), ...en }, chinese = { ...upstream, ...zh };
  const present = (catalog, key) => Boolean(catalog[key] || (catalog[key + "_one"] && catalog[key + "_other"]) || catalog[key + "_other"]);
  const keyAvailable = key => present(english, key) && present(chinese, key);
  const entries = read("scripts/i18n/data-literals.json"), allowed = new Map(entries.map(entry => [`${entry.file}:${entry.sha256}`, entry]));
  const files = walk(path.join(root, "apps/web/src")).filter(file => /\.tsx?$/.test(file) && !/(?:\.test\.|\.spec\.|\.d\.ts$|[/\\](?:i18n|test|__tests__)[/\\])/.test(file));
  for (const file of ["packages/core/src/review/glb.ts", "apps/desktop/src/main/human-board-documents.ts", "apps/desktop/src/main/ipc/human-board-documents.ts", "apps/desktop/src/main/screen-capture.ts"]) files.push(path.join(root, file));
  const findings = [], keys = [], prefixes = [], used = new Set();
  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const result = inspectSource(fs.readFileSync(file, "utf8"), relative, { allowed, keyAvailable, checkEnglishUi: /apps\/web\/src\/desktop\/(?:workbench\/|pages\/ExportCleanupPage\.tsx$)/.test(relative) });
    findings.push(...result.findings); keys.push(...result.keys); prefixes.push(...result.prefixes);
    for (const [value] of result.exemptions) used.add(value);
  }
  findings.push(...inspectCatalogs(en, zh, upstream, prefixes.map(value => value.prefix)));
  for (const [id, entry] of allowed) if (!used.has(id)) findings.push({ file: entry.file, kind: "unused-data-exemption", detail: entry.sha256 });
  return { files: files.length, staticKeys: new Set(keys.map(value => value.key)).size, dynamicPrefixes: [...new Set(prefixes.map(value => value.prefix))].sort(), reviewedDataLiterals: used.size, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkRepository();
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`i18n: ${result.files} source files, ${result.staticKeys} static keys, ${result.reviewedDataLiterals} reviewed data literals, ${result.findings.length} findings.`);
    for (const finding of result.findings.slice(0, 80)) console.error(`${finding.file}:${finding.line ?? 0} ${finding.kind}: ${finding.detail}`);
  }
  if (result.findings.length) process.exitCode = 1;
}
