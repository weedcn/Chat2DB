import { useTreeStore } from '@/store/tree';
import { TreeNodeData } from '@/typings';
import { filterTreeNodesForDisplay } from '@/utils/filterTreeNodes';
import { useMemo } from 'react';
import { applyDatabaseObjectTreeSorting } from '../utils/sortTreeNodes';

export default function useTrimTreeData(props?: {
  leafNodes?: string[];
  hiddenNoPermission?: boolean;
  excludeNodes?: string[];
}): TreeNodeData[] | null {
  const { leafNodes, hiddenNoPermission, excludeNodes } = props || {};
  const { treeData, searchResult, namespaceVisibility, userConfigTree } = useTreeStore((state) => ({
    treeData: state.treeData,
    searchResult: state.searchResult,
    namespaceVisibility: state.namespaceVisibility,
    userConfigTree: state.userConfigTree,
  }));

  // filtered tree data
  const filteredTreeData = useMemo(() => {
    // initial data
    const _treeData = searchResult || treeData;

    if (!_treeData) {
      return null;
    }

    const filteredDatabaseAndSchema = filterTreeNodesForDisplay(_treeData, {
      namespaceVisibility,
      hiddenNoPermission,
      excludeNodes,
      leafNodes,
    });

    return applyDatabaseObjectTreeSorting(filteredDatabaseAndSchema, userConfigTree.sortDatabaseObjects === true);
  }, [
    searchResult,
    treeData,
    namespaceVisibility,
    hiddenNoPermission,
    excludeNodes,
    leafNodes,
    userConfigTree.sortDatabaseObjects,
  ]);

  return filteredTreeData;
}
