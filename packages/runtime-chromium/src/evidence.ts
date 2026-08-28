/**
 * Machine-readable evidence sink: tests drop probe/verification JSON here
 * (gitignored; CI uploads it as a workflow artifact).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export function artifactsDir(): string {
  return fileURLToPath(new URL("../.artifacts", import.meta.url));
}

export async function saveEvidence(
  name: string,
  data: unknown,
): Promise<string> {
  const dir = artifactsDir();
  await mkdir(dir, { recursive: true });
  const filePath = `${dir}/${name}`;
  await writeFile(filePath, JSON.stringify(data, null, 2));
  return filePath;
}
