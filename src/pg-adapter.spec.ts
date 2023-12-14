import { PgAdapter } from './pg-adapter'

const QUERIES = {
  BEGIN: 'BEGIN',
  COMMIT: 'COMMIT',
  SELECT: 'SELECT "Todo"."Todo"."id", "Todo"."Todo"."task", "Todo"."Todo"."isCompleted" FROM "Todo"."Todo" WHERE "Todo"."Todo"."id" = $1 OFFSET $2',
  UPDATE: 'UPDATE "Todo"."Todo" SET "isCompleted" = $1 WHERE ("Todo"."Todo"."id" = $2 AND 1=1) RETURNING "Todo"."Todo"."id", "Todo"."Todo"."task", "Todo"."Todo"."isCompleted"',
  DELETE: 'DELETE FROM "Todo"."Todo" WHERE ("Todo"."Todo"."id" = $1 AND 1=1)',
  CONTEXT: '/*Bemi {"apiEndpoint":"/todo/complete","userID":1,"queryParams":{"id":37}} Bemi*/',
}

const callMockedPgAdapater = async (queries: string[]) => {
  const query = jest.fn(() => Promise.resolve({}))
  const client = { query, previousQueries: [] }
  const pgAdapter = new PgAdapter(client as any)

  for(const sql of queries) {
    await pgAdapter['performIO']({ sql, args: [] })
  }

  return query
}

describe('PgAdapter', () => {
  describe('performIO with a transaction', () => {
    test('works with context & write operations', async () => {
      const queries = [
        QUERIES.BEGIN,
        QUERIES.CONTEXT,
        QUERIES.UPDATE,  // <<< execute only this by merging with context
        QUERIES.COMMIT,
      ]

      const query = await callMockedPgAdapater(queries)

      expect(query.mock.calls.map(c => c[0].text)).toStrictEqual([
        `${QUERIES.UPDATE} ${QUERIES.CONTEXT}`,
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

      expect(query.mock.calls.map(c => c[0].text)).toStrictEqual([
        QUERIES.BEGIN,
        QUERIES.SELECT,
        `${QUERIES.DELETE} ${QUERIES.CONTEXT}`,
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

      expect(query.mock.calls.map(c => c[0].text)).toStrictEqual([
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

      expect(query.mock.calls.map(c => c[0].text)).toStrictEqual([
        QUERIES.BEGIN,
        QUERIES.SELECT,
        `${QUERIES.DELETE} ${QUERIES.CONTEXT}`,
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

      expect(query.mock.calls.map(c => c[0].text)).toStrictEqual([
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

      expect(query.mock.calls.map(c => c[0].text)).toStrictEqual([
        QUERIES.UPDATE,
      ]);
    })
  })
})
