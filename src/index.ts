import { AsyncLocalStorage } from "node:async_hooks";
import { Request, Response, NextFunction } from "express";

import { isContextComment, isWriteQuery, contextToSqlComment } from './pg-utils'
import { logger } from './logger'

export { PrismaPgAdapterFactory as PrismaPg } from './pg'

const WRITE_OPERATIONS = ["create", "update", "upsert", "delete", "createMany", "updateMany", "deleteMany"]
const EXECUTE_RAW_UNSAFE_OPERATION = ["$executeRawUnsafe"]
const EXECUTE_OPERATIONS = ["$executeRaw", EXECUTE_RAW_UNSAFE_OPERATION]
const ASYNC_LOCAL_STORAGE = new AsyncLocalStorage();
const MAX_CONTEXT_SIZE = 1000000 // ~ 1MB

export const withBemiExtension = <PrismaClientType>(
  originalPrisma: PrismaClientType,
  { includeModels = undefined, injectSqlInContext = false }: { includeModels?: string[], injectSqlInContext?: boolean } = {},
): PrismaClientType => {
  const prisma = (originalPrisma as any).$extends({
    query: {
      async $allOperations({ args, query, operation, model }: any) {
        // Not included model
        if (model && includeModels && !includeModels.includes(model)) {
          return query(args)
        }

        // Not contextualizable query
        if (
          !WRITE_OPERATIONS.includes(operation) &&
          (
            !EXECUTE_OPERATIONS.includes(operation) ||
            (args.strings && !args.strings.find((s: string) => isWriteQuery(s)))
          )
        ) {
          return query(args)
        }

        // Injected context query
        if (operation === EXECUTE_RAW_UNSAFE_OPERATION && args[0] && isContextComment(args[0])) {
          return query(args)
        }

        // There is no context or it's not an object
        const context = currentBemiContext()
        if (!context || context.constructor !== Object) return query(args)

        // Context is too large
        const contextComment = contextToSqlComment(context)
        if (contextComment.length > MAX_CONTEXT_SIZE) return query(args)

        logger.debug('EXTENSION:', operation, args)
        // The PG adapter will remove the transaction and add the comment
        // to the query directly to be executed as a single SQL statement
        const [, result] = await prisma.$transaction([
          prisma.$executeRawUnsafe(contextComment),
          query(args),
        ]);
        return result
      },
    },
  })

  const { logQueries } = (originalPrisma as any)._engineConfig
  prisma._engineConfig.logQueries = false
  prisma._engineConfig.adapter.logQueries = logQueries
  prisma._engineConfig.adapter.injectSqlInContext = injectSqlInContext

  return prisma as PrismaClientType
}

export const currentBemiContext = () => {
  return ASYNC_LOCAL_STORAGE.getStore();
}

export const setBemiContext = (context: any) => {
  ASYNC_LOCAL_STORAGE.enterWith(context);
}

export const mergeBemiContext = (context: any) => {
  const currentContext = currentBemiContext() || {};
  setBemiContext({ ...currentContext, ...context });
}

// Next.js
export const bemiMiddleware = (callback: (req: Request) => any) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const context = callback(req);

    ASYNC_LOCAL_STORAGE.run(context, () => {
      next();
    });
  };
};

// Apollo Server
export const BemiApolloServerPlugin = (callback: (requestContext: any) => any) => {
  return {
    async requestDidStart(requestContext: any) {
      const context = callback(requestContext);
      setBemiContext(context);
    },
  }
}
