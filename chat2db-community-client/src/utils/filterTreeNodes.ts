import type { TreeNodeData } from '@/typings';
import { TreeNodeType } from '../constants/tree';
import {
  isNamespaceNodeShown,
  isNamespaceTreeNode,
  visibilityForDataSource,
  type NamespaceVisibility,
  type NamespaceVisibilityMap,
} from './namespaceVisibility';

export interface FilterTreeNodesOptions {
  hiddenTreeNodeIds?: Record<string, string[]> | null;
  namespaceVisibility?: NamespaceVisibilityMap | null;
  hiddenNoPermission?: boolean;
  excludeNodes?: string[];
  leafNodes?: string[];
}

export function filterTreeNodesForDisplay(
  treeData: TreeNodeData[],
  options: FilterTreeNodesOptions = {},
  inheritedVisibility?: NamespaceVisibility | null,
): TreeNodeData[] {
  const {
    hiddenTreeNodeIds,
    namespaceVisibility,
    hiddenNoPermission,
    excludeNodes,
    leafNodes,
  } = options;

  return treeData
    .map((node) => {
      const newNode = { ...node };
      const visibility = inheritedVisibility || visibilityForDataSource(
        newNode.extraParams?.dataSourceId,
        namespaceVisibility,
        hiddenTreeNodeIds,
      );

      if (excludeNodes?.includes(newNode.treeNodeType)) {
        return null;
      }

      if (
        hiddenNoPermission &&
        newNode.treeNodeType === TreeNodeType.DATA_SOURCE &&
        !newNode.extraParams?.hasPermission
      ) {
        return null;
      }

      if (isNamespaceTreeNode(newNode) && !isNamespaceNodeShown(newNode, visibility)) {
        return null;
      }

      if (leafNodes?.includes(newNode.treeNodeType)) {
        newNode.isLeaf = true;
        newNode.children = undefined;
      } else if (newNode.children) {
        newNode.children = filterTreeNodesForDisplay(newNode.children, options, visibility);
      }

      return newNode;
    })
    .filter((node): node is TreeNodeData => Boolean(node));
}
