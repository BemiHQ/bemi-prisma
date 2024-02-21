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
  pg_major_version INT;
BEGIN
  pg_major_version := (SELECT SPLIT_PART(setting, '.', 1)::INT FROM pg_settings WHERE name = 'server_version');
  FOR current_tablename IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    IF (pg_major_version >= 14) THEN
      EXECUTE format(
        'CREATE OR REPLACE TRIGGER _bemi_row_trigger_%s
        BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW
        EXECUTE FUNCTION _bemi_row_trigger_func()',
        current_tablename, current_tablename
      );
    ELSE
      EXECUTE format(
        'DROP TRIGGER IF EXISTS _bemi_row_trigger_%s ON %I',
        current_tablename, current_tablename
      );
      EXECUTE format(
        'CREATE TRIGGER _bemi_row_trigger_%s
        BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW
        EXECUTE FUNCTION _bemi_row_trigger_func()',
        current_tablename, current_tablename
      );
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION _bemi_create_table_trigger_func()
  RETURNS event_trigger
AS $$
BEGIN
  CALL _bemi_create_triggers();
END
$$ LANGUAGE plpgsql;

DROP EVENT TRIGGER IF EXISTS _bemi_create_table_trigger;

CREATE EVENT TRIGGER _bemi_create_table_trigger
ON ddl_command_end WHEN TAG IN ('CREATE TABLE')
EXECUTE FUNCTION _bemi_create_table_trigger_func();

CALL _bemi_create_triggers();
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

program.name("bemi").description("CLI to Bemi utilities").version("0.2.6");

program.
  command("migration:create").
  description("Create a new Prisma migration file with Bemi PostgreSQL triggers").
  action(() => { generateMigrationFile() });

program.parseAsync(process.argv);
