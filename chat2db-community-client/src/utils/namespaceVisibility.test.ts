import assert from 'node:assert/strict';
import { TreeNodeType } from '@/constants/tree';
import type { TreeNodeData } from '@/typings';
import { filterTreeNodesForDisplay } from './filterTreeNodes';
import {
  filterShownNamespaceNodes,
  isNamespaceNodeShown,
  visibilityAfterCandidateSelection,
  visibilityFromStored,
} from './namespaceVisibility';

assert.equal(visibilityFromStored(null).showAllNamespaces, true);
assert.deepEqual(visibilityFromStored({ hiddenTreeNodeIds: ['database-old'] }).legacyHiddenIds, ['database-old']);

const database = (key: string, name = key): TreeNodeData => ({
  key,
  originalTitle: name,
  title: null,
  treeNodeType: TreeNodeType.DATABASE,
  extraParams: { dataSourceId: 7, databaseName: name },
});

const schema = (key: string, databaseName: string): TreeNodeData => ({
  key,
  originalTitle: key,
  title: null,
  treeNodeType: TreeNodeType.SCHEMA,
  extraParams: { dataSourceId: 7, databaseName },
});

const databases = [database('dataSource_7-database_app', 'app'), database('dataSource_7-database_new', 'new')];
const partial = visibilityAfterCandidateSelection(undefined, 'dataSource_7', databases, ['dataSource_7-database_app']);
assert.equal(partial.showAllNamespaces, false);
assert.deepEqual(partial.shownTreeNodeIds, ['dataSource_7-database_app']);
assert.equal(isNamespaceNodeShown(databases[1], partial.visibility), false);
assert.equal(isNamespaceNodeShown(schema('dataSource_7-database_app-schema_public', 'app'), partial.visibility), true);

const schemas = [
  schema('dataSource_7-database_app-schema_public', 'app'),
  schema('dataSource_7-database_app-schema_secret', 'app'),
];
const schemaSelection = visibilityAfterCandidateSelection(
  partial.visibility,
  'dataSource_7-database_app',
  schemas,
  ['dataSource_7-database_app-schema_public'],
);
assert.deepEqual(schemaSelection.shownTreeNodeIds, ['dataSource_7-database_app']);
assert.equal(isNamespaceNodeShown(schemas[0], schemaSelection.visibility), true);
assert.equal(isNamespaceNodeShown(schemas[1], schemaSelection.visibility), false);
assert.equal(isNamespaceNodeShown(schema('dataSource_7-database_app-schema_later', 'app'), schemaSelection.visibility), false);

const showAll = visibilityAfterCandidateSelection(schemaSelection.visibility, 'dataSource_7', databases, databases.map((node) => String(node.key)));
assert.equal(showAll.showAllNamespaces, true);
assert.equal(isNamespaceNodeShown(databases[1], showAll.visibility), true);
assert.equal(isNamespaceNodeShown(schemas[1], showAll.visibility), false);

const shown = filterShownNamespaceNodes(databases, partial.visibility);
assert.deepEqual(shown.map((node) => node.key), ['dataSource_7-database_app']);

const visibleTree = filterTreeNodesForDisplay(
  [
    {
      key: 'dataSource_7',
      originalTitle: 'local',
      title: null,
      treeNodeType: TreeNodeType.DATA_SOURCE,
      extraParams: { dataSourceId: 7 },
      children: [
        {
          ...databases[0],
          children: schemas,
        },
        {
          ...databases[1],
          children: [
            {
              key: 'tables',
              originalTitle: 'tables',
              title: null,
              treeNodeType: TreeNodeType.TABLES,
              extraParams: { dataSourceId: 7 },
            },
          ],
        },
      ],
    },
  ],
  { namespaceVisibility: { 7: schemaSelection.visibility } },
);
assert.deepEqual(visibleTree[0].children?.map((node) => node.key), ['dataSource_7-database_app']);
assert.deepEqual(visibleTree[0].children?.[0].children?.map((node) => node.key), ['dataSource_7-database_app-schema_public']);

console.log('namespaceVisibility.test.ts: all assertions passed');
