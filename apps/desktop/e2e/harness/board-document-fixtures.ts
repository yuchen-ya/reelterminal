import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { DESKTOP_DIR } from "./paths";

/** Copy the real README and its direct local references, preserving its source exactly. */
export async function copyReadmeFixture(directory: string) {
  const root = path.resolve(DESKTOP_DIR, "../..");
  const source = await readFile(path.join(root, "README.md"), "utf8");
  await mkdir(directory, { recursive: true });
  const references = new Set([...source.matchAll(/(?:\]\(([^)\s]+)\)|(?:src|href)=["']([^"']+)["'])/g)]
    .map(match => (match[1] ?? match[2]).split("#")[0])
    .filter(reference => reference && !/^(?:[a-z]+:|\/\/)/i.test(reference)));
  for (const reference of references) {
    const from = path.resolve(root, reference);
    if (!from.startsWith(`${root}${path.sep}`)) throw new Error(`Unexpected README reference: ${reference}`);
    const entry = await stat(from).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!entry?.isFile()) continue;
    const destination = path.join(directory, reference);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(from, destination);
  }
  const filename = path.join(directory, "README.md");
  await writeFile(filename, source);
  return { filename, source };
}

export const localHtmlSource = `<!doctype html><html><head><meta charset="utf-8"><title>Board local fixture</title>
<style>body{margin:0;background:white;color:#102030;font:24px sans-serif}header{padding:32px;background:#2574d8;color:white}main{padding:32px}a{display:block;padding:20px;background:#def}section{height:1200px}</style></head>
<body><header>Local HTML preserved source</header><main><a href="next.html" id="next">Open relative page</a><section>Scrollable document</section><p id="bottom">Local document bottom</p></main>
<script>document.body.dataset.bridge = [typeof require,typeof process,typeof window.reelterminal].join('/')</script></body></html>`;

export async function startBoardPageServer() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    response.end(request.url?.startsWith("/next")
      ? '<!doctype html><html><body style="margin:0;background:#1b8c46;color:white;font:32px sans-serif"><h1>Linked page loaded</h1><p>Native browser navigation succeeded</p></body></html>'
      : localHtmlSource.replace("Board local fixture", "Board HTTP fixture").replace("Local HTML preserved source", "HTTP live fixture").replace('href="next.html"', 'href="/next"'));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture did not bind a TCP address");
  return { url: `http://127.0.0.1:${address.port}/`, requests,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
