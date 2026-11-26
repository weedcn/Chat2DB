import { normalizeTreeNodeLoadResult, treeConfig } from '@/blocks/NewTree/treeConfig';
import { filterShownNamespaceNodes } from '@/utils/namespaceVisibility';
import type { TreeNodeData } from '@/typings';
import { DatabaseTypeCode, TreeNodeType } from '@/constants';
import { databaseMap } from '@/constants/database';
import { useTreeStore } from '@/store/tree';
import { getDatabaseSupport } from '@/utils/database';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  activateSelectDatabaseRequests,
  createSelectDatabaseRequestLifecycle,
  disposeSelectDatabaseRequests,
  hasApplicableDatabaseNameChange,
  invalidateDatabaseOptionRequests,
  invalidateDataSourceOptionRequests,
  normalizeDataSourceOptions,
  normalizeDatabaseOptions,
  normalizeSchemaOptions,
  runDatabaseOptionRequest,
  runSchemaOptionRequest,
} from './selectDatabaseRequestLifecycle';

export type ISelectDatabase = {
  dataSourceId?: number;
  databaseType?: DatabaseTypeCode;
  databaseName?: string;
  schemaName?: string;
  supportSchema?: boolean;
  supportDatabase?: boolean;
  selectDone?: boolean;
} | null;

type IChangedValues = {
  dataSourceId?: number;
  databaseName?: string;
  schemaName?: string;
};

interface IUseSelectDatabaseProps {
  astrictDatabaseType?: DatabaseTypeCode;
}

