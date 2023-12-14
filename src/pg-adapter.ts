import type { ColumnType, DriverAdapter, Query, Queryable, Result, ResultSet, Transaction, TransactionOptions } from '@prisma/driver-adapter-utils'
import { Debug, err, ok } from '@prisma/driver-adapter-utils'
import { logger } from '@prisma/internals'
import type pg from 'pg'

import { fieldToColumnType, UnsupportedNativeDataType } from './conversion'

interface StandardClient extends pg.Pool {
  logQueries: boolean
}

interface TransactionClient extends pg.PoolClient {
  previousQueries: Query[]
  logQueries: boolean
  disableAdapterModification: boolean
  readyToExecuteTransaction?: boolean
}

const debug = Debug('prisma:driver-adapter:pg')
const EMPTY_RESULT = { rowCount: null, fields: [], command: '', oid: 0, rows: [] } as pg.QueryResult

class PgQueryable<ClientT extends StandardClient | TransactionClient> implements Queryable {
  readonly provider = 'postgres'

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

  isBemiContext(sql: string): boolean {
    return sql.startsWith('/*Bemi') && sql.endsWith('Bemi*/')
  }

  isWriteQuery(sql: string): boolean {
    return /(INSERT|UPDATE|DELETE)\s/gi.test(sql)
  }

  isBeginQuery(sql: string): boolean {
    return /^BEGIN($|\s)/gi.test(sql)
  }

  isCommitQuery(sql: string): boolean {
    return /^COMMIT($|\s)/gi.test(sql)
  }

  /**
   * Run a query against the database, returning the result set.
   * Should the query fail due to a connection error, the connection is
   * marked as unhealthy.
   */
  private async performIO(query: Query, catchingUp = false): Promise<Result<pg.QueryArrayResult<any>>> {
    const { sql, args: values } = query;
    const transactionClient = this.client as TransactionClient
    const { previousQueries, disableAdapterModification, readyToExecuteTransaction } = transactionClient

    let text = sql

    // Modify the execution
    if (!disableAdapterModification) {
      if (this.client.logQueries && !catchingUp && process.env.BEMI_DEBUG) {
        console.log(`>>     ${sql}`, previousQueries ? previousQueries.length : '')
      }

      // Transaction queries
      if (previousQueries) {
        const isContext = this.isBemiContext(sql)
        const isWrite = this.isWriteQuery(sql)
        const previousContext = previousQueries.find((q) => this.isBemiContext(q.sql))?.sql
        text = previousContext && isWrite ? `${sql} ${previousContext}` : sql

        if (!catchingUp) {
          previousQueries.push(query)
        }

        // Skip accumulated queries or catch up and mark the transaction as ready to execute
        if (!readyToExecuteTransaction) {
          // Skip accumulated BEGIN
          if (this.isBeginQuery(sql) && previousQueries.length === 1) return ok(EMPTY_RESULT)

          // Skip accumulated COMMIT
          if (this.isCommitQuery(sql) && previousContext && previousQueries.length === 4) return ok(EMPTY_RESULT)

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
        if (this.isBemiContext(sql)) return ok(EMPTY_RESULT)
      }

      // Log modified queries
      if (this.client.logQueries) {
        logger.log(`${logger.tags['info'] ?? ''}`, text)
      }
    }

    try {
      const result = await this.client.query({ text, values, rowMode: 'array' })
      return ok(result)
    } catch (e) {
      const error = e as any
      debug('Error in performIO: %O', error)
      if (error && error.code) {
        return err({
          kind: 'Postgres',
          code: error.code,
          severity: error.severity,
          message: error.message,
          detail: error.detail,
          column: error.column,
          hint: error.hint,
        })
      }
      throw error
    }
  }
}

class PgTransaction extends PgQueryable<TransactionClient> implements Transaction {
  constructor(client: TransactionClient, readonly options: TransactionOptions) {
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

export class PgAdapter extends PgQueryable<StandardClient> implements DriverAdapter {
  logQueries: boolean
  disableAdapterModification: boolean

  constructor(
    client: pg.Pool,
    private options?: PrismaPgOptions,
    { logQueries, disableAdapterModification }: { logQueries?: boolean, disableAdapterModification?: boolean } = {}
  ) {
    const standardClient = client as StandardClient

    standardClient.logQueries = logQueries || false
    super(standardClient)

    this.logQueries = standardClient.logQueries
    this.disableAdapterModification = disableAdapterModification || false
  }

  getConnectionInfo(): Result<any> {
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

    const connection = await this.client.connect() as TransactionClient
    connection.previousQueries = []
    connection.logQueries = this.logQueries
    connection.disableAdapterModification = this.disableAdapterModification
    connection.readyToExecuteTransaction = false

    return ok(new PgTransaction(connection, options))
  }
}
