/** Version-2 stores share the existing material DB; no project migration runs here. */
export function upgradeReviewStores(database: IDBDatabase): void {
  const definitions: Array<{ name: string; keyPath: string | string[]; indexes?: Array<[string, string | string[], boolean?]> }> = [
    { name: "reviewWorkspaces", keyPath: "id" },
    { name: "reviewGroups", keyPath: "id", indexes: [["workspace", ["workspaceId", "order", "id"]]] },
    { name: "reviewNodes", keyPath: "id", indexes: [["workspace", ["workspaceId", "updatedAt", "id"]], ["group", ["workspaceId", "groupId", "id"]]] },
    { name: "reviewBatches", keyPath: "id", indexes: [["node", ["nodeId", "id"]]] },
    { name: "reviewItems", keyPath: "id", indexes: [["node", ["nodeId", "id"]], ["batch", ["nodeId", "batchId", "orderIndex", "id"]], ["batchStatus", ["nodeId", "batchId", "status", "id"]], ["status", ["nodeId", "status", "id"]]] },
    { name: "reviewVersions", keyPath: ["itemId", "version"], indexes: [["item", "itemId"], ["node", "nodeId"]] },
    { name: "reviewFeedback", keyPath: "id", indexes: [["itemVersion", ["itemId", "itemVersion", "id"]], ["node", "nodeId"]] },
    { name: "reviewHandoffs", keyPath: "id", indexes: [["node", ["nodeId", "id"]]] },
    { name: "reviewSteps", keyPath: "id", indexes: [["run", ["nodeId", "runId", "id"]], ["inputs", "inputKeys", true], ["outputs", "outputKeys", true]] },
    { name: "reviewJournal", keyPath: ["scopeId", "sequence"], indexes: [["scope", "scopeId"]] },
    { name: "reviewEvents", keyPath: ["scopeId", "sequence"] },
    { name: "reviewArchives", keyPath: "nodeId" },
    { name: "reviewUsages", keyPath: "requestId", indexes: [["node", "nodeId"]] },
    { name: "reviewMigrations", keyPath: ["sourceProjectId", "sourceWorkspaceId", "sourceDigest", "migrationVersion"] },
    { name: "reviewMigrationSources", keyPath: ["sourceProjectId", "sourceWorkspaceId"] },
    { name: "reviewOperations", keyPath: "operationId", indexes: [["scope", ["scopeId", "sequence"]]] },
    { name: "fileResources", keyPath: "id" },
    { name: "resourceRefs", keyPath: "id", indexes: [["resource", "resourceId"], ["owner", "ownerId"], ["node", "nodeId"]] },
  ];
  for (const definition of definitions) {
    if (database.objectStoreNames.contains(definition.name)) continue;
    const store = database.createObjectStore(definition.name, { keyPath: definition.keyPath });
    for (const [name, keyPath, multiEntry] of definition.indexes ?? []) {
      store.createIndex(name, keyPath, { multiEntry: multiEntry ?? false });
    }
  }
}
