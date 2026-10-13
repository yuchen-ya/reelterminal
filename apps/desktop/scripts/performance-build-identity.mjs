import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  createReadStream,
  existsSync,
  lstatSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  renameSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopDirectory = path.resolve(scriptDirectory, "..");
const defaultRepositoryRoot = path.resolve(desktopDirectory, "..", "..");
const STAMP_FILE = "performance-build.json";
const STAMP_SCHEMA = "reelterminal.performance-build/v1";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function gitBuffer(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

async function sourceIdentity(repositoryRoot) {
  const head = gitBuffer(repositoryRoot, ["rev-parse", "HEAD"]).toString("utf8").trim();
  const diff = gitBuffer(repositoryRoot, ["diff", "--binary", "HEAD", "--"]);
  const status = gitBuffer(repositoryRoot, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    "-z",
  ]);
  const untracked = gitBuffer(repositoryRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();

  const dirtyDigest = createHash("sha256").update(diff);
  for (const relativePath of untracked) {
    const absolutePath = path.resolve(repositoryRoot, relativePath);
    const relativeCheck = path.relative(repositoryRoot, absolutePath);
    if (
      relativeCheck === ".." ||
      relativeCheck.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeCheck)
    ) {
      throw new Error("Git returned a path outside the repository root");
    }
    const entry = lstatSync(absolutePath);
    dirtyDigest.update(relativePath).update("\0");
    if (entry.isFile()) {
      dirtyDigest.update(await sha256File(absolutePath));
    } else if (entry.isSymbolicLink()) {
      dirtyDigest.update(`symlink:${readlinkSync(absolutePath)}`);
    } else {
      dirtyDigest.update(`entry:${entry.mode}`);
    }
    dirtyDigest.update("\0");
  }

  const dirtyDiffDigest = dirtyDigest.digest("hex");
  const lockfilePath = path.join(repositoryRoot, "pnpm-lock.yaml");
  const lockfileDigest = existsSync(lockfilePath)
    ? sha256(readFileSync(lockfilePath))
    : null;
  const sourceDigest = sha256(
    JSON.stringify({ head, dirtyDiffDigest, lockfileDigest }),
  );

  return {
    source_head: head,
    dirty: status.length > 0,
    source_digest: sourceDigest,
    dirty_diff_digest: dirtyDiffDigest,
    lockfile_digest: lockfileDigest,
  };
}

function walkFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(absolutePath));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

async function fileManifest(directory, predicate = () => true) {
  if (!existsSync(directory)) return null;
  const paths = walkFiles(directory)
    .filter((absolutePath) => predicate(absolutePath))
    .sort((left, right) => {
      const leftPath = path.relative(directory, left).split(path.sep).join("/");
      const rightPath = path.relative(directory, right).split(path.sep).join("/");
      return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
    });
  const entries = [];
  for (const absolutePath of paths) {
    entries.push({
      path: path.relative(directory, absolutePath).split(path.sep).join("/"),
      sha256: await sha256File(absolutePath),
    });
  }
  return {
    sha256: sha256(JSON.stringify(entries)),
    entries,
  };
}

function electronExecutable(desktopRoot) {
  const packageRequire = createRequire(path.join(desktopRoot, "package.json"));
  const executable = packageRequire("electron");
  if (typeof executable !== "string" || !existsSync(executable)) return null;
  return realpathSync(executable);
}

async function currentAssets(repositoryRoot) {
  const desktopRoot = path.join(repositoryRoot, "apps", "desktop");
  const webDist = path.join(repositoryRoot, "apps", "web", "dist");
  const mainPath = path.join(desktopRoot, "dist", "main", "index.js");
  const preloadPath = path.join(desktopRoot, "dist", "preload", "index.js");
  const renderer = await fileManifest(webDist, (absolutePath) =>
    /\.(?:html|js|mjs|css|wasm|json)$/i.test(absolutePath) &&
    !absolutePath.endsWith(".map"),
  );
  const workers = await fileManifest(webDist, (absolutePath) =>
    /worker/i.test(path.basename(absolutePath)) &&
    /\.(?:js|mjs)$/i.test(absolutePath),
  );
  const executable = electronExecutable(desktopRoot);

  return {
    main_bundle_sha256: existsSync(mainPath) ? await sha256File(mainPath) : null,
    preload_bundle_sha256: existsSync(preloadPath) ? await sha256File(preloadPath) : null,
    renderer_manifest_sha256: renderer?.sha256 ?? null,
    worker_manifest_sha256: workers?.sha256 ?? null,
    executable_sha256: executable ? await sha256File(executable) : null,
  };
}

