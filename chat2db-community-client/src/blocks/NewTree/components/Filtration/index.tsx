import React, { memo, useState, useEffect, useMemo, useRef } from 'react';
import { TreeNodeType } from '@/constants';
import { TreeNodeData } from '@/typings';
import { getDatabaseSupport } from '@/utils/database';
import NodeFiltering from '@/components/NodeFiltering';
import { ContextMenuRef } from '@/components/ContextMenu';
import { useTreeStore } from '@/store/tree';
import { normalizeTreeNodeLoadResult, treeConfig } from '@/blocks/NewTree/treeConfig';
import i18n from '@/i18n';
import {
  isNamespaceListRestricted,
  isNamespaceNodeShown,
  isNamespaceTreeNode,
  visibilityAfterCandidateSelection,
  type NamespaceVisibility,
} from '@/utils/namespaceVisibility';

interface IProps {
  className?: string;
  nodeData: TreeNodeData;
  styles: any;
  nodeFilteringRef: React.RefObject<ContextMenuRef>;
}

const namespaceNodesOf = (children: TreeNodeData[]) => children.filter(isNamespaceTreeNode);

const shownBadge = (parentKey: string, visibility: NamespaceVisibility | undefined, nodes: TreeNodeData[]) => {
  if (!nodes.length) {
    return isNamespaceListRestricted(parentKey, nodes, visibility)
      ? i18n('workspace.text.shownNamespacesPartial')
      : i18n('workspace.text.shownNamespacesAll');
  }
  const shownCount = nodes.filter((node) => isNamespaceNodeShown(node, visibility)).length;
  if (!isNamespaceListRestricted(parentKey, nodes, visibility) && shownCount === nodes.length) {
    return i18n('workspace.text.shownNamespacesAll');
  }
  return i18n('workspace.text.shownNamespacesCount', shownCount, nodes.length);
};

export default memo<IProps>((props) => {
  const { styles, nodeData, nodeFilteringRef } = props;
  const [isOpen, setIsOpen] = useState(false);
  const candidatesRef = useRef<TreeNodeData[]>([]);
  const dataSourceId = nodeData.extraParams?.dataSourceId;
  const treeDataRevision = useTreeStore((state) => state.treeDataRevision);
  const visibility = useTreeStore((state) => (
    dataSourceId == null ? undefined : state.namespaceVisibility?.[dataSourceId]
  ));
  const getChildrenByNodeId = useTreeStore((state) => state.getChildrenByNodeId);
  const setNamespaceVisibility = useTreeStore((state) => state.setNamespaceVisibility);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (isOpen && !(event.target as Element)?.closest('.nodeFilteringContainer')) {
        setIsOpen(false);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [isOpen]);

  const loadedNodes = useMemo(
    () => namespaceNodesOf(getChildrenByNodeId(nodeData.key)),
    [getChildrenByNodeId, nodeData.key, treeDataRevision],
  );

  if (![TreeNodeType.DATABASE, TreeNodeType.DATA_SOURCE].includes(nodeData.treeNodeType) || dataSourceId == null) {
    return null;
  }

  const { supportSchema } = getDatabaseSupport(nodeData.extraParams?.databaseType);
  if (!supportSchema && nodeData.treeNodeType === TreeNodeType.DATABASE) {
    return null;
  }

  const loadCandidates = async () => {
    if (loadedNodes.length > 0) {
      return loadedNodes;
    }
    const getChildren = treeConfig[nodeData.treeNodeType]?.getChildren;
    if (!getChildren) {
      return [];
    }
    const result = await getChildren(nodeData.extraParams);
    return namespaceNodesOf(normalizeTreeNodeLoadResult(result).children || []);
  };

  const handleOnChangeSelect = (keys: (string | null | undefined)[]) => {
    if (!candidatesRef.current.length) {
      return;
    }
    const selectedKeys = keys.filter((key): key is string => !!key);
    setNamespaceVisibility(
      dataSourceId,
      visibilityAfterCandidateSelection(visibility, String(nodeData.key), candidatesRef.current, selectedKeys),
    );
  };

  return (
    <div
      className={styles.filtration}
      onClick={(event) => {
        event.stopPropagation();
        if (isOpen) {
          nodeFilteringRef.current?.closeDropdown();
          setIsOpen(false);
          return;
        }
        const point = { clientX: event.clientX, clientY: event.clientY };
        void loadCandidates().then((nodes) => {
          candidatesRef.current = nodes;
          if (!nodes.length) {
            return;
          }
          const selectedKeys = nodes
            .filter((item) => isNamespaceNodeShown(item, visibility))
            .map((item) => String(item.key));
          nodeFilteringRef.current?.openDropdown({
            event: point,
            dropdownRender: (
              <div className="nodeFilteringContainer">
                <NodeFiltering
                  filterTitle={i18n('workspace.text.shownNamespacesAll')}
                  selectedKeys={selectedKeys}
                  onChangeSelect={handleOnChangeSelect}
                  data={nodes.map((item) => ({
                    title: item.originalTitle,
                    key: item.key,
                    count: null,
                  }))}
                />
              </div>
            ),
          });
          setIsOpen(true);
        })
          .catch(() => undefined);
      }}
    >
      {shownBadge(String(nodeData.key), visibility, loadedNodes)}
    </div>
  );
});
