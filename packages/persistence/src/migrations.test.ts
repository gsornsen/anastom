import { DatabaseSync } from "node:sqlite";
import { digestBytes } from "@anastom/core";
import { describe, expect, it } from "vitest";
import { applyMigrations, type Migration } from "./migrations.js";

const first: Migration = {
  version: 1,
  name: "records",
  sql: "CREATE TABLE records (name TEXT NOT NULL);",
};
const second: Migration = {
  version: 2,
  name: "record-index",
  sql: "CREATE INDEX record_name ON records(name);",
};

describe("Versioned SQLite migrations", () => {
  it("rejects changed SQL literal values instead of treating them as layout differences", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const actual = {
        ...first,
        sql: "CREATE TABLE records (name TEXT NOT NULL DEFAULT 'retained evidence');",
      };
      applyMigrations(db, [actual]);
      const expected = {
        ...first,
        sql: "CREATE TABLE records (name TEXT NOT NULL DEFAULT 'retainedevidence');",
      };
      db.prepare("UPDATE schema_migrations SET checksum=? WHERE version=1").run(
        digestBytes(expected.sql),
      );
      expect(() => applyMigrations(db, [expected])).toThrow("schema differs");
    } finally {
      db.close();
    }
  });
  it("applies pending versions once and preserves rows on upgrade and reopen", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db, [first]);
      db.exec("INSERT INTO records(name) VALUES ('retained evidence')");
      applyMigrations(db, [first, second]);
      applyMigrations(db, [first, second]);
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
      expect(db.prepare("SELECT count(*) AS count FROM schema_migrations").get()?.count).toBe(2);
      expect(db.prepare("SELECT name FROM records").get()?.name).toBe("retained evidence");
    } finally {
      db.close();
    }
  });

  it("rolls back all pending DDL and journal entries after a failed migration", () => {
    const db = new DatabaseSync(":memory:");
    try {
      applyMigrations(db, [first]);
      const failing: Migration = {
        version: 3,
        name: "broken",
        sql: "CREATE TABLE temporary_change (id TEXT); INVALID SQL;",
      };
      expect(() => applyMigrations(db, [first, second, failing])).toThrow();
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
      expect(db.prepare("SELECT count(*) AS count FROM schema_migrations").get()?.count).toBe(1);
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('record_name', 'temporary_change')",
          )
          .all(),
      ).toEqual([]);
      applyMigrations(db, [first, second]);
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(2);
    } finally {
      db.close();
    }
  });

  it("rolls back a failed fresh initialization, allowing a corrected retry", () => {
    const db = new DatabaseSync(":memory:");
    try {
      expect(() => applyMigrations(db, [first, { ...second, sql: "NOT VALID SQL" }])).toThrow();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
      applyMigrations(db, [first]);
    } finally {
      db.close();
    }
  });

  it.each(["checksum", "gap", "newer", "drift", "journal", "extra", "marker"])(
    "rejects %s instead of silently repairing history",
    (damage) => {
      const db = new DatabaseSync(":memory:");
      try {
        applyMigrations(db, [first, second]);
        if (damage === "checksum") {
          db.exec("UPDATE schema_migrations SET checksum='changed' WHERE version=1");
        }
        if (damage === "gap") {
          db.exec("DELETE FROM schema_migrations WHERE version=1");
        }
        if (damage === "drift") {
          db.exec("DROP INDEX record_name");
        }
        if (damage === "extra") {
          db.exec("CREATE TABLE sqliteXunexpected (id TEXT)");
        }
        if (damage === "journal") {
          db.exec("ALTER TABLE schema_migrations ADD COLUMN unexpected TEXT");
        }
        if (damage === "marker") {
          db.exec("PRAGMA user_version=8");
        }
        const steps = damage === "newer" ? [first] : [first, second];
        expect(() => applyMigrations(db, steps)).toThrow();
      } finally {
        db.close();
      }
    },
  );

  it("rejects an existing schema without migration history", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE records (wrong TEXT)");
      expect(() => applyMigrations(db, [first])).toThrow("without migration history");
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
