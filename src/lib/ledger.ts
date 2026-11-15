import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// The ledger is the single source of truth: every run, probe sample, eval, change,
// snapshot, draft and technique lives here. One SQLite file, committed to the data repo.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, date TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL DEFAULT 'running',
  shipped INTEGER NOT NULL DEFAULT 0, held INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS probe_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, date TEXT NOT NULL,
  question_id TEXT NOT NULL, engine TEXT NOT NULL, model TEXT NOT NULL, sample INTEGER NOT NULL,
  answer TEXT NOT NULL, cited_urls TEXT NOT NULL, cited INTEGER NOT NULL, mentioned INTEGER NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0, error TEXT,
  UNIQUE(date, question_id, engine, sample)
);
CREATE TABLE IF NOT EXISTS engine_queries (
  date TEXT NOT NULL, question_id TEXT NOT NULL, engine TEXT NOT NULL, query TEXT NOT NULL,
  UNIQUE(date, question_id, engine, query)
);
CREATE TABLE IF NOT EXISTS evals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, created_at TEXT NOT NULL,
  subject TEXT NOT NULL, question_id TEXT NOT NULL, k INTEGER NOT NULL,
  wins INTEGER NOT NULL, win_rate REAL NOT NULL, candidates TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY, run_id TEXT, date TEXT NOT NULL, lane TEXT NOT NULL, target TEXT NOT NULL,
  status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', snapshot_id TEXT,
  eval TEXT NOT NULL DEFAULT '{}', techniques TEXT NOT NULL DEFAULT '[]', external_ref TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY, target TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY, run_id TEXT, date TEXT NOT NULL, kind TEXT NOT NULL, target_url TEXT NOT NULL,
  body TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'new'
);
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, lane TEXT NOT NULL,
  payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued'
);
CREATE TABLE IF NOT EXISTS techniques (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'builtin',
  evidence_grade TEXT NOT NULL DEFAULT 'builtin', weight REAL NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_cards (
  id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, claim TEXT NOT NULL, action TEXT NOT NULL,
  evidence_grade TEXT NOT NULL, published TEXT, created_at TEXT NOT NULL, technique_id TEXT, flags TEXT NOT NULL DEFAULT '[]'
);
`;

export type RunStatus = "running" | "ok" | "partial" | "failed";
export type RunNote = { level: "info" | "held" | "skipped" | "error"; item?: string; reason: string };

export class Ledger {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // Rollback journal, not WAL: the .db file alone is always complete, so committing it to git is safe.
    this.db.exec("PRAGMA journal_mode = DELETE;");
    this.db.exec(SCHEMA);
  }

  startRun(kind: string, date = today()): Run {
    const id = `${kind}-${date}-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    this.db
      .prepare("INSERT INTO runs (id, kind, date, started_at) VALUES (?, ?, ?, ?)")
      .run(id, kind, date, new Date().toISOString());
    return new Run(this, id, date);
  }

  lastRun(kind?: string) {
    const sql = kind
      ? "SELECT * FROM runs WHERE kind = ? ORDER BY started_at DESC LIMIT 1"
      : "SELECT * FROM runs ORDER BY started_at DESC LIMIT 1";
    return (kind ? this.db.prepare(sql).get(kind) : this.db.prepare(sql).get()) as RunRow | undefined;
  }

  close() {
    this.db.close();
  }
}

export type RunRow = {
  id: string; kind: string; date: string; started_at: string; ended_at: string | null; status: RunStatus;
  shipped: number; held: number; skipped: number; cost_usd: number; notes: string;
};

export class Run {
  private notes: RunNote[] = [];
  private counts = { shipped: 0, held: 0, skipped: 0 };
  private cost = 0;
  private degraded = false;
  constructor(private ledger: Ledger, readonly id: string, readonly date: string) {}

  note(n: RunNote) {
    this.notes.push(n);
    if (n.level === "held") this.counts.held++;
    if (n.level === "skipped") this.counts.skipped++;
    if (n.level === "error") this.degraded = true;
  }
  shipped(item: string, reason = "shipped") {
    this.counts.shipped++;
    this.notes.push({ level: "info", item, reason });
  }
  addCost(usd: number) {
    this.cost += usd;
  }
  get costUsd() {
    return this.cost;
  }
  markPartial(reason: string) {
    this.degraded = true;
    this.notes.push({ level: "error", reason });
  }

  // Invariant 1: no silent runs. A run that ships nothing must carry a reason.
  finish(status?: RunStatus): RunStatus {
    let final: RunStatus = status ?? (this.degraded ? "partial" : "ok");
    if (final === "ok" && this.counts.shipped === 0 && this.notes.filter((n) => n.level !== "info").length === 0) {
      this.notes.push({ level: "info", reason: "nothing to ship: no candidates this run" });
    }
    this.ledger.db
      .prepare(
        "UPDATE runs SET ended_at = ?, status = ?, shipped = ?, held = ?, skipped = ?, cost_usd = ?, notes = ? WHERE id = ?",
      )
      .run(
        new Date().toISOString(), final, this.counts.shipped, this.counts.held, this.counts.skipped,
        this.cost, JSON.stringify(this.notes), this.id,
      );
    return final;
  }
}

export function today(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function exitCodeFor(status: RunStatus) {
  return status === "ok" ? 0 : status === "partial" ? 2 : 1;
}
