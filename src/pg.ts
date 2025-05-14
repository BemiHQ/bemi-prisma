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

type StdClient = pg.Pool
type TransactionClient = pg.PoolClient

// PATCH: Import additional things
import { logger } from './logger'
import {
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
  // PATCH: add Bemi options
  logQueries = false
  injectSqlInContext = false
  transactionPreviousQueries: undefined | SqlQuery[] = undefined
  transactionReadyToExecute = false
  // PATCH: end

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

    let text = sql

    // Modify the execution
    if (this.logQueries && !catchingUp) {
      logger.debug('QUERY:', sql, this.transactionPreviousQueries ? this.transactionPreviousQueries.length : '')
    }

    // Transaction queries
    if (this.transactionPreviousQueries) {
      const isContext = isContextComment(sql)
      const isWrite = isWriteQuery(sql)
      const previousContextComment = this.transactionPreviousQueries.find((q) => isContextComment(q.sql))?.sql

      if (previousContextComment && isWrite) {
        if (this.injectSqlInContext) {
          text = `${sql} ${contextToSqlComment({ SQL: sql, ...sqlCommentToContext(previousContextComment) })}`
        } else {
          text = `${sql} ${previousContextComment}`
        }
      }

      if (!catchingUp) {
        this.transactionPreviousQueries.push(query)
      }

      // Skip accumulated queries or catch up and mark the transaction as ready to execute
      if (!this.transactionReadyToExecute) {
        // Skip accumulated BEGIN
        if (isBeginQuery(sql) && this.transactionPreviousQueries.length === 1) return EMPTY_RESULT

        // Skip accumulated COMMIT
        if (isCommitQuery(sql) && previousContextComment && this.transactionPreviousQueries.length === 4) return EMPTY_RESULT

        // Catch up and continue the entire transaction
        if (
          (this.transactionPreviousQueries.length === 2 && !isContext) ||
          (this.transactionPreviousQueries.length === 3 && !isWrite)
        ) {
          this.transactionReadyToExecute = true
          for(const prevQuery of this.transactionPreviousQueries.slice(0, this.transactionPreviousQueries.length - 1)) {
            await this.performIO(prevQuery as SqlQuery, true)
          }
        }
      }

      // Skip accumulated context
      if (isContextComment(sql)) return EMPTY_RESULT
    }

    // Log modified queries
    if (this.logQueries) {
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

export class PgTransaction extends PgQueryable<TransactionClient> implements Transaction { // PATCH: export for testing
  constructor(client: pg.PoolClient, readonly options: TransactionOptions) {
    super(client)
    this.transactionPreviousQueries = [] // PATCH: set transactionPreviousQueries
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
  constructor(client: StdClient, private options?: PrismaPgOptions, private readonly release?: () => Promise<void>) {
    super(client)
  }

  async startTransaction(isolationLevel?: IsolationLevel): Promise<Transaction> {
    const options: TransactionOptions = {
      usePhantomQuery: false,
    }

    const tag = '[js::startTransaction]'
    debug('%s options: %O', tag, options)

    const conn = await this.client.connect().catch((error) => this.onError(error))

    try {
      const tx = new PgTransaction(conn, options)

      // PATCH: Bemi options
      tx.logQueries = this.logQueries
      tx.injectSqlInContext = this.injectSqlInContext
      // PATCH: end

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
  // PATCH: add Bemi options
  logQueries = false
  injectSqlInContext = false
  // PATCH: end

  readonly provider = 'postgres'
  readonly adapterName = packageName

  constructor(private readonly config: pg.PoolConfig, private readonly options?: PrismaPgOptions) {}

  async connect(): Promise<SqlDriverAdapter> {
    // PATCH: Bemi options
    const adapter = new PrismaPgAdapter(new pg.Pool(this.config), this.options, async () => {})
    adapter.logQueries = this.logQueries
    adapter.injectSqlInContext = this.injectSqlInContext
    return adapter
    // PATCH: end
  }

  async connectToShadowDb(): Promise<SqlDriverAdapter> {
    const conn = await this.connect()
    const database = `prisma_migrate_shadow_db_${globalThis.crypto.randomUUID()}`
    await conn.executeScript(`CREATE DATABASE "${database}"`)

    // PATCH: Bemi options
    const adapter = new PrismaPgAdapter(new pg.Pool({ ...this.config, database }), undefined, async () => {
      await conn.executeScript(`DROP DATABASE "${database}"`)
      // Note: no need to call dispose here. This callback is run as part of dispose.
    })
    adapter.logQueries = this.logQueries
    adapter.injectSqlInContext = this.injectSqlInContext
    return adapter
    // PATCH: end
  }
}
