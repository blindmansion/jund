import type {
  HistorySnapshot,
  LoadedTurn,
  MaybeAsync,
  EntryVisibility,
  TurnEntry,
  Session,
  SessionStorageDriver,
  SessionStorageTxn,
  Turn,
} from "./types.ts";
import {
  historySnapshotFromSql,
  sessionFromSql,
  turnEntryFromSql,
  turnFromSql,
  type HistorySnapshotSqlRow,
  type SessionSqlRow,
  type TurnEntrySqlRow,
  type TurnSqlRow,
} from "./sqlite-core.ts";

// ── Postgres pool interface ─────────────────────────────────────────

/** Minimal pool interface matching the `pg` package's `Pool` class. */
interface PgPool {
  query<T = any>(text: string, values?: any[]): Promise<{ rows: T[] }>;
  connect(): Promise<PgPoolClient>;
}

interface PgPoolClient {
  query<T = any>(text: string, values?: any[]): Promise<{ rows: T[] }>;
  release(): void;
}

type QueryFn = <T = any>(text: string, values?: any[]) => Promise<{ rows: T[] }>;

// ── Schema (aligned with sqlite-core session tables) ───────────────

const SCHEMA = `
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
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  next_entry_order INTEGER NOT NULL,
  version INTEGER NOT NULL,
  metadata_json TEXT,
  started_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  completed_at BIGINT,
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
  created_at BIGINT NOT NULL,
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
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS history_snapshots_by_session
  ON history_snapshots (session_id, created_at);
`;

