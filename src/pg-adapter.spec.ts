import { PrismaPg } from './pg-adapter'
import { contextToSqlComment } from './pg-utils'

const CONTEXT = {
  endpoint: '/todo/complete',
  userID: 1,
  queryParams: { id: 37 },
}

const QUERIES = {
  BEGIN: 'BEGIN',
  COMMIT: 'COMMIT',
  SELECT: 'SELECT "Todo"."Todo"."id", "Todo"."Todo"."task", "Todo"."Todo"."isCompleted" FROM "Todo"."Todo" WHERE "Todo"."Todo"."id" = $1 OFFSET $2',
  UPDATE: 'UPDATE "Todo"."Todo" SET "isCompleted" = $1 WHERE ("Todo"."Todo"."id" = $2 AND 1=1) RETURNING "Todo"."Todo"."id", "Todo"."Todo"."task", "Todo"."Todo"."isCompleted"',
  DELETE: 'DELETE FROM "Todo"."Todo" WHERE ("Todo"."Todo"."id" = $1 AND 1=1)',
  CONTEXT: contextToSqlComment(CONTEXT),
}

const callMockedPgAdapater = async (queries: string[]) => {
  const query = jest.fn(() => Promise.resolve({}))
  const client = { query, previousQueries: [] }
  const pgAdapter = new PrismaPg(client as any)

  for(const sql of queries) {
    await pgAdapter['performIO']({ sql, args: [], argTypes: [] })
  }

  return query
}

const queryWithContext = (query: string) => {
  return `${query} ${contextToSqlComment({ SQL: query, ...CONTEXT })}`
}

describe('PrismaPg', () => {
  describe('performIO with a transaction', () => {
    test('works with context & write operations', async () => {
      const queries = [
        QUERIES.BEGIN,
        QUERIES.CONTEXT,
        QUERIES.UPDATE,  // <<< execute only this by merging with context
        QUERIES.COMMIT,
      ]

      const query = await callMockedPgAdapater(queries)

      expect(query.mock.calls.map((c: any) => c[0].text)).toStrictEqual([
        queryWithContext(QUERIES.UPDATE),
      ]);
    })

    test('works with context & select & write operations', async () => {
      const queries = [
        QUERIES.BEGIN,
        QUERIES.CONTEXT,
        QUERIES.SELECT,  // <<< execute from here by catching up
        QUERIES.DELETE,  //   < merge with context
        QUERIES.COMMIT,
      ]

      const query = await callMockedPgAdapater(queries)

      expect(query.mock.calls.map((c: any) => c[0].text)).toStrictEqual([
        QUERIES.BEGIN,
        QUERIES.SELECT,
        queryWithContext(QUERIES.DELETE),
        QUERIES.COMMIT,
      ]);
    })

    test('works with a write operation', async () => {
      const queries = [
        QUERIES.BEGIN,
        QUERIES.UPDATE,  // <<< execute from here by catching up
        QUERIES.COMMIT,
      ]

      const query = await callMockedPgAdapater(queries)

      expect(query.mock.calls.map((c: any) => c[0].text)).toStrictEqual([
        QUERIES.BEGIN,
        QUERIES.UPDATE,
        QUERIES.COMMIT,
      ]);
    })

    test('works with select & context & write operations', async () => {
      const queries = [
        QUERIES.BEGIN,
        QUERIES.SELECT,  // <<< execute from here by catching up
        QUERIES.CONTEXT,
        QUERIES.DELETE,  //   < merge with context
        QUERIES.COMMIT,
      ]

      const query = await callMockedPgAdapater(queries)

      expect(query.mock.calls.map((c: any) => c[0].text)).toStrictEqual([
        QUERIES.BEGIN,
        QUERIES.SELECT,
        queryWithContext(QUERIES.DELETE),
        QUERIES.COMMIT,
      ]);
    })

    test('works with select & select operations', async () => {
      const queries = [
        QUERIES.BEGIN,
        QUERIES.SELECT,  // <<< execute from here by catching up
        QUERIES.SELECT,
        QUERIES.COMMIT,
      ]

      const query = await callMockedPgAdapater(queries)

      expect(query.mock.calls.map((c: any) => c[0].text)).toStrictEqual([
        QUERIES.BEGIN,
        QUERIES.SELECT,
        QUERIES.SELECT,
        QUERIES.COMMIT,
      ]);
    })
  })

  describe('performIO without a transaction', () => {
    test('works without a transaction', async () => {
      const queries = [
        QUERIES.UPDATE,  // <<< execute from here
      ]

      const query = await callMockedPgAdapater(queries)

      expect(query.mock.calls.map((c: any) => c[0].text)).toStrictEqual([
        QUERIES.UPDATE,
      ]);
    })
  })
})
