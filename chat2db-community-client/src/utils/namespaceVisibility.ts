import { TreeNodeType } from '@/constants/tree';
import type { TreeNodeData } from '@/typings';

export interface SchemaVisibilityRule {
  showAll: boolean;
  ids: string[];
}

// showAllNamespaces covers databases, or the top-level schema list when the engine has no database level.
// schemaRules is keyed by the parent tree node. A missing rule means that list is still "all".
export interface NamespaceVisibility {
  showAllNamespaces: boolean;
  shownIds: string[];
  schemaRules: Record<string, SchemaVisibilityRule>;
  legacyHiddenIds: string[];
}

export type NamespaceVisibilityMap = Record<string, NamespaceVisibility>;

export interface StoredNamespaceVisibility {
  showAllNamespaces: boolean;
  shownTreeNodeIds: string[];
  hiddenTreeNodeIds: string[];
  schemaVisibility: Record<string, SchemaVisibilityRule>;
  visibility: NamespaceVisibility;
}

const emptyVisibility = (): NamespaceVisibility => ({
  showAllNamespaces: true,
  shownIds: [],
  schemaRules: {},
  legacyHiddenIds: [],
});

export function visibilityFromStored(record?: {
  hiddenTreeNodeIds?: string[] | null;
  showAllNamespaces?: boolean | null;
  shownTreeNodeIds?: string[] | null;
  schemaVisibility?: Record<string, SchemaVisibilityRule> | null;
} | null): NamespaceVisibility {
  if (!record) {
    return emptyVisibility();
  }
  if (record.showAllNamespaces === false || record.schemaVisibility) {
    return {
      showAllNamespaces: record.showAllNamespaces !== false,
      shownIds: record.shownTreeNodeIds || [],
      schemaRules: record.schemaVisibility || {},
      legacyHiddenIds: record.hiddenTreeNodeIds || [],
    };
  }
  if (record.hiddenTreeNodeIds?.length) {
    return {
      ...emptyVisibility(),
      legacyHiddenIds: record.hiddenTreeNodeIds,
    };
  }
  return emptyVisibility();
}

interface SchemaRuleNode {
  key?: string | number | null;
  extraParams?: { dataSourceId?: number; databaseName?: string } | null;
}

export function schemaRuleKey(node: SchemaRuleNode): string {
  const dataSourceId = node.extraParams?.dataSourceId;
  const databaseName = node.extraParams?.databaseName;
  if (dataSourceId == null) {
    return String(node.key ?? '');
  }
  if (databaseName) {
    return `dataSource_${dataSourceId}-database_${databaseName}`;
  }
  return `dataSource_${dataSourceId}`;
}

export function isNamespaceTreeNode(node: { treeNodeType?: string | null }): boolean {
  return node.treeNodeType === TreeNodeType.DATABASE || node.treeNodeType === TreeNodeType.SCHEMA;
}

export function isNamespaceNodeShown(node: TreeNodeData, visibility?: NamespaceVisibility | null): boolean {
  if (!visibility || !isNamespaceTreeNode(node)) {
    return true;
  }
  const key = String(node.key);
  if (visibility.legacyHiddenIds.includes(key)) {
    return false;
  }
  if (node.treeNodeType === TreeNodeType.DATABASE) {
    return visibility.showAllNamespaces || visibility.shownIds.includes(key);
  }
  const rule = visibility.schemaRules[schemaRuleKey(node)];
  if (!rule || rule.showAll) {
    return true;
  }
  return rule.ids.includes(key);
}

export function visibilityForDataSource(
  dataSourceId: number | string | null | undefined,
  namespaceVisibility?: NamespaceVisibilityMap | null,
  hiddenTreeNodeIds?: Record<string, string[]> | null,
): NamespaceVisibility {
  if (dataSourceId == null) {
    return emptyVisibility();
  }
  const stored = namespaceVisibility?.[dataSourceId];
  if (stored) {
    return stored;
  }
  const hiddenIds = hiddenTreeNodeIds?.[dataSourceId];
  if (hiddenIds?.length) {
    return { ...emptyVisibility(), legacyHiddenIds: hiddenIds };
  }
  return emptyVisibility();
}

export function filterShownNamespaceNodes(
  nodes: TreeNodeData[],
  visibility?: NamespaceVisibility | null,
): TreeNodeData[] {
  return nodes.filter((node) => isNamespaceNodeShown(node, visibility));
}

export function visibilityAfterCandidateSelection(
  previous: NamespaceVisibility | undefined,
  parentKey: string,
  candidates: TreeNodeData[],
  selectedKeys: string[],
): StoredNamespaceVisibility {
  const current = previous || emptyVisibility();
  const selected = new Set(selectedKeys);
  const candidateKeys = candidates.map((node) => String(node.key));
  const candidateSet = new Set(candidateKeys);
  const allSelected = candidateKeys.length > 0 && candidateKeys.every((key) => selected.has(key));
  const picked = candidateKeys.filter((key) => selected.has(key));
  const legacyHiddenIds = current.legacyHiddenIds.filter((key) => !candidateSet.has(key));
  const managesDatabases = candidates.some((node) => node.treeNodeType === TreeNodeType.DATABASE);
  const schemaRules = { ...current.schemaRules };

  if (managesDatabases) {
    const visibility: NamespaceVisibility = {
      showAllNamespaces: allSelected,
      shownIds: allSelected ? [] : picked,
      schemaRules,
      legacyHiddenIds,
    };
    return toStored(visibility);
  }

  schemaRules[parentKey] = allSelected ? { showAll: true, ids: [] } : { showAll: false, ids: picked };
  const visibility: NamespaceVisibility = {
    showAllNamespaces: current.showAllNamespaces,
    shownIds: current.shownIds,
    schemaRules,
    legacyHiddenIds,
  };
  return toStored(visibility);
}

function toStored(visibility: NamespaceVisibility): StoredNamespaceVisibility {
  return {
    showAllNamespaces: visibility.showAllNamespaces,
    shownTreeNodeIds: visibility.shownIds,
    hiddenTreeNodeIds: visibility.legacyHiddenIds,
    schemaVisibility: visibility.schemaRules,
    visibility,
  };
}

export function isNamespaceListRestricted(
  parentKey: string,
  nodes: TreeNodeData[],
  visibility?: NamespaceVisibility | null,
): boolean {
  if (!visibility) {
    return false;
  }
  if (nodes.some((node) => node.treeNodeType === TreeNodeType.DATABASE)) {
    return !visibility.showAllNamespaces;
  }
  if (nodes.some((node) => node.treeNodeType === TreeNodeType.SCHEMA)) {
    const rule = visibility.schemaRules[parentKey];
    return !!rule && !rule.showAll;
  }
  const schemaRule = visibility.schemaRules[parentKey];
  if (schemaRule && !schemaRule.showAll) {
    return true;
  }
  return !parentKey.includes('-database_') && !visibility.showAllNamespaces;
}

export function pruneHiddenNamespaceChildren(
  nodes: TreeNodeData[] | null | undefined,
  dataSourceId: number,
  visibility: NamespaceVisibility,
) {
  nodes?.forEach((node) => {
    const nodeDataSourceId = node.extraParams?.dataSourceId;
    if (nodeDataSourceId != null && nodeDataSourceId !== dataSourceId) {
      return;
    }
    if (isNamespaceTreeNode(node) && !isNamespaceNodeShown(node, visibility)) {
      node.children = undefined;
      return;
    }
    pruneHiddenNamespaceChildren(node.children, dataSourceId, visibility);
  });
}
