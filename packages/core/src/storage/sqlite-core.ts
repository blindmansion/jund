import type { HistorySnapshot, EntryVisibility, TurnEntry, Session, Turn } from "./types.ts";

/** Normalized statement shape shared by Bun and better-sqlite3 drivers. */
export interface SessionSqliteStatement {
  run(...params: any[]): void;
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

export interface SessionSqliteStatements {
  sessionInsert: SessionSqliteStatement;
  sessionRead: SessionSqliteStatement;
  sessionUpdate: SessionSqliteStatement;
  sessionList: SessionSqliteStatement;
  sessionListLimit: SessionSqliteStatement;
  sessionListByParent: SessionSqliteStatement;

  turnInsert: SessionSqliteStatement;
  turnRead: SessionSqliteStatement;
  turnListAfterSeq: SessionSqliteStatement;
  turnListAfterSeqLimit: SessionSqliteStatement;
  turnUpdate: SessionSqliteStatement;

  entryInsert: SessionSqliteStatement;
  entryListByTurn: SessionSqliteStatement;
  entryListByTurnVisibility: SessionSqliteStatement;
  entryListBySessionAfterSeq: SessionSqliteStatement;
  entryListBySessionAfterSeqVisibility: SessionSqliteStatement;

  historySnapshotInsert: SessionSqliteStatement;
  historySnapshotRead: SessionSqliteStatement;
}

export interface SessionSqlRow {
  id: string;
  parent_session_id: string | null;
  branched_from_message_id: string | null;
  current_history_snapshot_id: string | null;
  next_turn_seq: number;
  version: number;
  resume_model_provider: string;
  resume_model_id: string;
  resume_agent: string;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
}

export interface TurnSqlRow {
  id: string;
  session_id: string;
  seq: number;
  status: Turn["status"];
  next_entry_order: number;
  version: number;
  metadata_json: string | null;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface TurnEntrySqlRow {
  id: string;
  session_id: string;
  turn_id: string;
  entry_order: number;
  kind: string;
  visibility: EntryVisibility;
  payload_json: string;
  created_at: number;
}

export interface HistorySnapshotSqlRow {
  id: string;
  session_id: string;
  through_turn_seq: number;
  reason: HistorySnapshot["reason"];
  messages_json: string;
  source_session_id: string | null;
  source_message_id: string | null;
  created_at: number;
}

/**
 * Prepare session/turn storage statements from any DB that exposes `.prepare()`.
 * Coalesces `get()` misses to `null` so better-sqlite3 (`undefined`) matches bun:sqlite.
 */
export function prepareSessionSqliteStatements(db: {
  prepare(sql: string): {
    run(...params: any[]): unknown;
    get(...params: any[]): unknown;
    all(...params: any[]): unknown[];
  };
}): SessionSqliteStatements {
  const prep = (sql: string): SessionSqliteStatement => {
    const raw = db.prepare(sql);
    return {
      run: (...args: any[]) => {
        raw.run(...args);
      },
      get: (...args: any[]) => raw.get(...args) ?? null,
      all: (...args: any[]) => raw.all(...args) as any[],
    };
  };

  return {
    sessionInsert: prep(
      `INSERT INTO sessions (
        id,
        parent_session_id,
        branched_from_message_id,
        current_history_snapshot_id,
        next_turn_seq,
        version,
        resume_model_provider,
        resume_model_id,
        resume_agent,
        metadata_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    sessionRead: prep(
      `SELECT
        id,
        parent_session_id,
        branched_from_message_id,
        current_history_snapshot_id,
        next_turn_seq,
        version,
        resume_model_provider,
        resume_model_id,
        resume_agent,
        metadata_json,
        created_at,
        updated_at
      FROM sessions
      WHERE id = ?`,
    ),
    sessionUpdate: prep(
      `UPDATE sessions
      SET
        parent_session_id = ?,
        branched_from_message_id = ?,
        current_history_snapshot_id = ?,
        next_turn_seq = ?,
        version = ?,
        resume_model_provider = ?,
        resume_model_id = ?,
        resume_agent = ?,
        metadata_json = ?,
        created_at = ?,
        updated_at = ?
      WHERE id = ?`,
    ),
    sessionList: prep(
      `SELECT
        id,
        parent_session_id,
        branched_from_message_id,
        current_history_snapshot_id,
        next_turn_seq,
        version,
        resume_model_provider,
        resume_model_id,
        resume_agent,
        metadata_json,
        created_at,
        updated_at
      FROM sessions
      ORDER BY created_at DESC`,
    ),
    sessionListLimit: prep(
      `SELECT
        id,
        parent_session_id,
        branched_from_message_id,
        current_history_snapshot_id,
        next_turn_seq,
        version,
        resume_model_provider,
        resume_model_id,
        resume_agent,
        metadata_json,
        created_at,
        updated_at
      FROM sessions
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`,
    ),
    sessionListByParent: prep(
      `SELECT
        id,
        parent_session_id,
        branched_from_message_id,
        current_history_snapshot_id,
        next_turn_seq,
        version,
        resume_model_provider,
        resume_model_id,
        resume_agent,
        metadata_json,
        created_at,
        updated_at
      FROM sessions
      WHERE parent_session_id = ?
      ORDER BY created_at DESC`,
    ),

    turnInsert: prep(
      `INSERT INTO turns (
        id,
        session_id,
        seq,
        status,
        next_entry_order,
        version,
        metadata_json,
        started_at,
        updated_at,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    turnRead: prep(
      `SELECT
        id,
        session_id,
        seq,
        status,
        next_entry_order,
        version,
        metadata_json,
        started_at,
        updated_at,
        completed_at
      FROM turns
      WHERE id = ?`,
    ),
    turnListAfterSeq: prep(
      `SELECT
        id,
        session_id,
        seq,
        status,
        next_entry_order,
        version,
        metadata_json,
        started_at,
        updated_at,
        completed_at
      FROM turns
      WHERE session_id = ? AND seq > ?
      ORDER BY seq ASC`,
    ),
    turnListAfterSeqLimit: prep(
      `SELECT
        id,
        session_id,
        seq,
        status,
        next_entry_order,
        version,
        metadata_json,
        started_at,
        updated_at,
        completed_at
      FROM turns
      WHERE session_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?`,
    ),
    turnUpdate: prep(
      `UPDATE turns
      SET
        session_id = ?,
        seq = ?,
        status = ?,
        next_entry_order = ?,
        version = ?,
        metadata_json = ?,
        started_at = ?,
        updated_at = ?,
        completed_at = ?
      WHERE id = ?`,
    ),

    entryInsert: prep(
      `INSERT INTO turn_entries (
        id,
        session_id,
        turn_id,
        entry_order,
        kind,
        visibility,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    entryListByTurn: prep(
      `SELECT
        id,
        session_id,
        turn_id,
        entry_order,
        kind,
        visibility,
        payload_json,
        created_at
      FROM turn_entries
      WHERE turn_id = ?
      ORDER BY entry_order ASC`,
    ),
    entryListByTurnVisibility: prep(
      `SELECT
        id,
        session_id,
        turn_id,
        entry_order,
        kind,
        visibility,
        payload_json,
        created_at
      FROM turn_entries
      WHERE turn_id = ? AND visibility = ?
      ORDER BY entry_order ASC`,
    ),
    entryListBySessionAfterSeq: prep(
      `SELECT
        e.id,
        e.session_id,
        e.turn_id,
        e.entry_order,
        e.kind,
        e.visibility,
        e.payload_json,
        e.created_at
      FROM turn_entries e
      INNER JOIN turns t ON t.id = e.turn_id
      WHERE t.session_id = ? AND t.seq > ?
      ORDER BY t.seq ASC, e.entry_order ASC`,
    ),
    entryListBySessionAfterSeqVisibility: prep(
      `SELECT
        e.id,
        e.session_id,
        e.turn_id,
        e.entry_order,
        e.kind,
        e.visibility,
        e.payload_json,
        e.created_at
      FROM turn_entries e
      INNER JOIN turns t ON t.id = e.turn_id
      WHERE t.session_id = ? AND t.seq > ? AND e.visibility = ?
      ORDER BY t.seq ASC, e.entry_order ASC`,
    ),

    historySnapshotInsert: prep(
      `INSERT INTO history_snapshots (
        id,
        session_id,
        through_turn_seq,
        reason,
        messages_json,
        source_session_id,
        source_message_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    historySnapshotRead: prep(
      `SELECT
        id,
        session_id,
        through_turn_seq,
        reason,
        messages_json,
        source_session_id,
        source_message_id,
        created_at
      FROM history_snapshots
      WHERE id = ?`,
    ),
  };
}

export const SESSION_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  parent_session_id TEXT,
  branched_from_message_id TEXT,
  current_history_snapshot_id TEXT,
  next_turn_seq INTEGER NOT NULL,
  version INTEGER NOT NULL,
  resume_model_provider TEXT NOT NULL,
  resume_model_id TEXT NOT NULL,
  resume_agent TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  next_entry_order INTEGER NOT NULL,
  version INTEGER NOT NULL,
  metadata_json TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS turns_by_session_seq
  ON turns (session_id, seq);

CREATE TABLE IF NOT EXISTS turn_entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  entry_order INTEGER NOT NULL,
  kind TEXT NOT NULL,
  visibility TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (turn_id, entry_order)
);

CREATE INDEX IF NOT EXISTS turn_entries_by_turn_order
  ON turn_entries (turn_id, entry_order);

CREATE INDEX IF NOT EXISTS turn_entries_by_session_kind
  ON turn_entries (session_id, kind);

CREATE TABLE IF NOT EXISTS history_snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  through_turn_seq INTEGER NOT NULL,
  reason TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  source_session_id TEXT,
  source_message_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS history_snapshots_by_session
  ON history_snapshots (session_id, created_at);
`;

export function sessionFromSql(row: SessionSqlRow): Session {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parentSessionId: row.parent_session_id ?? undefined,
    branchedFromMessageId: row.branched_from_message_id ?? undefined,
    currentHistorySnapshotId: row.current_history_snapshot_id,
    nextTurnSeq: row.next_turn_seq,
    version: row.version,
    resumeTurnConfig: {
      agent: row.resume_agent,
      model: {
        provider: row.resume_model_provider,
        model: row.resume_model_id,
      },
    },
    metadata: row.metadata_json
      ? (JSON.parse(row.metadata_json) as Session["metadata"])
      : undefined,
  };
}

export function turnFromSql(row: TurnSqlRow): Turn {
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    status: row.status,
    nextEntryOrder: row.next_entry_order,
    version: row.version,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Turn["metadata"]) : undefined,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

export function turnEntryFromSql(row: TurnEntrySqlRow): TurnEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    order: row.entry_order,
    kind: row.kind,
    visibility: row.visibility,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
  };
}

export function historySnapshotFromSql(row: HistorySnapshotSqlRow): HistorySnapshot {
  return {
    id: row.id,
    sessionId: row.session_id,
    throughTurnSeq: row.through_turn_seq,
    reason: row.reason,
    messages: JSON.parse(row.messages_json) as HistorySnapshot["messages"],
    sourceSessionId: row.source_session_id ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined,
    createdAt: row.created_at,
  };
}
