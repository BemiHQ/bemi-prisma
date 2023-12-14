import { AsyncLocalStorage } from "node:async_hooks";
import { bindAdapter } from '@prisma/driver-adapter-utils'
import { Pool } from "pg";
import { Request, Response, NextFunction } from "express";

import { PgAdapter } from './pg-adapter';

const WRITE_METHODS = ["create", "update", "upsert", "delete", "createMany", "updateMany", "deleteMany"]
const ASYNC_LOCAL_STORAGE = new AsyncLocalStorage();

export const withPgAdapter = (
  originalPrisma: any,
  { disableExtension, disableAdapterModification }: { disableExtension?: boolean, disableAdapterModification?: boolean } = {}
) => {
  const { logQueries } = originalPrisma._engineConfig

  const prisma = originalPrisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query, operation }: any) {
          if (disableExtension) return query(args)

          if (!WRITE_METHODS.includes(operation)) return query(args)

          const context = ASYNC_LOCAL_STORAGE.getStore()
          if (!context) return query(args)

          // The PG adapter will remove the transaction and add the comment
          // to the query directly to be executed as a single SQL statement
          const [, result] = await prisma.$transaction([
            prisma.$executeRawUnsafe(`/*Bemi ${JSON.stringify(context)} Bemi*/`),
            query(args),
          ]);
          return result;
        },
      },
    },
  })

  const { url } = prisma._engineConfig.inlineDatasources.db
  const pool = new Pool({ connectionString: url.value || process.env[url.fromEnvVar] });
  const pgAdapter = new PgAdapter(pool, undefined, { disableAdapterModification, logQueries: logQueries });
  if (!disableAdapterModification) prisma._engineConfig.logQueries = false
  prisma._engineConfig.adapter = bindAdapter(pgAdapter);

  return prisma
}

export const setContext = (prisma: any, callback: (req: Request) => any) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const context = callback(req);

    ASYNC_LOCAL_STORAGE.run(context, () => {
      next();
    });
  };
};
