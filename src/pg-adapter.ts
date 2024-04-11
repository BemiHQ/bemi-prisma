/* eslint-disable @typescript-eslint/require-await */
import type {
  ColumnType,
  ConnectionInfo,
  DriverAdapter,
  Query,
  Queryable,
  Result,
  ResultSet,
  Transaction,
  TransactionOptions,
} from '@prisma/driver-adapter-utils'
import { Debug, err, ok } from '@prisma/driver-adapter-utils'
// @ts-ignore: this is used to avoid the `Module '"<path>/node_modules/@types/pg/index"' has no default export.` error.
import pg from 'pg'

import { fieldToColumnType, fixArrayBufferValues, UnsupportedNativeDataType } from './conversion'

const debug = Debug('prisma:driver-adapter:pg')

// PATCH: Import additional things
import { logger } from '@prisma/internals'
import { log } from './logger'
import {
  StdClient,
  TransactionClient,
  EMPTY_RESULT,
  isBemiContext,
  isWriteQuery,
  isBeginQuery,
  isCommitQuery,
} from './pg-utils'
// PATCH: end

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
class PgQueryable<ClientT extends StdClient | TransactionClient> implements Queryable {
  readonly provider = 'postgres'
  readonly adapterName = '@prisma/adapter-pg'

  constructor(protected readonly client: ClientT) {}

  /**
   * Execute a query given as SQL, interpolating the given parameters.
   */
  async queryRaw(query: Query): Promise<Result<ResultSet>> {
    const tag = '[js::query_raw]'
    debug(`${tag} %O`, query)

    const res = await this.performIO(query)

    if (!res.ok) {
      return err(res.error)
    }

    const { fields, rows } = res.value
    const columnNames = fields.map((field) => field.name)
    let columnTypes: ColumnType[] = []

    try {
      columnTypes = fields.map((field) => fieldToColumnType(field.dataTypeID))
    } catch (e) {
      if (e instanceof UnsupportedNativeDataType) {
        return err({
          kind: 'UnsupportedNativeDataType',
          type: e.type,
        })
      }
      throw e
    }

    return ok({
      columnNames,
      columnTypes,
      rows,
    })
  }

  /**
   * Execute a query given as SQL, interpolating the given parameters and
   * returning the number of affected rows.
   * Note: Queryable expects a u64, but napi.rs only supports u32.
   */
  async executeRaw(query: Query): Promise<Result<number>> {
    const tag = '[js::execute_raw]'
    debug(`${tag} %O`, query)

    // Note: `rowsAffected` can sometimes be null (e.g., when executing `"BEGIN"`)
    return (await this.performIO(query)).map(({ rowCount: rowsAffected }) => rowsAffected ?? 0)
  }

  /**
   * Run a query against the database, returning the result set.
   * Should the query fail due to a connection error, the connection is
   * marked as unhealthy.
   */
  // PATCH: pass extra argument
  private async performIO(query: Query, catchingUp = false): Promise<Result<pg.QueryArrayResult<any>>> {
  // PATCH: end

    try {
      // PATCH: Call compactPerformIOResult
      const result = await this.compactPerformIOResult(query, catchingUp)
      // PATCH: end
      return ok(result)
    // PATCH: Fix TypeScript errors
    } catch (e: any) {
    // PATCH: end
      const error = e as Error
      debug('Error in performIO: %O', error)
      if (e && typeof e.code === 'string' && typeof e.severity === 'string' && typeof e.message === 'string') {
        return err({
          kind: 'Postgres',
          code: e.code,
          severity: e.severity,
          message: e.message,
          detail: e.detail,
          column: e.column,
          hint: e.hint,
        })
      }
      throw error
    }
  }

