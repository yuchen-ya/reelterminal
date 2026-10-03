import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manualFile = path.resolve(desktopDir, "../../packages/agent-facade/src/gui-manual.ts");
const compiled = await build({ entryPoints: [manualFile], bundle: true, platform: "node", format: "esm", write: false });
const { GUI_MANUAL_SCREENS, GUI_MANUAL_APP_VERSION } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString("base64")}`
);
const outputDir = path.join(desktopDir, "resources/help");
await mkdir(outputDir, { recursive: true });

const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

for (const language of ["zh", "en"]) {
  const chinese = language === "zh";
  const title = chinese ? "ReelTerminal 使用手册" : "ReelTerminal User Guide";
  const paragraphs = (items) => items?.map((item) => `<p>${escapeHtml(item[language])}</p>`).join("") ?? "";
  const navigation = GUI_MANUAL_SCREENS.map((screen) => `<a href="#${screen.id}">${escapeHtml(screen.title[language])}</a>`).join("");
  const sections = GUI_MANUAL_SCREENS.map((screen) => `
    <section id="${screen.id}">
      <h2>${escapeHtml(screen.title[language])}</h2>
      <p class="summary">${escapeHtml(screen.summary[language])}</p>
      <h3>${chinese ? "从这里进入" : "Where to start"}</h3>${paragraphs(screen.entry)}
      ${screen.visibility ? paragraphs([screen.visibility]) : ""}
      ${screen.steps ? `<h3>${chinese ? "操作步骤" : "Steps"}</h3><ol>${screen.steps.map((item) => `<li>${escapeHtml(item[language])}</li>`).join("")}</ol>` : ""}
      ${screen.limitations ? `<aside><h3>${chinese ? "提示" : "Notes"}</h3>${paragraphs(screen.limitations)}</aside>` : ""}
    </section>`).join("");
  const html = `<!doctype html>
<html lang="${chinese ? "zh-CN" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,"Microsoft YaHei",sans-serif;line-height:1.7;--bg:#f5f7f8;--fg:#172127;--card:white;--line:#dce3e5;--accent:#007d60;--muted:#52646d}
@media(prefers-color-scheme:dark){:root{--bg:#101415;--fg:#e2e9e7;--card:#191f20;--line:#303b3b;--accent:#38d5a8;--muted:#a2b4b1}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg)}a{color:var(--accent)}header{padding:32px max(24px,calc((100vw - 1120px)/2));border-bottom:1px solid var(--line)}h1{font-size:28px;margin:0}header p{color:var(--muted)}.layout{max-width:1120px;margin:auto;display:grid;grid-template-columns:220px 1fr;gap:32px;padding:24px}nav{position:sticky;top:20px;max-height:90vh;overflow:auto;align-self:start}nav a{display:block;padding:6px 8px;text-decoration:none;font-size:14px}nav a:hover{text-decoration:underline}section{padding:28px;margin-bottom:24px;background:var(--card);border:1px solid var(--line);border-radius:12px;scroll-margin-top:20px}h2{margin:0;font-size:24px}h3{font-size:15px;margin-top:24px}.summary{color:var(--muted)}li{padding-left:5px;margin-bottom:14px}aside{border-top:1px solid var(--line);font-size:14px;color:var(--muted)}@media(max-width:720px){.layout{grid-template-columns:1fr;padding:16px}nav{position:static;max-height:180px;border-bottom:1px solid var(--line)}section{padding:20px}}
</style></head><body><header><h1>${title}</h1><p>${chinese ? "新手从“快速开始”读起。软件顶栏“帮助”提供同一份手册和界面导览。" : "Start with Quick Start. Help in the app title bar offers this manual and the interface tour."}</p><span>${escapeHtml(GUI_MANUAL_APP_VERSION)} · </span><a href="USER-GUIDE.${chinese ? "en" : "zh"}.html">${chinese ? "English" : "中文"}</a></header><div class="layout"><nav aria-label="${chinese ? "目录" : "Contents"}">${navigation}</nav><main>${sections}</main></div></body></html>`;
  await writeFile(path.join(outputDir, `USER-GUIDE.${language}.html`), html, "utf8");
}
console.log("[user-guide] generated bilingual offline manuals from the shipped GUI manual");
