import path from "node:path";

export function runtimeIconPath(isPackaged: boolean, resourcesPath: string, moduleDir: string): string {
  return isPackaged ? path.join(resourcesPath, "icon.png") : path.join(moduleDir, "../../build/icon.png");
}
