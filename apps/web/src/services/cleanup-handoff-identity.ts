/**
 * Locale-independent legacy handoff identity. These historical Chinese bytes
 * participate in persisted equality checks; display copy must stay separate.
 * i18n-data: legacy cleanup identity (not rendered UI).
 */
const LEGACY_ACTION_LABELS: Readonly<Record<string, string>> = {
  "purge-media": "清理不再使用的应用内素材",
  "recycle-nodes": "将所选存档移入回收站",
  "restore-nodes": "恢复所选存档",
  "purge-deleted-nodes": "永久删除回收站中的所选存档",
  "purge-cache": "清理可重建缓存",
  "purge-failed-jobs": "清理失败任务记录",
  "purge-work-files": "清理选中的临时文件与未采用结果",
};

export function legacyCleanupHandoffIdentity(overrideAction: string, effectiveNodes: readonly string[], workFileIds: readonly string[]) {
  return {
    scope: `${LEGACY_ACTION_LABELS[overrideAction]}；选中节点 ${effectiveNodes.length} 个${overrideAction === "purge-work-files" ? `；选中过程文件 ${workFileIds.join(", ")}` : ""}。另审查未采用生成尝试和失败作业残留，无法确认用途的文件保留。`,
    retention: "保留原件、成片、审阅工作台、模板、素材库、草稿/恢复、撤销/重做、后继节点和活动作业输入；导出完成不授权删除源素材。",
  };
}
