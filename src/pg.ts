/* eslint-disable @typescript-eslint/require-await */

import type {
  ColumnType,
  ConnectionInfo,
  IsolationLevel,
  SqlDriverAdapter,
  SqlMigrationAwareDriverAdapterFactory,
  SqlQuery,
  SqlQueryable,
  SqlResultSet,
  Transaction,
  TransactionOptions,
} from '@prisma/driver-adapter-utils'
import { Debug, DriverAdapterError } from '@prisma/driver-adapter-utils'
// @ts-ignore: this is used to avoid the `Module '"<path>/node_modules/@types/pg/index"' has no default export.` error.
import pg from 'pg'

const packageName = '@prisma/adapter-pg' // PATCH: ignore import { name as packageName } from '../package.json'
import { customParsers, fieldToColumnType, fixArrayBufferValues, UnsupportedNativeDataType } from './conversion'
import { convertDriverError } from './errors'

const types = pg.types

const debug = Debug('prisma:driver-adapter:pg')

// PATCH: Import additional things
import { logger } from './logger'
import {
  StdClient,
  TransactionClient,
  EMPTY_RESULT,
  contextToSqlComment,
  sqlCommentToContext,
  isContextComment,
  isWriteQuery,
  isBeginQuery,
  isCommitQuery,
} from './pg-utils'
// PATCH: end

class PgQueryable<ClientT extends StdClient | TransactionClient> implements SqlQueryable {
  readonly provider = 'postgres'
  readonly adapterName = packageName

  constructor(protected readonly client: ClientT) {}

  /**
   * Execute a query given as SQL, interpolating the given parameters.
   */
  async queryRaw(query: SqlQuery): Promise<SqlResultSet> {
    const tag = '[js::query_raw]'
    debug(`${tag} %O`, query)

    const { fields, rows } = await this.performIO(query)

    const columnNames = fields.map((field) => field.name)
    let columnTypes: ColumnType[] = []

    try {
      columnTypes = fields.map((field) => fieldToColumnType(field.dataTypeID))
    } catch (e) {
      if (e instanceof UnsupportedNativeDataType) {
        throw new DriverAdapterError({
          kind: 'UnsupportedNativeDataType',
          type: e.type,
        })
      }
      throw e
    }

    return {
      columnNames,
      columnTypes,
      rows,
    }
  }

  /**
   * Execute a query given as SQL, interpolating the given parameters and
   * returning the number of affected rows.
   * Note: Queryable expects a u64, but napi.rs only supports u32.
   */
  async executeRaw(query: SqlQuery): Promise<number> {
    const tag = '[js::execute_raw]'
    debug(`${tag} %O`, query)

    // Note: `rowsAffected` can sometimes be null (e.g., when executing `"BEGIN"`)
    return (await this.performIO(query)).rowCount ?? 0
  }

  /**
   * Run a query against the database, returning the result set.
   * Should the query fail due to a connection error, the connection is
   * marked as unhealthy.
   */
  private async performIO(query: SqlQuery, catchingUp = false): Promise<pg.QueryArrayResult<any>> { // PATCH: pass an extra argument

    try {
      const result = await this.compactPerformIOResult(query, catchingUp) // PATCH: Call compactPerformIOResult
      return result
    } catch (e: any) { // PATCH: Fix TypeScript errors
      this.onError(e)
    }
  }

  protected onError(error: any): never {
    debug('Error in performIO: %O', error)
    throw new DriverAdapterError(convertDriverError(error))
  }

  // PATCH: Remove unnnecessary transactions
  private async compactPerformIOResult(query: SqlQuery, catchingUp: boolean): Promise<pg.QueryResult> {
    const { sql, args: values } = query
    const transactionClient = this.client as TransactionClient
    const { previousQueries, readyToExecuteTransaction } = transactionClient

    let text = sql

    // Modify the execution
    if (this.client.logQueries && !catchingUp) {
      logger.debug('QUERY:', sql, previousQueries ? previousQueries.length : '')
    }

    // Transaction queries
    if (previousQueries) {
      const isContext = isContextComment(sql)
      const isWrite = isWriteQuery(sql)
      const previousContextComment = previousQueries.find((q) => isContextComment(q.sql))?.sql

      if (previousContextComment && isWrite) {
        text = `${sql} ${contextToSqlComment({ SQL: sql, ...sqlCommentToContext(previousContextComment) })}`
      }

      if (!catchingUp) {
        previousQueries.push(query)
      }

      // Skip accumulated queries or catch up and mark the transaction as ready to execute
      if (!readyToExecuteTransaction) {
        // Skip accumulated BEGIN
        if (isBeginQuery(sql) && previousQueries.length === 1) return EMPTY_RESULT

        // Skip accumulated COMMIT
        if (isCommitQuery(sql) && previousContextComment && previousQueries.length === 4) return EMPTY_RESULT

        // Catch up and continue the entire transaction
        if (
          (previousQueries.length === 2 && !isContext) ||
          (previousQueries.length === 3 && !isWrite)
        ) {
          transactionClient.readyToExecuteTransaction = true
          for(const prevQuery of previousQueries.slice(0, previousQueries.length - 1)) {
            await this.performIO(prevQuery as SqlQuery, true)
          }
        }
      }

      // Skip accumulated context
      if (isContextComment(sql)) return EMPTY_RESULT
    }

    // Log modified queries
    if (this.client.logQueries) {
      logger.log(`${logger.tags['info'] ?? ''}`, text)
    }

    const result = await this.client.query(
      {
        text,
        values: fixArrayBufferValues(values),
        rowMode: 'array',
        types: {
          // This is the error expected:
          // No overload matches this call.
          // The last overload gave the following error.
          // Type '(oid: number, format?: any) => (json: string) => unknown' is not assignable to type '{ <T>(oid: number): TypeParser<string, string | T>; <T>(oid: number, format: "text"): TypeParser<string, string | T>; <T>(oid: number, format: "binary"): TypeParser<...>; }'.
          //   Type '(json: string) => unknown' is not assignable to type 'TypeParser<Buffer, any>'.
          //     Types of parameters 'json' and 'value' are incompatible.
          //       Type 'Buffer' is not assignable to type 'string'.ts(2769)
          //
          // Because pg-types types expect us to handle both binary and text protocol versions,
          // where as far we can see, pg will ever pass only text version.
          //
          // @ts-expect-error
          getTypeParser: (oid: number, format: binary) => {
            if (format === 'text' && customParsers[oid]) {
              return customParsers[oid]
            }

            return types.getTypeParser(oid, format)
          },
        },
      },
      fixArrayBufferValues(values),
    )

    return result
  }
  // PATCH: end
}

