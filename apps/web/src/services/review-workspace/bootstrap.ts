import { openMaterialDatabase } from "../material-library/storage";
import { getReviewContext } from "./context";
import { exportValue } from "./export";

let startup: Promise<void> | undefined;
export function initializeReviewWorkspace(): Promise<void> {
  return startup ??= initialize();
}

async function initialize(): Promise<void> {
  await getReviewContext();
  const native = window.reelterminal?.reviewFiles;
  if (!native) return;
  const database = await openMaterialDatabase();
  let registered: string[];
  try {
    registered = await new Promise<string[]>((resolve, reject) => {
      const transaction = database.transaction("fileResources", "readonly");
      const request = transaction.objectStore("fileResources").getAllKeys();
      transaction.oncomplete = () => resolve(request.result as string[]);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { database.close(); }
  exportValue(await native.collectUnregistered(registered));
}
