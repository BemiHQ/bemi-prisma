import type { SqlQuery } from '@prisma/driver-adapter-utils'
import pg from 'pg'

const SQL_COMMENT_AFFIX = process.env.BEMI_SQL_COMMENT_AFFIX || 'Bemi'

export interface StdClient extends pg.Pool {
  logQueries: boolean
}

export interface TransactionClient extends pg.PoolClient {
  previousQueries: SqlQuery[]
  logQueries: boolean
  readyToExecuteTransaction?: boolean
}

export const EMPTY_RESULT = { rowCount: null, fields: [], command: '', oid: 0, rows: [] } as pg.QueryResult

export const contextToSqlComment = (context: any): string => {
  return `/*${SQL_COMMENT_AFFIX} ${JSON.stringify(context)} ${SQL_COMMENT_AFFIX}*/`
}

export const sqlCommentToContext = (sql: string): any => {
  return JSON.parse(sql.replace(`/*${SQL_COMMENT_AFFIX} `, '').replace(` ${SQL_COMMENT_AFFIX}*/`, ''))
}

export const isContextComment = (sql: string): boolean => {
  return sql.startsWith(`/*${SQL_COMMENT_AFFIX}`) && sql.endsWith(`${SQL_COMMENT_AFFIX}*/`)
}

export const isWriteQuery = (sql: string): boolean => {
  return /(INSERT|UPDATE|DELETE)\s/i.test(sql)
}

export const isBeginQuery = (sql: string): boolean => {
  return /^BEGIN($|\s)/gi.test(sql)
}

export const isCommitQuery = (sql: string): boolean => {
  return /^COMMIT($|\s)/gi.test(sql)
}
