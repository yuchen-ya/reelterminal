import type { JSX } from "react";
import { ImageOff, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ImagePayloadView, WorkbenchMediaRef } from "../../types";

export interface ImagePlaceholderProps {
  readonly payload?: ImagePayloadView;
  readonly originalMedia?: WorkbenchMediaRef;
  readonly imgError: boolean;
  readonly imageError?: string;
  readonly currentItemTitle: string;
}

export function ImagePlaceholder({
  payload,
  originalMedia,
  imgError,
  imageError,
  currentItemTitle,
}: ImagePlaceholderProps): JSX.Element {
  if (!payload || !originalMedia) {
    return (
      <div className="flex max-w-md flex-col items-center gap-2 rounded-xl border border-border bg-bg-1 px-6 py-8 text-center">
        <ImageOff className="h-6 w-6 text-fg-3" />
        <div className="text-sm text-fg-2">图像数据未提供</div>
        <div className="text-xs text-fg-3">该条目缺少图像载荷，无法审阅</div>
      </div>
    );
  }
  if (originalMedia.status === "loading") {
    return (
      <div className="flex max-w-md flex-col items-center gap-2 rounded-xl border border-border bg-bg-1 px-6 py-8 text-center">
        <LoaderCircle className="h-6 w-6 animate-spin text-fg-3" />
        <div className="text-sm text-fg-2">媒体加载中…</div>
        <div className="text-xs text-fg-3">{originalMedia.displayName}</div>
      </div>
    );
  }
  if (originalMedia.status === "error") {
    return (
      <div className="flex max-w-md flex-col items-center gap-2 rounded-xl border border-status-error/40 bg-bg-1 px-6 py-8 text-center">
        <TriangleAlert className="h-6 w-6 text-status-error" />
        <div className="text-sm text-fg-2">媒体加载失败</div>
        <div className="text-xs text-status-error">{originalMedia.error ?? "未知错误"}</div>
      </div>
    );
  }
  if (originalMedia.status === "unavailable") {
    return (
      <div className="flex max-w-md flex-col items-center gap-2 rounded-xl border border-border bg-bg-1 px-6 py-8 text-center">
        <ImageOff className="h-6 w-6 text-fg-3" />
        <div className="text-sm text-fg-2">媒体不可用</div>
        <div className="text-xs text-fg-3">
          {originalMedia.error ?? "原始媒体文件不存在或已被丢弃"}
        </div>
      </div>
    );
  }
  if (imgError) {
    return (
      <div className="flex max-w-md flex-col items-center gap-2 rounded-xl border border-status-error/40 bg-bg-1 px-6 py-8 text-center">
        <TriangleAlert className="h-6 w-6 text-status-error" />
        <div className="text-sm text-fg-2">{imageError ?? "图片加载失败"}</div>
        <div className="text-xs text-status-error">{originalMedia.displayName ?? currentItemTitle}</div>
      </div>
    );
  }
  return (
    <div className="flex max-w-md flex-col items-center gap-2 rounded-xl border border-border bg-bg-1 px-6 py-8 text-center">
      <LoaderCircle className="h-6 w-6 animate-spin text-fg-3" />
      <div className="text-sm text-fg-2">媒体未就绪</div>
      <div className="text-xs text-fg-3">原始媒体仅当前条目可用</div>
    </div>
  );
}
