import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectSource, inspectCatalogs, literalHash } from "../check-i18n.mjs";

const inspect = (source, options) => inspectSource(source, "fixture.tsx", options);
test("finds pure Chinese JSX, attributes and templates while ignoring comments", () => {
  const result = inspect('// 中文说明\nconst View = () => <div title="标题">正文{`共 ${count} 项`}</div>');
  assert.equal(result.findings.filter(item => item.kind === "unlocalized-cjk").length, 3);
  assert.equal(inspect('// 中文说明\nconst answer = 42;').findings.length, 0);
});
test("only exempts explicitly paired bilingual data or counted exact data literals", () => {
  assert.equal(inspect('const copy = { en: "Review", zh: "审阅" };').findings.length, 0);
  assert.equal(inspect('const copy = { en: "", zh: "审阅" };').findings.length, 1);
  const hash = literalHash("旧版身份");
  const allowed = new Map([[`fixture.tsx:${hash}`, { occurrences: 1 }]]);
  assert.equal(inspect('const identity = "旧版身份";', { allowed }).findings.length, 0);
  assert.equal(inspect('const identity = "旧版身份"; const copy = "旧版身份";', { allowed }).findings[0].kind, "expanded-data-exemption");
  assert.equal(inspect('const identity = "新的中文";', { allowed }).findings[0].kind, "unlocalized-cjk");
});
test("checks actual translator bindings, literal keys and native diagnostic templates", () => {
  const result = inspect('import { t as translate } from "../i18n"; import { useTranslation } from "react-i18next"; import { uiMessageKey } from "@reelterminal/core/ui-message"; function View() { const { t: local } = useTranslation(); translate("missing"); local("present"); uiMessageKey(`Missing file: ${file}`); unrelated("ignored"); }', { keyAvailable: key => key !== "missing" });
  assert.deepEqual(result.keys.map(item => item.key), ["missing", "present", "Missing file: {{v0}}"]);
  assert.equal(result.findings[0].kind, "missing-catalog-key");
});
test("rejects module-frozen translations but accepts getters and canonical metadata", () => {
  const result = inspect('import { t } from "../i18n"; import { uiMessage } from "../i18n/messages"; const frozen = t("Label"); const labels = { get live() { return t("Label"); } }; function render() { return t("Label"); } const metadata = uiMessage("Label");');
  assert.deepEqual(result.findings.map(item => item.kind), ["frozen-module-translation"]);
});
test("checks manual parity, empty copy and dynamic key families", () => {
  assert.deepEqual(inspectCatalogs({ "status.ready": "Ready" }, { "status.ready": "就绪" }, {}, ["status."]), []);
  const failures = inspectCatalogs({ "status.ready": "Ready", missing: "Missing" }, { "status.ready": "" }, { blank: "" }, ["notThere."]);
  assert.deepEqual(failures.map(item => item.kind), ["manual-catalog-parity", "manual-catalog-parity", "empty-upstream-translation", "missing-dynamic-family"]);
  const result = inspect('import { t } from "../i18n"; function render() { return t(`status.${value}`) + t("review." + state); }');
  assert.deepEqual(result.prefixes.map(item => item.prefix), ["status.", "review."]);
});

test("also rejects new English-only JSX copy on the bilingual review surfaces", () => {
  const result = inspect('<div title="Open dialog">Unsaved edits<span>ms</span>{userName}</div>', { checkEnglishUi: true });
  assert.deepEqual(result.findings.map(item => item.detail), ["Open dialog", "Unsaved edits"]);
});

test("checks static alternatives inside conditional translation calls", () => {
  const result = inspect('import { t } from "../i18n"; function render() { return t(enabled ? "Known" : "Missing"); }', { keyAvailable: key => key === "Known" });
  assert.deepEqual(result.keys.map(item => item.key), ["Known", "Missing"]);
  assert.equal(result.findings[0].detail, "Missing");
});
