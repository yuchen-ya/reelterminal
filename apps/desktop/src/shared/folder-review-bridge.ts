import type {
  FolderReviewOperationResult,
  FolderReviewSnapshot,
  FolderReviewStatus,
} from "./folder-review";

interface Target {
  root: string;
}
interface Commit extends Target {
  expectedRevision: number;
}
interface Selection extends Target {
  ids: string[];
}
export interface FolderReviewPreview {
  kind: "image" | "video" | "audio" | "text" | "unsupported";
  url?: string;
  text?: string;
}
export interface FolderReviewBridge {
  defaults(): Promise<{ tasksRoot: string }>;
  create(input: { name: string; folderName: string }): Promise<FolderReviewSnapshot>;
  renameTask(input: Commit & { name: string }): Promise<FolderReviewOperationResult>;
  open(root?: string): Promise<FolderReviewSnapshot | null>;
  refresh(root: string): Promise<FolderReviewSnapshot>;
  review(
    input: Commit & Selection & { status: FolderReviewStatus; note?: string },
  ): Promise<FolderReviewOperationResult>;
  mkdir(
    input: Commit & { parent: string; name: string },
  ): Promise<FolderReviewOperationResult>;
  rename(
    input: Commit & { id: string; name: string },
  ): Promise<FolderReviewOperationResult>;
  transfer(
    input: Commit & Selection & { destination: string; copy: boolean },
  ): Promise<FolderReviewOperationResult>;
  importFiles(
    input: Commit & { paths: string[]; destination: string },
  ): Promise<FolderReviewOperationResult>;
  copyOut(
    input: Commit & Selection & { destination?: string },
  ): Promise<FolderReviewOperationResult | null>;
  prepareDrag(input: Selection): Promise<string>;
  cancelDrag(token: string): void;
  startDrag(token: string): Promise<void>;
  showInFolder(input: Target & { id?: string }): Promise<void>;
  openFile(input: Target & { id: string }): Promise<void>;
  trash(
    input:
      | { root: string; trashRoot: true }
      | { root: string; ids: string[]; trashRoot?: false },
  ): Promise<{ trashedRoot: true } | FolderReviewSnapshot>;
  preview(input: Target & { id: string }): Promise<FolderReviewPreview>;
}
