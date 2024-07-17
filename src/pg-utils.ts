import type {Query} from '@prisma/driver-adapter-utils'
import pg from 'pg'

export interface StdClient extends pg.Pool {
  logQueries: boolean
}

export interface TransactionClient extends pg.PoolClient {
  previousQueries: Query[]
  logQueries: boolean
  readyToExecuteTransaction?: boolean
}

export const EMPTY_RESULT = {rowCount: null, fields: [], command: '', oid: 0, rows: []} as pg.QueryResult

export const contextToSqlComment = (context: any): string => {
  return `/*_MV_DB_AUDIT ${JSON.stringify(context)} _MV_DB_AUDIT*/`
}

export const sqlCommentToContext = (sql: string): any => {
  return JSON.parse(sql.replace('/*_MV_DB_AUDIT ', '').replace(' _MV_DB_AUDIT*/', ''))
}

export const isContextComment = (sql: string): boolean => {
  return sql.startsWith('/*_MV_DB_AUDIT') && sql.endsWith('_MV_DB_AUDIT*/')
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
