/// <reference types="@cloudflare/workers-types" />

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readFileSync } from "node:fs";

/**
 * Test-only: the slice of the D1 API the Worker's stores use (prepare, bind,
 * first, all, run, batch), over an in-memory bun:sqlite database. It runs the
 * real migration SQL, so store tests exercise the real schema, constraints,
 * and queries without a Workerd build. Never imported by Worker code.
 */
export interface SqliteD1 {
  db: D1Database;
  sqlite: Database;
}

export function sqliteD1(migrations: string[] = []): SqliteD1 {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const file of migrations) sqlite.exec(readFileSync(file, "utf8"));

  const returnsRows = (sql: string) =>
    /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);

  class Statement {
    constructor(
      readonly sql: string,
      readonly params: SQLQueryBindings[] = [],
    ) {}
    bind(...params: unknown[]) {
      // SAFETY: test stores bind only strings, numbers, and nulls.
      return new Statement(this.sql, params as SQLQueryBindings[]);
    }
    async first<T>(): Promise<T | null> {
      // SAFETY: callers name the row shape their SQL selects.
      return sqlite.query(this.sql).get(...this.params) as T | null;
    }
    async all<T>() {
      return this.exec<T>();
    }
    async run() {
      return this.exec();
    }
    exec<T>() {
      if (returnsRows(this.sql)) {
        // SAFETY: callers name the row shape their SQL selects.
        const results = sqlite.query(this.sql).all(...this.params) as T[];
        return { results, success: true, meta: { changes: results.length } };
      }
      const { changes } = sqlite.query(this.sql).run(...this.params);
      const results: T[] = [];
      return { results, success: true, meta: { changes } };
    }
  }

  // SAFETY: the object assigned below implements the D1 surface the stores
  // call (prepare/bind/first/all/run/batch); tests only.
  const db = Object.assign({} as D1Database, {
    prepare: (sql: string) => new Statement(sql),
    batch: async (statements: Statement[]) =>
      sqlite.transaction(() => statements.map((s) => s.exec()))(),
  });
  return { db, sqlite };
}