function packageVersion(repositoryRoot) {
  const packageJson = JSON.parse(
    readFileSync(path.join(repositoryRoot, "apps", "desktop", "package.json"), "utf8"),
  );
  return typeof packageJson.version === "string" ? packageJson.version : null;
}

async function buildInputs(repositoryRoot) {
  return {
    ...await sourceIdentity(repositoryRoot),
    ...await currentAssets(repositoryRoot),
    app_version: packageVersion(repositoryRoot),
  };
}

function canStamp(inputs) {
  return Boolean(
    inputs.source_head &&
      inputs.source_digest &&
      inputs.dirty_diff_digest &&
      inputs.lockfile_digest &&
      inputs.main_bundle_sha256 &&
      inputs.preload_bundle_sha256 &&
      inputs.renderer_manifest_sha256 &&
      inputs.worker_manifest_sha256 &&
      inputs.executable_sha256 &&
      inputs.app_version,
  );
}

export function getBuildStampPath(repositoryRoot = defaultRepositoryRoot) {
  return path.join(repositoryRoot, "apps", "desktop", "dist", STAMP_FILE);
}

export async function writeProductionBuildStamp(repositoryRoot = defaultRepositoryRoot) {
  repositoryRoot = path.resolve(repositoryRoot);
  const inputs = await buildInputs(repositoryRoot);
  if (!canStamp(inputs)) {
    throw new Error("Production build identity is incomplete; required assets or source identity are missing");
  }

  const stamp = {
    schema: STAMP_SCHEMA,
    build_type: "production",
    ...inputs,
  };
  const stampPath = getBuildStampPath(repositoryRoot);
  const temporaryPath = `${stampPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, stampPath);
  return stamp;
}

export async function captureBuildIdentity(repositoryRoot = defaultRepositoryRoot) {
  repositoryRoot = path.resolve(repositoryRoot);
  const current = await buildInputs(repositoryRoot);
  let stamp = null;
  let buildReason = "stamp_missing";
  try {
    stamp = JSON.parse(readFileSync(getBuildStampPath(repositoryRoot), "utf8"));
    buildReason = "stamp_invalid";
  } catch (error) {
    if (error?.code === "ENOENT") {
      buildReason = "stamp_missing";
    } else if (error instanceof SyntaxError) {
      buildReason = "stamp_invalid";
    } else {
      throw error;
    }
  }

  if (stamp?.schema === STAMP_SCHEMA && stamp.build_type === "production") {
    const sourceMatches = [
      "source_head",
      "dirty",
      "source_digest",
      "dirty_diff_digest",
      "lockfile_digest",
      "app_version",
    ].every((key) => stamp[key] === current[key]);
    const assetsMatch = [
      "main_bundle_sha256",
      "preload_bundle_sha256",
      "renderer_manifest_sha256",
      "worker_manifest_sha256",
      "executable_sha256",
    ].every((key) => Boolean(current[key]) && stamp[key] === current[key]);

    if (!sourceMatches) buildReason = "source_mismatch";
    else if (!assetsMatch) buildReason = "assets_mismatch";
    else buildReason = "verified";
  }

  const sourceFields = stamp?.schema === STAMP_SCHEMA ? stamp : current;
  const assetFields = current;
  return {
    source_head: sourceFields.source_head ?? null,
    dirty: sourceFields.dirty ?? null,
    source_digest: sourceFields.source_digest ?? null,
    dirty_diff_digest: sourceFields.dirty_diff_digest ?? null,
    lockfile_digest: sourceFields.lockfile_digest ?? null,
    main_bundle_sha256: assetFields.main_bundle_sha256 ?? current.main_bundle_sha256,
    preload_bundle_sha256: assetFields.preload_bundle_sha256 ?? current.preload_bundle_sha256,
    renderer_manifest_sha256: assetFields.renderer_manifest_sha256 ?? current.renderer_manifest_sha256,
    worker_manifest_sha256: assetFields.worker_manifest_sha256 ?? current.worker_manifest_sha256,
    executable_sha256: assetFields.executable_sha256 ?? current.executable_sha256,
    app_version: sourceFields.app_version ?? current.app_version,
    build_type: stamp?.build_type === "production" ? "production" : null,
    build_verified: buildReason === "verified",
    build_reason: buildReason,
  };
}

export const PERFORMANCE_BUILD_IDENTITY_SCHEMA = STAMP_SCHEMA;
