import { AsyncLocalStorage } from "node:async_hooks";
import { bindAdapter } from '@prisma/driver-adapter-utils'
import { Pool } from "pg";
import { Request, Response, NextFunction } from "express";

import { PrismaPg } from './pg-adapter';
import { isContextComment, isWriteQuery, contextToSqlComment } from './pg-utils'
import { logger } from './logger'

const WRITE_OPERATIONS = ["create", "update", "upsert", "delete", "createMany", "updateMany", "deleteMany"]
const EXECUTE_RAW_UNSAFE_OPERATION = ["$executeRawUnsafe"]
const EXECUTE_OPERATIONS = ["$executeRaw", EXECUTE_RAW_UNSAFE_OPERATION]
const ASYNC_LOCAL_STORAGE = new AsyncLocalStorage();
const MAX_CONTEXT_SIZE = 1000000 // ~ 1MB

export const withPgAdapter = <PrismaClientType>(
  originalPrisma: PrismaClientType,
  { includeModels }: { includeModels?: string[] } = {},
): PrismaClientType => {
  const { logQueries } = (originalPrisma as any)._engineConfig

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
        const context = ASYNC_LOCAL_STORAGE.getStore()
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

  const { url } = prisma._engineConfig.overrideDatasources?.db ?? prisma._engineConfig.inlineDatasources.db
  const pool = new Pool({ connectionString: url.value || process.env[url.fromEnvVar] });
  const pgAdapter = new PrismaPg(pool, undefined, { logQueries });
  prisma._engineConfig.logQueries = false
  prisma._engineConfig.adapter = bindAdapter(pgAdapter);

  return prisma as PrismaClientType
}

// Next.js
export const setContext = (callback: (req: Request) => any) => {
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
      ASYNC_LOCAL_STORAGE.enterWith(context);
    },
  }
}

// Other
export const bemiContext = (context: any) => {
  ASYNC_LOCAL_STORAGE.enterWith(context);
}
