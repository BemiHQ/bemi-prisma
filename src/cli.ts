#!/usr/bin/env node

import { Command } from "commander";
import fs from "fs";
import path from "path";

const MIGRATION_CONTENT = `CREATE OR REPLACE FUNCTION _bemi_row_trigger_func()
  RETURNS TRIGGER
AS $$
DECLARE
  _bemi_metadata TEXT;
BEGIN
  SELECT split_part(split_part(current_query(), '/*Bemi ', 2), ' Bemi*/', 1) INTO _bemi_metadata;
  IF _bemi_metadata <> '' THEN
    PERFORM pg_logical_emit_message(true, '_bemi', _bemi_metadata);
  END IF;

  IF (TG_OP = 'DELETE') THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE PROCEDURE _bemi_create_triggers()
AS $$
DECLARE
  current_tablename TEXT;
BEGIN
  FOR current_tablename IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER _bemi_row_trigger_%s
      BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW
      EXECUTE FUNCTION _bemi_row_trigger_func()',
      current_tablename, current_tablename
    );
  END LOOP;
END;
$$ LANGUAGE plpgsql;

CALL _bemi_create_triggers();

CREATE OR REPLACE FUNCTION _bemi_create_table_trigger_func()
  RETURNS event_trigger
AS $$
BEGIN
  CALL _bemi_create_triggers();
END
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  DROP EVENT TRIGGER IF EXISTS _bemi_create_table_trigger;
  CREATE EVENT TRIGGER _bemi_create_table_trigger ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION _bemi_create_table_trigger_func();
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Please execute "CALL _bemi_create_triggers();" manually after adding new tables you want to track. (%) %.', SQLSTATE, SQLERRM;
END
$$ LANGUAGE plpgsql;
`

const generateMigrationFile = async () => {
  const timestamp = new Date().toISOString().split('.')[0].replaceAll(/\D/g, '')

  const dirPath = path.join(process.cwd(), 'prisma', 'migrations', `${timestamp}_bemi`)
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath);

  const filePath = path.join(dirPath, 'migration.sql')
  fs.writeFileSync(filePath, MIGRATION_CONTENT);

  console.log(`Migration file created: ${filePath}`);
};

const program = new Command();

program.name("bemi").description("CLI to Bemi utilities").version("0.2.8");

program.
  command("migration:create").
  description("Create a new Prisma migration file with Bemi PostgreSQL triggers").
  action(() => { generateMigrationFile() });

program.parseAsync(process.argv);
