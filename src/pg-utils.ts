import type { Query } from '@prisma/driver-adapter-utils'
import pg from 'pg'

export interface StdClient extends pg.Pool {
  logQueries: boolean
}

export interface TransactionClient extends pg.PoolClient {
  previousQueries: Query[]
  logQueries: boolean
  readyToExecuteTransaction?: boolean
}

export const EMPTY_RESULT = { rowCount: null, fields: [], command: '', oid: 0, rows: [] } as pg.QueryResult

export const contextToSqlComment = (context: any): string => {
  return `/*Bemi ${JSON.stringify(context)} Bemi*/`
}

export const sqlCommentToContext = (sql: string): any => {
  return JSON.parse(sql.replace('/*Bemi ', '').replace(' Bemi*/', ''))
}

export const isContextComment = (sql: string): boolean => {
  return sql.startsWith('/*Bemi') && sql.endsWith('Bemi*/')
}

export const isWriteQuery = (sql: string): boolean => {
  return /(INSERT|UPDATE|DELETE)\s/gi.test(sql)
}

export const isBeginQuery = (sql: string): boolean => {
  return /^BEGIN($|\s)/gi.test(sql)
}

export const isCommitQuery = (sql: string): boolean => {
  return /^COMMIT($|\s)/gi.test(sql)
}