class PgTransaction extends PgQueryable<TransactionClient> implements Transaction {
  constructor(client: TransactionClient, readonly options: TransactionOptions) { // PATCH: Fix TypeScript errors
    super(client)
  }

  async commit(): Promise<void> {
    debug(`[js::commit]`)

    this.client.release()
  }

  async rollback(): Promise<void> {
    debug(`[js::rollback]`)

    this.client.release()
  }
}

export type PrismaPgOptions = {
  schema?: string
}

export class PrismaPgAdapter extends PgQueryable<StdClient> implements SqlDriverAdapter {
  // PATCH: Add logQueries
  logQueries: boolean
  constructor(client: StdClient, private options?: PrismaPgOptions, private readonly release?: () => Promise<void>, { logQueries }: { logQueries?: boolean } = {}) {
    client.logQueries = logQueries || false
    super(client)
    this.logQueries = client.logQueries
  }
  // PATCH: end

  async startTransaction(isolationLevel?: IsolationLevel): Promise<Transaction> {
    const options: TransactionOptions = {
      usePhantomQuery: false,
    }

    const tag = '[js::startTransaction]'
    debug('%s options: %O', tag, options)

    // PATCH: Customize connection
    const conn = await this.client.connect().catch((error) => this.onError(error)) as TransactionClient
    conn.previousQueries = []
    conn.logQueries = this.logQueries
    conn.readyToExecuteTransaction = false
    // PATCH: end

    try {
      const tx = new PgTransaction(conn, options)
      await tx.executeRaw({ sql: 'BEGIN', args: [], argTypes: [] })
      if (isolationLevel) {
        await tx.executeRaw({
          sql: `SET TRANSACTION ISOLATION LEVEL ${isolationLevel}`,
          args: [],
          argTypes: [],
        })
      }
      return tx
    } catch (error: any) { // PATCH: Fix TypeScript errors
      conn.release(error)
      this.onError(error)
    }
  }

  async executeScript(script: string): Promise<void> {
    // TODO: crude implementation for now, might need to refine it
    for (const stmt of script.split(';')) {
      try {
        await this.client.query(stmt)
      } catch (error) {
        this.onError(error)
      }
    }
  }

  getConnectionInfo(): ConnectionInfo {
    return {
      schemaName: this.options?.schema,
    }
  }

  async dispose(): Promise<void> {
    await this.release?.()
    return await this.client.end()
  }
}

export class PrismaPgAdapterFactory implements SqlMigrationAwareDriverAdapterFactory {
  logQueries: boolean // PATCH: Add logQueries

  readonly provider = 'postgres'
  readonly adapterName = packageName

  // PATCH: add logQueries
  constructor(private readonly config: pg.PoolConfig, private readonly options?: PrismaPgOptions, { logQueries }: { logQueries?: boolean } = {}) {
    this.logQueries = logQueries || false
  }
  // PATCH: end

  async connect(): Promise<SqlDriverAdapter> {
    // PATCH: client type and logQueries
    return new PrismaPgAdapter(new pg.Pool(this.config) as StdClient, this.options, async () => {}, {logQueries: this.logQueries})
    // PATCH: end
  }

  async connectToShadowDb(): Promise<SqlDriverAdapter> {
    const conn = await this.connect()
    const database = `prisma_migrate_shadow_db_${globalThis.crypto.randomUUID()}`
    await conn.executeScript(`CREATE DATABASE "${database}"`)

    // PATCH: client type and logQueries
    return new PrismaPgAdapter(new pg.Pool({ ...this.config, database }) as StdClient, undefined, async () => {
      await conn.executeScript(`DROP DATABASE "${database}"`)
      // Note: no need to call dispose here. This callback is run as part of dispose.
    }, {logQueries: this.logQueries})
    // PATCH: end
  }
}
