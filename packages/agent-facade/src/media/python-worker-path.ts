import { stat } from "node:fs/promises";
import { join } from "node:path";

/** External Python cannot read Electron's virtual ASAR filesystem. */
export async function resolvePythonWorkerPath(
  name: string,
  moduleDir: string,
  overrideDir?: string,
): Promise<string | null> {
  const directories = [
    ...(overrideDir ? [overrideDir] : []),
    ...["../python", "../../python", "../../../python", "../../agent-facade/python", "../../../agent-facade/python"]
      .map((relative) => join(moduleDir, relative)),
  ];
  for (const directory of directories) {
    const candidate = join(directory, name).replace(/([\\/])app\.asar([\\/])/g, "$1app.asar.unpacked$2");
    if ((await stat(candidate).catch(() => null))?.isFile()) return candidate;
  }
  return null;
}