const SQL = {
  sessionRead: `SELECT
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
      WHERE id = $1`,
  sessionReadForUpdate: `SELECT
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
      WHERE id = $1
      FOR UPDATE`,
  sessionInsert: `INSERT INTO sessions (
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
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
  sessionUpdate: `UPDATE sessions
      SET
        parent_session_id = $1,
        branched_from_message_id = $2,
        current_history_snapshot_id = $3,
        next_turn_seq = $4,
        version = $5,
        resume_model_provider = $6,
        resume_model_id = $7,
        resume_agent = $8,
        metadata_json = $9,
        created_at = $10,
        updated_at = $11
      WHERE id = $12`,

  turnRead: `SELECT
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
      WHERE id = $1`,
  turnReadForUpdate: `SELECT
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
      WHERE id = $1
      FOR UPDATE`,
  turnListAfterSeq: `SELECT
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
      WHERE session_id = $1 AND seq > $2
      ORDER BY seq ASC`,
  turnListAfterSeqLimit: `SELECT
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
      WHERE session_id = $1 AND seq > $2
      ORDER BY seq ASC
      LIMIT $3`,
  turnInsert: `INSERT INTO turns (
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
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
  turnUpdate: `UPDATE turns
      SET
        session_id = $1,
        seq = $2,
        status = $3,
        next_entry_order = $4,
        version = $5,
        metadata_json = $6,
        started_at = $7,
        updated_at = $8,
        completed_at = $9
      WHERE id = $10`,

  entryListByTurn: `SELECT
        id,
        session_id,
        turn_id,
        entry_order,
        kind,
        visibility,
        payload_json,
        created_at
      FROM turn_entries
      WHERE turn_id = $1
      ORDER BY entry_order ASC`,
  entryListByTurnVisibility: `SELECT
        id,
        session_id,
        turn_id,
        entry_order,
        kind,
        visibility,
        payload_json,
        created_at
      FROM turn_entries
      WHERE turn_id = $1 AND visibility = $2
      ORDER BY entry_order ASC`,
  entryListBySessionAfterSeq: `SELECT
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
      WHERE t.session_id = $1 AND t.seq > $2
      ORDER BY t.seq ASC, e.entry_order ASC`,
  entryListBySessionAfterSeqVisibility: `SELECT
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
      WHERE t.session_id = $1 AND t.seq > $2 AND e.visibility = $3
      ORDER BY t.seq ASC, e.entry_order ASC`,
  entryInsert: `INSERT INTO turn_entries (
        id,
        session_id,
        turn_id,
        entry_order,
        kind,
        visibility,
        payload_json,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,

  historySnapshotRead: `SELECT
        id,
        session_id,
        through_turn_seq,
        reason,
        messages_json,
        source_session_id,
        source_message_id,
        created_at
      FROM history_snapshots
      WHERE id = $1`,
  historySnapshotInsert: `INSERT INTO history_snapshots (
        id,
        session_id,
        through_turn_seq,
        reason,
        messages_json,
        source_session_id,
        source_message_id,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,

  sessionList: `SELECT
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
  sessionListLimit: `SELECT
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
      LIMIT $1 OFFSET $2`,
  sessionListByParent: `SELECT
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
      WHERE parent_session_id = $1
      ORDER BY created_at DESC`,
} as const;

function asInt(n: unknown): number {
  if (n == null) {
    throw new Error("expected non-null numeric value from Postgres");
  }
  if (typeof n === "number") {
    return n;
  }
  if (typeof n === "bigint") {
    return Number(n);
  }
  if (typeof n === "string") {
    return parseInt(n, 10);
  }
  return Number(n);
}

function asIntOrNull(n: unknown): number | null {
  if (n == null) {
    return null;
  }
  return asInt(n);
}

function normalizeSessionRow(row: Record<string, unknown>): SessionSqlRow {
  return {
    id: row.id as string,
    parent_session_id: (row.parent_session_id as string | null) ?? null,
    branched_from_message_id: (row.branched_from_message_id as string | null) ?? null,
    current_history_snapshot_id: (row.current_history_snapshot_id as string | null) ?? null,
    next_turn_seq: asInt(row.next_turn_seq),
    version: asInt(row.version),
    resume_model_provider: row.resume_model_provider as string,
    resume_model_id: row.resume_model_id as string,
    resume_agent: row.resume_agent as string,
    metadata_json: (row.metadata_json as string | null) ?? null,
    created_at: asInt(row.created_at),
    updated_at: asInt(row.updated_at),
  };
}

function normalizeTurnRow(row: Record<string, unknown>): TurnSqlRow {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    seq: asInt(row.seq),
    status: row.status as Turn["status"],
    next_entry_order: asInt(row.next_entry_order),
    version: asInt(row.version),
    metadata_json: (row.metadata_json as string | null) ?? null,
    started_at: asInt(row.started_at),
    updated_at: asInt(row.updated_at),
    completed_at: asIntOrNull(row.completed_at),
  };
}

function normalizeTurnEntryRow(row: Record<string, unknown>): TurnEntrySqlRow {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    turn_id: row.turn_id as string,
    entry_order: asInt(row.entry_order),
    kind: row.kind as string,
    visibility: row.visibility as EntryVisibility,
    payload_json: row.payload_json as string,
    created_at: asInt(row.created_at),
  };
}

function normalizeHistorySnapshotRow(row: Record<string, unknown>): HistorySnapshotSqlRow {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    through_turn_seq: asInt(row.through_turn_seq),
    reason: row.reason as HistorySnapshotSqlRow["reason"],
    messages_json: row.messages_json as string,
    source_session_id: (row.source_session_id as string | null) ?? null,
    source_message_id: (row.source_message_id as string | null) ?? null,
    created_at: asInt(row.created_at),
  };
}

async function withPgTransaction<R>(pool: PgPool, fn: (query: QueryFn) => Promise<R>): Promise<R> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn((text, values) => client.query(text, values));
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original error if rollback also fails.
    }
    throw err;
  } finally {
    client.release();
  }
}

class PgSessionTxn implements SessionStorageTxn {
  constructor(
    private readonly q: QueryFn,
    private readonly lockRows: boolean,
  ) {}

  async getSession(sessionId: string): Promise<Session | null> {
    const { rows } = await this.q<Record<string, unknown>>(SQL.sessionRead, [sessionId]);
    const row = rows[0];
    return row ? sessionFromSql(normalizeSessionRow(row)) : null;
  }

  async getTurn(turnId: string): Promise<Turn | null> {
    const { rows } = await this.q<Record<string, unknown>>(SQL.turnRead, [turnId]);
    const row = rows[0];
    return row ? turnFromSql(normalizeTurnRow(row)) : null;
  }

  async listTurns(
    sessionId: string,
    options?: { afterSeq?: number; limit?: number },
  ): Promise<Turn[]> {
    const afterSeq = options?.afterSeq ?? 0;
    const { rows } =
      options?.limit === undefined
        ? await this.q<Record<string, unknown>>(SQL.turnListAfterSeq, [sessionId, afterSeq])
        : await this.q<Record<string, unknown>>(SQL.turnListAfterSeqLimit, [
            sessionId,
            afterSeq,
            Math.max(0, options.limit),
          ]);
    return rows.map((r) => turnFromSql(normalizeTurnRow(r)));
  }

  async listTurnEntries(
    turnId: string,
    options?: { visibility?: EntryVisibility | "all" },
  ): Promise<TurnEntry[]> {
    const visibility = options?.visibility ?? "all";
    const { rows } =
      visibility === "all"
        ? await this.q<Record<string, unknown>>(SQL.entryListByTurn, [turnId])
        : await this.q<Record<string, unknown>>(SQL.entryListByTurnVisibility, [
            turnId,
            visibility,
          ]);
    return rows.map((r) => turnEntryFromSql(normalizeTurnEntryRow(r)));
  }

  async listTurnsWithEntries(
    sessionId: string,
    options?: { afterSeq?: number; visibility?: EntryVisibility | "all" },
  ): Promise<LoadedTurn[]> {
    const afterSeq = options?.afterSeq ?? 0;
    const turns = await this.listTurns(sessionId, { afterSeq });

    const visibility = options?.visibility ?? "all";
    const { rows } =
      visibility === "all"
        ? await this.q<Record<string, unknown>>(SQL.entryListBySessionAfterSeq, [
            sessionId,
            afterSeq,
          ])
        : await this.q<Record<string, unknown>>(SQL.entryListBySessionAfterSeqVisibility, [
            sessionId,
            afterSeq,
            visibility,
          ]);

    const entriesByTurn = new Map<string, TurnEntry[]>();
    for (const raw of rows) {
      const row = normalizeTurnEntryRow(raw);
      const entry = turnEntryFromSql(row);
      let list = entriesByTurn.get(entry.turnId);
      if (!list) {
        list = [];
        entriesByTurn.set(entry.turnId, list);
      }
      list.push(entry);
    }

    return turns.map((turn) => ({
      turn,
      entries: entriesByTurn.get(turn.id) ?? [],
    }));
  }

  async getHistorySnapshot(snapshotId: string): Promise<HistorySnapshot | null> {
    const { rows } = await this.q<Record<string, unknown>>(SQL.historySnapshotRead, [snapshotId]);
    const row = rows[0];
    return row ? historySnapshotFromSql(normalizeHistorySnapshotRow(row)) : null;
  }

  async listSessions(options?: { limit?: number; offset?: number }): Promise<Session[]> {
    const { rows } =
      options?.limit !== undefined
        ? await this.q<Record<string, unknown>>(SQL.sessionListLimit, [
            Math.max(0, options.limit),
            options.offset ?? 0,
          ])
        : await this.q<Record<string, unknown>>(SQL.sessionList);
    return rows.map((r) => sessionFromSql(normalizeSessionRow(r)));
  }

  async listSessionsByParent(parentSessionId: string): Promise<Session[]> {
    const { rows } = await this.q<Record<string, unknown>>(SQL.sessionListByParent, [
      parentSessionId,
    ]);
    return rows.map((r) => sessionFromSql(normalizeSessionRow(r)));
  }

  async insertSession(session: Session): Promise<void> {
    await this.q(SQL.sessionInsert, [
      session.id,
      session.parentSessionId ?? null,
      session.branchedFromMessageId ?? null,
      session.currentHistorySnapshotId,
      session.nextTurnSeq,
      session.version,
      session.resumeTurnConfig.model.provider,
      session.resumeTurnConfig.model.model,
      session.resumeTurnConfig.agent,
      JSON.stringify(session.metadata ?? null),
      session.createdAt,
      session.updatedAt,
    ]);
  }

  async updateSession(session: Session, options?: { expectedVersion?: number }): Promise<void> {
    const readSql = this.lockRows ? SQL.sessionReadForUpdate : SQL.sessionRead;
    const { rows } = await this.q<Record<string, unknown>>(readSql, [session.id]);
    const currentRaw = rows[0];
    if (!currentRaw) {
      throw new Error(`Unknown session: ${session.id}`);
    }
    const current = normalizeSessionRow(currentRaw);
    if (options?.expectedVersion !== undefined && current.version !== options.expectedVersion) {
      throw new Error(
        `Concurrent session update: expected version ${options.expectedVersion}, got ${current.version}`,
      );
    }
    await this.q(SQL.sessionUpdate, [
      session.parentSessionId ?? null,
      session.branchedFromMessageId ?? null,
      session.currentHistorySnapshotId,
      session.nextTurnSeq,
      session.version,
      session.resumeTurnConfig.model.provider,
      session.resumeTurnConfig.model.model,
      session.resumeTurnConfig.agent,
      JSON.stringify(session.metadata ?? null),
      session.createdAt,
      session.updatedAt,
      session.id,
    ]);
  }

  async insertTurn(turn: Turn): Promise<void> {
    await this.q(SQL.turnInsert, [
      turn.id,
      turn.sessionId,
      turn.seq,
      turn.status,
      turn.nextEntryOrder,
      turn.version,
      JSON.stringify(turn.metadata ?? null),
      turn.startedAt,
      turn.updatedAt,
      turn.completedAt ?? null,
    ]);
  }

  async updateTurn(turn: Turn, options?: { expectedVersion?: number }): Promise<void> {
    const readSql = this.lockRows ? SQL.turnReadForUpdate : SQL.turnRead;
    const { rows } = await this.q<Record<string, unknown>>(readSql, [turn.id]);
    const currentRaw = rows[0];
    if (!currentRaw) {
      throw new Error(`Unknown turn: ${turn.id}`);
    }
    const current = normalizeTurnRow(currentRaw);
    if (options?.expectedVersion !== undefined && current.version !== options.expectedVersion) {
      throw new Error(
        `Concurrent turn update: expected version ${options.expectedVersion}, got ${current.version}`,
      );
    }
    await this.q(SQL.turnUpdate, [
      turn.sessionId,
      turn.seq,
      turn.status,
      turn.nextEntryOrder,
      turn.version,
      JSON.stringify(turn.metadata ?? null),
      turn.startedAt,
      turn.updatedAt,
      turn.completedAt ?? null,
      turn.id,
    ]);
  }

  async appendTurnEntries(entries: ReadonlyArray<TurnEntry>): Promise<void> {
    for (const entry of entries) {
      await this.q(SQL.entryInsert, [
        entry.id,
        entry.sessionId,
        entry.turnId,
        entry.order,
        entry.kind,
        entry.visibility,
        JSON.stringify(entry.payload),
        entry.createdAt,
      ]);
    }
  }

  async insertHistorySnapshot(snapshot: HistorySnapshot): Promise<void> {
    await this.q(SQL.historySnapshotInsert, [
      snapshot.id,
      snapshot.sessionId,
      snapshot.throughTurnSeq,
      snapshot.reason,
      JSON.stringify(snapshot.messages),
      snapshot.sourceSessionId ?? null,
      snapshot.sourceMessageId ?? null,
      snapshot.createdAt,
    ]);
  }
}

/**
 * PostgreSQL-backed session storage using a `pg`-style pool.
 *
 * ```ts
 * import { Pool } from "pg";
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const storage = await PgStorage.create(pool);
 * const session = await createSession({ storage, ... });
 * ```
 */
export class PgStorage implements SessionStorageDriver {
  readonly #pool: PgPool;
  readonly #root: PgSessionTxn;

  private constructor(pool: PgPool) {
    this.#pool = pool;
    this.#root = new PgSessionTxn((text, values) => pool.query(text, values), false);
  }

  /**
   * Ensures tables exist, then returns a driver instance.
   */
  static async create(pool: PgPool): Promise<PgStorage> {
    await pool.query(SCHEMA);
    return new PgStorage(pool);
  }

  getSession(sessionId: string): Promise<Session | null> {
    return this.#root.getSession(sessionId);
  }

  getTurn(turnId: string): Promise<Turn | null> {
    return this.#root.getTurn(turnId);
  }

  listTurns(sessionId: string, options?: { afterSeq?: number; limit?: number }): Promise<Turn[]> {
    return this.#root.listTurns(sessionId, options);
  }

  listTurnEntries(
    turnId: string,
    options?: { visibility?: EntryVisibility | "all" },
  ): Promise<TurnEntry[]> {
    return this.#root.listTurnEntries(turnId, options);
  }

  listTurnsWithEntries(
    sessionId: string,
    options?: { afterSeq?: number; visibility?: EntryVisibility | "all" },
  ): Promise<LoadedTurn[]> {
    return this.#root.listTurnsWithEntries(sessionId, options);
  }

  getHistorySnapshot(snapshotId: string): Promise<HistorySnapshot | null> {
    return this.#root.getHistorySnapshot(snapshotId);
  }

  listSessions(options?: { limit?: number; offset?: number }): Promise<Session[]> {
    return this.#root.listSessions(options);
  }

  listSessionsByParent(parentSessionId: string): Promise<Session[]> {
    return this.#root.listSessionsByParent(parentSessionId);
  }

  async transaction<T>(fn: (tx: SessionStorageTxn) => MaybeAsync<T>): Promise<T> {
    return withPgTransaction(this.#pool, async (q) => {
      const txn = new PgSessionTxn(q, true);
      return await fn(txn);
    });
  }
}
