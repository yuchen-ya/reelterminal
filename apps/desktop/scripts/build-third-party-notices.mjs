import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(desktopRoot, "resources", "licenses");
const licenses = JSON.parse(readFileSync(0, "utf8"));
const packages = Object.values(licenses).flat().sort((a, b) => a.name.localeCompare(b.name));
const upstreamSources = JSON.parse(readFileSync(path.join(desktopRoot, "LICENSES", "npm-upstream-sources.json"), "utf8"));
const inventory = [];
const sections = [
  "ReelTerminal desktop dependency notices",
  "Production dependency inventory for the desktop and web renderer workspaces.",
  "Includes transitive and optional dependencies; not every listed package is loaded on every platform.",
  "Project and asset notices are distributed alongside this file.",
];

for (const pkg of packages) {
  const texts = new Map();
  const packageLicenseFiles = [];
  for (const packageRoot of pkg.paths) {
    for (const entry of readdirSync(packageRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !/^(licen[cs]e|copying|notice)(?:$|[._-])/i.test(entry.name)) continue;
      const contents = readFileSync(path.join(packageRoot, entry.name), "utf8");
      const labels = texts.get(contents) ?? [];
      if (!labels.includes(entry.name)) labels.push(entry.name);
      texts.set(contents, labels);
      packageLicenseFiles.push(entry.name);
    }
  }
  const licenseSources = [];
  const licenseReviewNotes = upstreamSources.reviewNotes?.[pkg.name] ?? [];
  const sourcesByVersion = upstreamSources[pkg.name] ?? {};
  for (const version of pkg.versions) {
    const source = sourcesByVersion[version];
    if (!source) continue;
    if (source.license !== pkg.license) {
      throw new Error(`Upstream license mismatch for ${pkg.name}@${version}: ${source.license} != ${pkg.license}`);
    }
    let contents;
    let filename;
    if (source.packageFile) {
      const packageFilePath = pkg.paths
        .map((packageRoot) => path.join(packageRoot, source.packageFile))
        .find((candidate) => existsSync(candidate));
      if (!packageFilePath) throw new Error(`Upstream license file is missing from ${pkg.name}@${version}: ${source.packageFile}`);
      const readme = readFileSync(packageFilePath, "utf8");
      const start = readme.indexOf(source.startMarker);
      const end = readme.indexOf(source.endMarker, start);
      if (start < 0 || end < 0) throw new Error(`Could not find the complete license section in ${pkg.name}@${version} ${source.packageFile}`);
      contents = readme.slice(start, end + source.endMarker.length).trim();
      filename = source.packageFile;
    } else {
      const sourcePath = path.resolve(desktopRoot, source.file);
      if (!sourcePath.startsWith(`${desktopRoot}${path.sep}`)) {
        throw new Error(`Upstream license path escapes the desktop package: ${source.file}`);
      }
      contents = readFileSync(sourcePath, "utf8");
      filename = source.file;
    }
    const label = `${filename} (upstream ${version}: ${source.url})`;
    const labels = texts.get(contents) ?? [];
    if (!labels.includes(label)) labels.push(label);
    texts.set(contents, labels);
    licenseSources.push({ version, file: filename, url: source.url });
  }
  const item = {
    name: pkg.name, versions: pkg.versions, license: pkg.license,
    licenseSource: "pnpm licenses list",
    author: pkg.author, homepage: pkg.homepage,
    licenseFiles: [...new Set(packageLicenseFiles)],
    ...(licenseSources.length > 0 ? { upstreamLicenseSources: licenseSources } : {}),
    ...(licenseReviewNotes.length > 0 ? { licenseReviewNotes } : {}),
  };
  inventory.push(item);
  sections.push("", "=".repeat(72), `${pkg.name} ${pkg.versions.join(", ")}`, `Reported license (pnpm): ${pkg.license}`);
  if (pkg.author) sections.push(`Author: ${typeof pkg.author === "string" ? pkg.author : JSON.stringify(pkg.author)}`);
  if (pkg.homepage) sections.push(`Upstream: ${pkg.homepage}`);
  for (const note of licenseReviewNotes) sections.push(`License review: ${note}`);
  for (const source of licenseSources) sections.push(`Upstream license source for ${source.version}: ${source.url}`);
  if (packageLicenseFiles.length === 0 && licenseSources.length > 0) {
    sections.push("The npm archive omits a standalone license file; the complete upstream license text is included below.");
  }
  for (const [contents, labels] of texts) {
    for (const label of labels) sections.push("", `--- ${label} ---`);
    sections.push(contents.trim());
  }
  if (texts.size === 0) sections.push("No separate license text is included in this npm archive. Consult the upstream project for its complete terms.");
}

mkdirSync(outputRoot, { recursive: true });
writeFileSync(path.join(outputRoot, "DEPENDENCY_LICENSES.txt"), sections.join("\n") + "\n");
writeFileSync(path.join(outputRoot, "dependency-inventory.json"), JSON.stringify(inventory, null, 2) + "\n");
console.log(`[licenses] generated notices for ${inventory.length} dependency packages`);