const useSelectDatabase = (props: IUseSelectDatabaseProps) => {
  const { astrictDatabaseType } = props;
  const treeDataSourceList = useTreeStore((state) => state.dataSourceList);
  const dataSourceList = useMemo(
    () => (treeDataSourceList === null ? null : normalizeDataSourceOptions(treeDataSourceList)),
    [treeDataSourceList],
  );
  const [databaseNodes, setDatabaseNodes] = useState<TreeNodeData[] | null>([]);
  const [schemaNodes, setSchemaNodes] = useState<TreeNodeData[] | null>([]);
  const [selectDatabase, setSelectDatabase] = useState<ISelectDatabase>();
  const namespaceVisibility = useTreeStore((state) => (
    selectDatabase?.dataSourceId == null ? undefined : state.namespaceVisibility?.[selectDatabase.dataSourceId]
  ));
  const databaseList = useMemo(
    () => (databaseNodes === null
      ? null
      : normalizeDatabaseOptions(filterShownNamespaceNodes(databaseNodes, namespaceVisibility))),
    [databaseNodes, namespaceVisibility],
  );
  const schemaList = useMemo(
    () => (schemaNodes === null
      ? null
      : normalizeSchemaOptions(filterShownNamespaceNodes(schemaNodes, namespaceVisibility))),
    [schemaNodes, namespaceVisibility],
  );
  const requestLifecycleRef = useRef(createSelectDatabaseRequestLifecycle());
  const requestLifecycle = requestLifecycleRef.current;

  useEffect(() => {
    activateSelectDatabaseRequests(requestLifecycle);
    return () => {
      disposeSelectDatabaseRequests(requestLifecycle);
    };
  }, [requestLifecycle]);

  useEffect(() => {
    invalidateDataSourceOptionRequests(requestLifecycle);
    setDatabaseNodes([]);
    setSchemaNodes([]);

    if (astrictDatabaseType) {
      const { supportSchema, supportDatabase } = databaseMap[astrictDatabaseType];
      setSelectDatabase({
        dataSourceId: undefined,
        databaseName: undefined,
        schemaName: undefined,
        databaseType: undefined,
        supportSchema,
        supportDatabase,
      });
      return;
    }
    setSelectDatabase(null);
  }, [astrictDatabaseType, requestLifecycle]);

  const astrictDataSourceList = useMemo(() => {
    if (astrictDatabaseType) {
      return dataSourceList?.filter((item) => item.databaseType === astrictDatabaseType);
    }
    return dataSourceList;
  }, [dataSourceList, astrictDatabaseType]);

  const getDatabaseList = (params: { dataSourceId: number; databaseType: DatabaseTypeCode }) => {
    invalidateDatabaseOptionRequests(requestLifecycle);
    setDatabaseNodes(null);
    setSchemaNodes([]);

    const getChildren = treeConfig[TreeNodeType.DATA_SOURCE].getChildren;
    if (!getChildren) {
      setDatabaseNodes([]);
      return;
    }

    void runDatabaseOptionRequest(
      requestLifecycle,
      () =>
        getChildren({
          ...params,
          refresh: true,
        }),
      (res) => setDatabaseNodes(normalizeTreeNodeLoadResult(res).children || []),
      () => setDatabaseNodes([]),
    );
  };

  const getSchemaList = (params: NonNullable<ISelectDatabase>) => {
    setSchemaNodes(null);

    const getChildren = treeConfig[TreeNodeType.DATABASE].getChildren;
    if (!getChildren) {
      setSchemaNodes([]);
      return;
    }

    void runSchemaOptionRequest(
      requestLifecycle,
      () =>
        getChildren({
          ...params,
          refresh: true,
        }),
      (res) => setSchemaNodes(normalizeTreeNodeLoadResult(res).children || []),
      () => setSchemaNodes([]),
    );
  };

  const isSelectDone = (params: ISelectDatabase) => {
    if (params?.supportDatabase && !params.databaseName) {
      return false;
    }
    if (params?.supportSchema && !params.schemaName) {
      return false;
    }
    return true;
  };

  const resetSelectDatabase = (): ISelectDatabase => {
    if (!astrictDatabaseType) {
      return null;
    }
    const { supportSchema, supportDatabase } = databaseMap[astrictDatabaseType];
    return {
      databaseType: undefined,
      supportSchema,
      supportDatabase,
      selectDone: false,
    };
  };

  const onChangeSelectDatabase = (changedValues: IChangedValues) => {
    let newSelectDatabase: ISelectDatabase = {
      ...selectDatabase,
    };

    if ('dataSourceId' in changedValues) {
      invalidateDataSourceOptionRequests(requestLifecycle);
      setDatabaseNodes([]);
      setSchemaNodes([]);
      const dataSource = astrictDataSourceList?.find((item) => item.value === changedValues.dataSourceId);

      if (!dataSource) {
        if (changedValues.dataSourceId !== undefined) {
          return;
        }
        setSelectDatabase(resetSelectDatabase());
        return;
      }

      const databaseType = dataSource.databaseType;
      const { supportSchema, supportDatabase } = getDatabaseSupport(databaseType);
      newSelectDatabase = {
        dataSourceId: dataSource.value,
        databaseName: undefined,
        schemaName: undefined,
        selectDone: !supportDatabase && !supportSchema,
        databaseType,
        supportSchema,
        supportDatabase,
      };

      if (supportDatabase) {
        getDatabaseList({
          dataSourceId: dataSource.value,
          databaseType,
        });
      } else if (supportSchema) {
        getSchemaList(newSelectDatabase);
      }
    }

    if (hasApplicableDatabaseNameChange(changedValues, newSelectDatabase?.supportDatabase)) {
      invalidateDatabaseOptionRequests(requestLifecycle);
      setSchemaNodes([]);
      newSelectDatabase = {
        ...newSelectDatabase,
        schemaName: undefined,
        databaseName: changedValues.databaseName,
      };
      newSelectDatabase.selectDone = isSelectDone(newSelectDatabase);
      if (changedValues.databaseName && newSelectDatabase.supportSchema) {
        getSchemaList(newSelectDatabase);
      }
    }

    if ('schemaName' in changedValues) {
      newSelectDatabase = {
        ...newSelectDatabase,
        schemaName: changedValues.schemaName,
      };
      newSelectDatabase.selectDone = isSelectDone(newSelectDatabase);
    }
    setSelectDatabase(newSelectDatabase);
  };

  useEffect(() => {
    setSelectDatabase((current) => {
      if (!current) {
        return current;
      }
      if (current.databaseName && databaseList && current.supportDatabase
        && !databaseList.some((item) => item.value === current.databaseName)) {
        return { ...current, databaseName: undefined, schemaName: undefined, selectDone: false };
      }
      if (current.schemaName && schemaList && current.supportSchema
        && !schemaList.some((item) => item.value === current.schemaName)) {
        return { ...current, schemaName: undefined, selectDone: false };
      }
      return current;
    });
  }, [databaseList, schemaList]);

  return {
    dataSourceList: astrictDataSourceList,
    databaseList,
    schemaList,
    selectDatabase,
    onChangeSelectDatabase,
  };
};

export default useSelectDatabase;
