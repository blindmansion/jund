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
  prepareSessionSqliteStatements,
  sessionFromSql,
  turnEntryFromSql,
  turnFromSql,
  type SessionSqliteStatements,
  type HistorySnapshotSqlRow,
  type SessionSqlRow,
  type TurnEntrySqlRow,
  type TurnSqlRow,
} from "./sqlite-core.ts";

/** Minimal prepared statement interface matching `bun:sqlite`. */
interface BunSqliteStatement {
  run(...params: any[]): void;
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

/** Minimal database interface matching `bun:sqlite`'s `Database` class. */
interface BunSqliteDatabase {
  run(sql: string): void;
  prepare(sql: string): BunSqliteStatement;
}

/**
 * Bun SQLite implementation of the low-level turn storage driver.
 */
export class BunSqliteStorage implements SessionStorageDriver, SessionStorageTxn {
  readonly #stmts: SessionSqliteStatements;
  #transactionQueue: Promise<void> = Promise.resolve();

  constructor(private readonly db: BunSqliteDatabase) {
    db.run("PRAGMA foreign_keys = ON");
    db.run(SESSION_SQLITE_SCHEMA);
    this.#stmts = prepareSessionSqliteStatements(db);
  }

  getSession(sessionId: string): Session | null {
    const row = this.#stmts.sessionRead.get(sessionId) as SessionSqlRow | null;
    return row ? sessionFromSql(row) : null;
  }

  getTurn(turnId: string): Turn | null {
    const row = this.#stmts.turnRead.get(turnId) as TurnSqlRow | null;
    return row ? turnFromSql(row) : null;
  }

  listTurns(sessionId: string, options?: { afterSeq?: number; limit?: number }): Turn[] {
    const afterSeq = options?.afterSeq ?? 0;
    const rows =
      options?.limit === undefined
        ? (this.#stmts.turnListAfterSeq.all(sessionId, afterSeq) as TurnSqlRow[])
        : (this.#stmts.turnListAfterSeqLimit.all(
            sessionId,
            afterSeq,
            Math.max(0, options.limit),
          ) as TurnSqlRow[]);
    return rows.map(turnFromSql);
  }

  listTurnEntries(turnId: string, options?: { visibility?: EntryVisibility | "all" }): TurnEntry[] {
    const visibility = options?.visibility ?? "all";
    const rows =
      visibility === "all"
        ? (this.#stmts.entryListByTurn.all(turnId) as TurnEntrySqlRow[])
        : (this.#stmts.entryListByTurnVisibility.all(turnId, visibility) as TurnEntrySqlRow[]);
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
        ? (this.#stmts.entryListBySessionAfterSeq.all(sessionId, afterSeq) as TurnEntrySqlRow[])
        : (this.#stmts.entryListBySessionAfterSeqVisibility.all(
            sessionId,
            afterSeq,
            visibility,
          ) as TurnEntrySqlRow[]);

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
    const row = this.#stmts.historySnapshotRead.get(snapshotId) as HistorySnapshotSqlRow | null;
    return row ? historySnapshotFromSql(row) : null;
  }

  listSessions(options?: { limit?: number; offset?: number }): Session[] {
    const rows =
      options?.limit !== undefined
        ? (this.#stmts.sessionListLimit.all(
            Math.max(0, options.limit),
            options.offset ?? 0,
          ) as SessionSqlRow[])
        : (this.#stmts.sessionList.all() as SessionSqlRow[]);
    return rows.map(sessionFromSql);
  }

  listSessionsByParent(parentSessionId: string): Session[] {
    const rows = this.#stmts.sessionListByParent.all(parentSessionId) as SessionSqlRow[];
    return rows.map(sessionFromSql);
  }

  insertSession(session: Session): void {
    this.#stmts.sessionInsert.run(
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
    );
  }

  updateSession(session: Session, options?: { expectedVersion?: number }): void {
    const current = this.#stmts.sessionRead.get(session.id) as SessionSqlRow | null;
    if (!current) {
      throw new Error(`Unknown session: ${session.id}`);
    }
    if (options?.expectedVersion !== undefined && current.version !== options.expectedVersion) {
      throw new Error(
        `Concurrent session update: expected version ${options.expectedVersion}, got ${current.version}`,
      );
    }
    this.#stmts.sessionUpdate.run(
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
    );
  }

  insertTurn(turn: Turn): void {
    this.#stmts.turnInsert.run(
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
    const current = this.#stmts.turnRead.get(turn.id) as TurnSqlRow | null;
    if (!current) {
      throw new Error(`Unknown turn: ${turn.id}`);
    }
    if (options?.expectedVersion !== undefined && current.version !== options.expectedVersion) {
      throw new Error(
        `Concurrent turn update: expected version ${options.expectedVersion}, got ${current.version}`,
      );
    }
    this.#stmts.turnUpdate.run(
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
      this.#stmts.entryInsert.run(
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
    this.#stmts.historySnapshotInsert.run(
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
      this.db.run("BEGIN IMMEDIATE");
      try {
        const result = await fn(this);
        this.db.run("COMMIT");
        return result;
      } catch (error) {
        try {
          this.db.run("ROLLBACK");
        } catch {
          // Preserve the original error if rollback also fails.
        }
        throw error;
      }
    };

    const pending = this.#transactionQueue.then(run, run);
    this.#transactionQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return await pending;
  }
}
