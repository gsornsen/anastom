import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { digestBytes } from "@anastom/core";
import manifest from "../migrations/manifest.json" with { type: "json" };

const journalSql = readFileSync(new URL("../migrations/journal.sql", import.meta.url), "utf8");

/** A committed, immutable database schema step. Versions start at one without gaps. */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrations: readonly Migration[] = manifest.map((entry) => ({
  version: entry.version,
  name: entry.name,
  sql: readFileSync(new URL(`../migrations/${entry.file}`, import.meta.url), "utf8"),
}));

function schemaObjects(db: DatabaseSync): Map<string, string> {
  const rows = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*'",
    )
    .all();
  return new Map(
    rows.map((row) => {
      if (typeof row.name !== "string" || typeof row.sql !== "string") {
        throw new Error("Invalid database schema object");
      }
      // SQLite removes IF NOT EXISTS from sqlite_master. Layout changes are immaterial.
      const sql = normalizeSql(row.sql);
      return [row.name, sql];
    }),
  );
}

function normalizeSql(sql: string): string {
  let result = "";
  let closingQuote: string | undefined;
  for (let index = 0; index < sql.length; index++) {
    const character = sql[index]!;
    if (closingQuote) {
      result += character;
      if (character === closingQuote) {
        if (sql[index + 1] === closingQuote) {
          result += sql[++index];
        } else {
          closingQuote = undefined;
        }
      }
    } else if (["'", '"', "`", "["].includes(character)) {
      closingQuote = character === "[" ? "]" : character;
      result += character;
    } else if (!/\s/.test(character)) {
      result += character;
    }
  }
  return result.replace(/^CREATE(TABLE|INDEX|TRIGGER)IFNOTEXISTS/, "CREATE$1").replace(/;$/, "");
}

function assertSchema(db: DatabaseSync, steps: readonly Migration[]): void {
  const reference = new DatabaseSync(":memory:");
  try {
    if (db.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get()) {
      reference.exec(journalSql);
    }
    for (const step of steps) {
      reference.exec(step.sql);
    }
    const expected = schemaObjects(reference);
    const actual = schemaObjects(db);
    if (
      expected.size !== actual.size ||
      [...expected].some(([name, sql]) => actual.get(name) !== sql)
    ) {
      throw new Error(
        "Database schema differs from its migration history; restore a verified backup before retrying",
      );
    }
    if (db.prepare("PRAGMA quick_check").get()?.quick_check !== "ok") {
      throw new Error("Database integrity check failed");
    }
    if (db.prepare("PRAGMA foreign_key_check").all().length !== 0) {
      throw new Error("Database foreign-key check failed");
    }
  } finally {
    reference.close();
  }
}

function validateHistory(db: DatabaseSync, steps: readonly Migration[]): number {
  const rows = db
    .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    .all();
  if (rows.length > steps.length) {
    throw new Error("Database schema is newer than this application");
  }
  for (const [index, row] of rows.entries()) {
    const step = steps[index];
    if (
      !step ||
      row.version !== step.version ||
      row.name !== step.name ||
      row.checksum !== digestBytes(step.sql)
    ) {
      throw new Error("Database migration history has a gap or changed checksum");
    }
  }
  const marker = db.prepare("PRAGMA user_version").get()?.user_version;
  if (marker !== rows.length) {
    throw new Error("Database schema version and migration history disagree");
  }
  return rows.length;
}

function recordMigration(db: DatabaseSync, step: Migration): void {
  db.prepare("INSERT INTO schema_migrations(version, name, checksum) VALUES (?, ?, ?)").run(
    step.version,
    step.name,
    digestBytes(step.sql),
  );
  db.exec(`PRAGMA user_version = ${step.version}`);
}

/**
 * Validate and apply schema changes under one immediate transaction.
 *
 * A failed step or validation rolls back both DDL and the migration journal.
 * The original unversioned run store is adopted only after its complete schema
 * matches migration one. Existing run definitions and events are never rewritten.
 * Newer databases, edited applied migrations, and schema drift fail closed.
 * Back up the SQLite database before upgrading; destructive down migrations are
 * deliberately excluded because undoing schema changes can destroy run evidence.
 */
export function applyMigrations(db: DatabaseSync, steps: readonly Migration[] = migrations): void {
  if (
    steps.length === 0 ||
    steps.some((step, index) => step.version !== index + 1 || !step.name || !step.sql.trim())
  ) {
    throw new Error("Migration versions must start at one and be contiguous");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const hasJournal = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    const existingObjects = schemaObjects(db);
    if (!hasJournal && existingObjects.size > 0) {
      assertSchema(db, steps.slice(0, 1));
    }
    if (!hasJournal && db.prepare("PRAGMA user_version").get()?.user_version !== 0) {
      throw new Error("Database version exists without a migration history");
    }
    db.exec(journalSql);
    if (!hasJournal && existingObjects.size > 0) {
      recordMigration(db, steps[0]!);
    }
    const applied = validateHistory(db, steps);
    assertSchema(db, steps.slice(0, applied));
    for (const step of steps.slice(applied)) {
      db.exec(step.sql);
      recordMigration(db, step);
    }
    assertSchema(db, steps);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