  // PATCH: Remove unnnecessary transactions
  private async compactPerformIOResult(query: Query, catchingUp: boolean): Promise<pg.QueryResult> {
    const { sql, args: values } = query
    const transactionClient = this.client as TransactionClient
    const { previousQueries, readyToExecuteTransaction } = transactionClient

    let text = sql

    // Modify the execution
    if (this.client.logQueries && !catchingUp) {
      log('QUERY:', sql, previousQueries ? previousQueries.length : '')
    }

    // Transaction queries
    if (previousQueries) {
      const isContext = isBemiContext(sql)
      const isWrite = isWriteQuery(sql)
      const previousContext = previousQueries.find((q) => isBemiContext(q.sql))?.sql
      text = previousContext && isWrite ? `${sql} ${previousContext}` : sql

      if (!catchingUp) {
        previousQueries.push(query)
      }

      // Skip accumulated queries or catch up and mark the transaction as ready to execute
      if (!readyToExecuteTransaction) {
        // Skip accumulated BEGIN
        if (isBeginQuery(sql) && previousQueries.length === 1) return EMPTY_RESULT

        // Skip accumulated COMMIT
        if (isCommitQuery(sql) && previousContext && previousQueries.length === 4) return EMPTY_RESULT

        // Catch up and continue the entire transaction
        if (
          (previousQueries.length === 2 && !isContext) ||
          (previousQueries.length === 3 && !isWrite)
        ) {
          transactionClient.readyToExecuteTransaction = true
          for(const prevQuery of previousQueries.slice(0, previousQueries.length - 1)) {
            await this.performIO(prevQuery as Query, true)
          }
        }
      }

      // Skip accumulated context
      if (isBemiContext(sql)) return EMPTY_RESULT
    }

    // Log modified queries
    if (this.client.logQueries) {
      logger.log(`${logger.tags['info'] ?? ''}`, text)
    }

    const result = await this.client.query({ text, values: fixArrayBufferValues(values), rowMode: 'array' })
    return result
  }
  // PATCH: end
}

class PgTransaction extends PgQueryable<TransactionClient> implements Transaction {
  // PATCH: Fix TypeScript errors
  constructor(client: TransactionClient, readonly options: TransactionOptions) {
  // PATCH: end
    super(client)
  }

  async commit(): Promise<Result<void>> {
    debug(`[js::commit]`)

    this.client.release()
    return ok(undefined)
  }

  async rollback(): Promise<Result<void>> {
    debug(`[js::rollback]`)

    this.client.release()
    return ok(undefined)
  }
}

export type PrismaPgOptions = {
  schema?: string
}

export class PrismaPg extends PgQueryable<StdClient> implements DriverAdapter {
  // PATCH: Add logQueries
  logQueries: boolean

  constructor(
    client: pg.Pool,
    private options?: PrismaPgOptions,
    { logQueries }: { logQueries?: boolean } = {}
  ) {
  // PATCH: end

    // PATCH: Ignore type checking
    if (false) {
    // PATCH: end
      throw new TypeError(`PrismaPg must be initialized with an instance of Pool:
import { Pool } from 'pg'
const pool = new Pool({ connectionString: url })
const adapter = new PrismaPg(pool)
`)
    }

    // PATCH: Add logQueries
    const standardClient = client as StdClient
    standardClient.logQueries = logQueries || false
    super(standardClient)
    this.logQueries = standardClient.logQueries
    // PATCH: end
  }

  getConnectionInfo(): Result<ConnectionInfo> {
    return ok({
      schemaName: this.options?.schema,
    })
  }

  async startTransaction(): Promise<Result<Transaction>> {
    const options: TransactionOptions = {
      usePhantomQuery: false,
    }

    const tag = '[js::startTransaction]'
    debug(`${tag} options: %O`, options)

    // PATCH: Customize connection
    const connection = await this.client.connect() as TransactionClient
    connection.previousQueries = []
    connection.logQueries = this.logQueries
    connection.readyToExecuteTransaction = false
    // PATCH: end

    return ok(new PgTransaction(connection, options))
  }
}
