import { AsyncLocalStorage } from "node:async_hooks";
import { bindAdapter } from '@prisma/driver-adapter-utils'
import { Pool } from "pg";
import { Request, Response, NextFunction } from "express";

import { PrismaPg } from './pg-adapter';
import { isBemiContext, isWriteQuery } from './pg-utils'
import { log } from './logger'

const WRITE_OPERATIONS = ["create", "update", "upsert", "delete", "createMany", "updateMany", "deleteMany"]
const EXECUTE_OPERATIONS = ["$executeRaw", "$executeRawUnsafe"]
const ASYNC_LOCAL_STORAGE = new AsyncLocalStorage();

export const withPgAdapter = (originalPrisma: any) => {
  const { logQueries } = originalPrisma._engineConfig

  const prisma = originalPrisma.$extends({
    query: {
      async $allOperations({ args, query, operation }: any) {
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
        if (operation === '$executeRawUnsafe' && args[0] && isBemiContext(args[0])) {
          return query(args)
        }

        // There is no context
        const context = ASYNC_LOCAL_STORAGE.getStore()
        if (!context) return query(args)

        log('EXTENSION:', operation, args)

        // The PG adapter will remove the transaction and add the comment
        // to the query directly to be executed as a single SQL statement
        const [, result] = await prisma.$transaction([
          prisma.$executeRawUnsafe(`/*Bemi ${JSON.stringify(context)} Bemi*/`),
          query(args),
        ]);
        return result
      },
    },
  })

  const { url } = prisma._engineConfig.inlineDatasources.db
  const pool = new Pool({ connectionString: url.value || process.env[url.fromEnvVar] });
  const pgAdapter = new PrismaPg(pool, undefined, { logQueries });
  prisma._engineConfig.logQueries = false
  prisma._engineConfig.adapter = bindAdapter(pgAdapter);

  return prisma
}

export const setContext = (callback: (req: Request) => any) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const context = callback(req);

    ASYNC_LOCAL_STORAGE.run(context, () => {
      next();
    });
  };
};

export const BemiApolloServerPlugin = (callback: (requestContext: any) => any) => {
  return {
    async requestDidStart(requestContext: any) {
      const context = callback(requestContext);
      ASYNC_LOCAL_STORAGE.enterWith(context);
    },
  }
}
