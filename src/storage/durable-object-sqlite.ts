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
  SESSION_SQLITE_SCHEMA,
  historySnapshotFromSql,
  sessionFromSql,
  turnEntryFromSql,
  turnFromSql,
  type HistorySnapshotSqlRow,
  type SessionSqlRow,
  type TurnEntrySqlRow,
  type TurnSqlRow,
} from "./sqlite-core.ts";

/** Minimal cursor interface matching Cloudflare’s `SqlStorageCursor`. */
interface DurableObjectSqlCursor {
  next(): { done?: false; value: any } | { done: true; value?: undefined };
  toArray(): any[];
}

/** Minimal interface matching the `sql` property on `DurableObjectStorage`. */
interface DurableObjectSqlApi {
  exec(query: string, ...bindings: any[]): DurableObjectSqlCursor;
}

/**
 * Minimal `DurableObjectStorage` slice for SQLite-backed Durable Objects.
 *
 * Pass `ctx.storage` from your DO constructor. Use Cloudflare’s
 * {@link DurableObjectSessionSqlStorage.transaction} so SQL participates in the
 * same atomic commit as the platform (do not issue `BEGIN`/`COMMIT` via `sql.exec`).
 */
interface DurableObjectSessionSqlStorage {
  sql: DurableObjectSqlApi;
  transaction<T>(closure: () => Promise<T>): Promise<T>;
}

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
        workdir,
        metadata_json,
        created_at,
        updated_at
      FROM sessions
      WHERE id = ?`,

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
      WHERE id = ?`,

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
      WHERE session_id = ? AND seq > ?
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
      WHERE session_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?`,

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
      WHERE turn_id = ?
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
      WHERE turn_id = ? AND visibility = ?
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
      WHERE t.session_id = ? AND t.seq > ?
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
      WHERE t.session_id = ? AND t.seq > ? AND e.visibility = ?
      ORDER BY t.seq ASC, e.entry_order ASC`,

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
      WHERE id = ?`,

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
        workdir,
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
        workdir,
        metadata_json,
        created_at,
        updated_at
      FROM sessions
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`,
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
        workdir,
        metadata_json,
        created_at,
        updated_at
      FROM sessions
      WHERE parent_session_id = ?
      ORDER BY created_at DESC`,
} as const;

function first(cursor: DurableObjectSqlCursor): any {
  const r = cursor.next();
  return r.done ? null : r.value;
}

/**
 * Session turn storage for Cloudflare SQLite-backed Durable Objects.
 *
 * ```ts
 * import { DurableObject } from "cloudflare:workers";
 *
 * export class SessionDO extends DurableObject {
 *   private readonly driver: DurableObjectSqliteStorage;
 *
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env);
 *     this.driver = new DurableObjectSqliteStorage(ctx.storage);
 *   }
 * }
 * ```
 */
export class DurableObjectSqliteStorage implements SessionStorageDriver, SessionStorageTxn {
  readonly #sql: DurableObjectSqlApi;
  readonly #storage: DurableObjectSessionSqlStorage;
  #transactionQueue: Promise<void> = Promise.resolve();

  constructor(storage: DurableObjectSessionSqlStorage) {
    this.#storage = storage;
    this.#sql = storage.sql;
    this.#sql.exec(SESSION_SQLITE_SCHEMA);
  }

  getSession(sessionId: string): Session | null {
    const row = first(this.#sql.exec(SQL.sessionRead, sessionId)) as SessionSqlRow | null;
    return row ? sessionFromSql(row) : null;
  }

  getTurn(turnId: string): Turn | null {
    const row = first(this.#sql.exec(SQL.turnRead, turnId)) as TurnSqlRow | null;
    return row ? turnFromSql(row) : null;
  }

  listTurns(sessionId: string, options?: { afterSeq?: number; limit?: number }): Turn[] {
    const afterSeq = options?.afterSeq ?? 0;
    const rows =
      options?.limit === undefined
        ? (this.#sql.exec(SQL.turnListAfterSeq, sessionId, afterSeq).toArray() as TurnSqlRow[])
        : (this.#sql
            .exec(SQL.turnListAfterSeqLimit, sessionId, afterSeq, Math.max(0, options.limit))
            .toArray() as TurnSqlRow[]);
    return rows.map(turnFromSql);
  }

  listTurnEntries(turnId: string, options?: { visibility?: EntryVisibility | "all" }): TurnEntry[] {
    const visibility = options?.visibility ?? "all";
    const rows =
      visibility === "all"
        ? (this.#sql.exec(SQL.entryListByTurn, turnId).toArray() as TurnEntrySqlRow[])
        : (this.#sql
            .exec(SQL.entryListByTurnVisibility, turnId, visibility)
            .toArray() as TurnEntrySqlRow[]);
    return rows.map(turnEntryFromSql);
  }

  listTurnsWithEntries(
    sessionId: string,
    options?: { afterSeq?: number; visibility?: EntryVisibility | "all" },
  ): LoadedTurn[] {
    const afterSeq = options?.afterSeq ?? 0;
    const turns = this.listTurns(sessionId, { afterSeq });

    const visibility = options?.visibility ?? "all";
    const entryRows =
      visibility === "all"
        ? (this.#sql
            .exec(SQL.entryListBySessionAfterSeq, sessionId, afterSeq)
            .toArray() as TurnEntrySqlRow[])
        : (this.#sql
            .exec(SQL.entryListBySessionAfterSeqVisibility, sessionId, afterSeq, visibility)
            .toArray() as TurnEntrySqlRow[]);

    const entriesByTurn = new Map<string, TurnEntry[]>();
    for (const row of entryRows) {
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

  getHistorySnapshot(snapshotId: string): HistorySnapshot | null {
    const row = first(
      this.#sql.exec(SQL.historySnapshotRead, snapshotId),
    ) as HistorySnapshotSqlRow | null;
    return row ? historySnapshotFromSql(row) : null;
  }

  listSessions(options?: { limit?: number; offset?: number }): Session[] {
    const rows =
      options?.limit !== undefined
        ? (this.#sql
            .exec(SQL.sessionListLimit, Math.max(0, options.limit), options.offset ?? 0)
            .toArray() as SessionSqlRow[])
        : (this.#sql.exec(SQL.sessionList).toArray() as SessionSqlRow[]);
    return rows.map(sessionFromSql);
  }

  listSessionsByParent(parentSessionId: string): Session[] {
    const rows = this.#sql
      .exec(SQL.sessionListByParent, parentSessionId)
      .toArray() as SessionSqlRow[];
    return rows.map(sessionFromSql);
  }

  insertSession(session: Session): void {
    this.#sql.exec(
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
        workdir,
        metadata_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      session.id,
      session.parentSessionId ?? null,
      session.branchedFromMessageId ?? null,
      session.currentHistorySnapshotId,
      session.nextTurnSeq,
      session.version,
      session.resumeTurnConfig.model.provider,
      session.resumeTurnConfig.model.model,
      session.resumeTurnConfig.agent,
      session.workdir,
      JSON.stringify(session.metadata ?? null),
      session.createdAt,
      session.updatedAt,
    );
  }

  updateSession(session: Session, options?: { expectedVersion?: number }): void {
    const current = first(this.#sql.exec(SQL.sessionRead, session.id)) as SessionSqlRow | null;
    if (!current) {
      throw new Error(`Unknown session: ${session.id}`);
    }
    if (options?.expectedVersion !== undefined && current.version !== options.expectedVersion) {
      throw new Error(
        `Concurrent session update: expected version ${options.expectedVersion}, got ${current.version}`,
      );
    }
    this.#sql.exec(
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
        workdir = ?,
        metadata_json = ?,
        created_at = ?,
        updated_at = ?
      WHERE id = ?`,
      session.parentSessionId ?? null,
      session.branchedFromMessageId ?? null,
      session.currentHistorySnapshotId,
      session.nextTurnSeq,
      session.version,
      session.resumeTurnConfig.model.provider,
      session.resumeTurnConfig.model.model,
      session.resumeTurnConfig.agent,
      session.workdir,
      JSON.stringify(session.metadata ?? null),
      session.createdAt,
      session.updatedAt,
      session.id,
    );
  }

  insertTurn(turn: Turn): void {
    this.#sql.exec(
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
    );
  }

  updateTurn(turn: Turn, options?: { expectedVersion?: number }): void {
    const current = first(this.#sql.exec(SQL.turnRead, turn.id)) as TurnSqlRow | null;
    if (!current) {
      throw new Error(`Unknown turn: ${turn.id}`);
    }
    if (options?.expectedVersion !== undefined && current.version !== options.expectedVersion) {
      throw new Error(
        `Concurrent turn update: expected version ${options.expectedVersion}, got ${current.version}`,
      );
    }
    this.#sql.exec(
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
    );
  }

  appendTurnEntries(entries: ReadonlyArray<TurnEntry>): void {
    for (const entry of entries) {
      this.#sql.exec(
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
        entry.id,
        entry.sessionId,
        entry.turnId,
        entry.order,
        entry.kind,
        entry.visibility,
        JSON.stringify(entry.payload),
        entry.createdAt,
      );
    }
  }

  insertHistorySnapshot(snapshot: HistorySnapshot): void {
    this.#sql.exec(
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
      snapshot.id,
      snapshot.sessionId,
      snapshot.throughTurnSeq,
      snapshot.reason,
      JSON.stringify(snapshot.messages),
      snapshot.sourceSessionId ?? null,
      snapshot.sourceMessageId ?? null,
      snapshot.createdAt,
    );
  }

  async transaction<T>(fn: (tx: SessionStorageTxn) => MaybeAsync<T>): Promise<T> {
    const run = async (): Promise<T> => {
      let result!: T;
      await this.#storage.transaction(async () => {
        result = await fn(this);
      });
      return result;
    };

    const pending = this.#transactionQueue.then(run, run);
    this.#transactionQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return await pending;
  }
}
