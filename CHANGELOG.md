# Changelog

#### [v0.5.0](https://github.com/BemiHQ/bemi-prisma/compare/v0.4.1...v0.5.0) - 2024-08-08

- Allow context passing only for specific models with `includeModels`
- Enable SQL comment affix customization

#### [v0.4.1](https://github.com/BemiHQ/bemi-prisma/compare/v0.4.0...v0.4.1) - 2024-08-02

- Fix compatibility with Prisma v5.15+

#### [v0.4.0](https://github.com/BemiHQ/bemi-prisma/compare/v0.3.0...v0.4.0) - 2024-04-16

- Fix Next.js actions by removing `@prisma/internals` as a dependency
- Validate context size to make sure it is under 1MB

#### [v0.3.0](https://github.com/BemiHQ/bemi-prisma/compare/v0.2.8...v0.3.0) - 2024-04-11

- Automatically include an original SQL query in application context
- Pass application context only if it's an object
- Sync the pg adapter against the latest Prisma pg adapter version
- Drop support for PostgreSQL version 13 and older

#### [v0.2.8](https://github.com/BemiHQ/bemi-prisma/compare/v0.2.7...v0.2.8) - 2024-03-05

- Don't crash in the migration when executing it with Supabase

#### [v0.2.7](https://github.com/BemiHQ/bemi-prisma/compare/v0.2.6...v0.2.7) - 2024-02-29

- Add `bemiContext` function for inline context setting
- Delete `express` from peer dependencies

#### [v0.2.6](https://github.com/BemiHQ/bemi-prisma/compare/v0.2.5...v0.2.6) - 2024-02-21

- Reuse the Prisma client type when wrapping it by using `withPgAdapter`

#### [v0.2.5](https://github.com/BemiHQ/bemi-prisma/compare/v0.2.4...v0.2.5) - 2024-02-19

- Add `BemiApolloServerPlugin`

#### [v0.2.4](https://github.com/BemiHQ/bemi-prisma/compare/v0.2.3...v0.2.4) - 2024-02-19

- Make it compatible with the latest Prisma v5.9.1

#### [v0.2.3](https://github.com/BemiHQ/bemi-prisma/compare/v0.2.2...v0.2.3) - 2024-02-19

- Allow attaching application context to raw execute queries

#### [v0.2.2](https://github.com/BemiHQ/bemi-prisma/compare/v0.2.1...v0.2.2) - 2024-01-16

- Fix migration generation to work with PostgreSQL versions less than 14

#### [v0.2.1](https://github.com/BemiHQ/bemi-prisma/compare/v0.2.0...v0.2.1) - 2024-01-04

- Fix migration generation to work with table names containing double quotes

#### [v0.2.0](https://github.com/BemiHQ/bemi-prisma/compare/v0.1.0...v0.2.0) - 2024-01-02

- Update license from MIT to LGPL-3.0 `#LoveOpenSource`

#### v0.1.0 - 2023-12-15

- Create package
