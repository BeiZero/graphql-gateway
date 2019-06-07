import {
  GraphQLSchema,
  getNamedType,
  GraphQLField,
  GraphQLObjectType,
  ResponsePath,
  GraphQLResolveInfo
} from 'graphql';
const merge = require('deepmerge'); // https://github.com/KyleAMathews/deepmerge/pull/124

import {
  checkPermissionsAndAttributes,
  getTokenFromRequest,
  getDenialForRequest
} from './jwt';
import { getENV } from './env';
import { log } from './logger';

const GRAPHQL_PERMISSIONS_PATH_PREFIX = getENV(
  'GRAPHQL_PERMISSIONS_PATH_PREFIX',
  null
);

type FieldIteratorFn = (
  fieldDef: GraphQLField<any, any>,
  typeName: string,
  fieldName: string
) => void;

const forEachField = (schema: GraphQLSchema, fn: FieldIteratorFn): void => {
  const typeMap = schema.getTypeMap();
  Object.keys(typeMap).forEach(typeName => {
    const type = typeMap[typeName];
    if (
      !getNamedType(type).name.startsWith('__') &&
      type instanceof GraphQLObjectType
    ) {
      const fields = type.getFields();
      Object.keys(fields).forEach(fieldName => {
        const field = fields[fieldName];
        fn(field, typeName, fieldName);
      });
    }
  });
};

const getFullPath = (path: ResponsePath): string => {
  let parts: string[] = [];

  let currentPath: ResponsePath | undefined = path;
  do {
    if (currentPath) {
      if (typeof currentPath.key === 'string') {
        parts.unshift(currentPath.key);
      }
      currentPath = currentPath.prev;
    }
  } while (currentPath);

  return parts.join(':');
};

const getFirstDifferentPath = (
  object1: { [key: string]: any },
  object2: { [key: string]: any },
  parentPath: string | null = null
): { path: string; value1: any; value2: any } | undefined => {
  for (let key of Object.keys(object1)) {
    let value1 = object1[key];
    let value2 = object2[key];
    let path = parentPath ? parentPath + '.' + key : key;
    if (typeof value1 !== 'undefined' && typeof value2 !== 'undefined') {
      if (typeof value1 === 'object') {
        return getFirstDifferentPath(value1, value2, path);
      } else if (value1 !== value2) {
        return { value1, value2, path };
      }
    }
  }
  return undefined;
};

const fieldResolver = (prev, typeName, fieldName) => {
  return async (parent, args, ctx, info: GraphQLResolveInfo) => {
    let paths: string[] = [];

    const fullPath = getFullPath(info.path);
    paths.push(fullPath);

    if (info.operation.name) {
      paths.push(`${info.operation.name.value}:${fullPath}`);
    }

    paths.push(`${typeName}:${fieldName}`);

    let pathPrefix = GRAPHQL_PERMISSIONS_PATH_PREFIX;
    if (pathPrefix) {
      paths = paths.map(x => pathPrefix + ':' + x);
    }

    let tokenInfo = await getTokenFromRequest(ctx.req);

    const results = await Promise.all(
      paths.map(path => checkPermissionsAndAttributes(tokenInfo, path))
    );
    // let jwtInfo = await checkPermissionsAndAttributes(tokenInfo, path);
    // let jwtTypeInfo = await checkPermissionsAndAttributes(tokenInfo, typePath);

    const allowedRules = results.filter(r => r.allowed);
    if (allowedRules.length === 0) {
      const firstDeniedRule = results[0];
      let denialReson: string | null = null;
      const rule = getDenialForRequest(tokenInfo, firstDeniedRule.resource);
      denialReson = rule && rule.toString();
      throw new Error(
        `access denied for '${results
          .map(r => r.resource)
          .join("','")}'; failed rule ${denialReson}`
      );
    }

    const newArgs = merge(...results.map(r => r.attributes || {}));

    const diff = getFirstDifferentPath(args, newArgs);
    if (diff) {
      throw new Error(
        `cannot fetch attribute '${diff.path}' with value ${JSON.stringify(
          diff.value1
        )} (expected: ${JSON.stringify(diff.value2)})`
      );
    }

    log('applying args', newArgs, 'to', args);
    args = merge(args, newArgs);
    log('args after apply', args);

    return prev(parent, args, ctx, info);
  };
};

export const addPermissionsToSchema = (schema: GraphQLSchema) => {
  forEachField(schema, (field: GraphQLField<any, any>, typeName, fieldName) => {
    if (field.resolve) {
      const prev = field.resolve;
      field.resolve = fieldResolver(prev, typeName, fieldName);
    }
  });
};
