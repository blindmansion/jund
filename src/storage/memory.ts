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

export class MemoryStorage implements SessionStorageDriver, SessionStorageTxn {
  #sessions = new Map<string, Session>();
  #turnsById = new Map<string, Turn>();
  #turnsBySession = new Map<string, Turn[]>();
  #entriesByTurn = new Map<string, TurnEntry[]>();
  #historySnapshots = new Map<string, HistorySnapshot>();

  transaction<T>(fn: (tx: SessionStorageTxn) => MaybeAsync<T>): MaybeAsync<T> {
    return fn(this);
  }

  getSession(sessionId: string): Session | null {
    const session = this.#sessions.get(sessionId);
    return session ? clone(session) : null;
  }

  getTurn(turnId: string): Turn | null {
    const turn = this.#turnsById.get(turnId);
    return turn ? clone(turn) : null;
  }

  listTurns(sessionId: string, options?: { afterSeq?: number; limit?: number }): Turn[] {
    const list = this.#turnsBySession.get(sessionId);
    if (!list) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const afterSeq = options?.afterSeq ?? 0;
    const filtered = list.filter((turn) => turn.seq > afterSeq);
    const limited =
      options?.limit === undefined ? filtered : filtered.slice(0, Math.max(0, options.limit));
    return clone(limited);
  }

  listTurnEntries(turnId: string, options?: { visibility?: EntryVisibility | "all" }): TurnEntry[] {
    const list = this.#entriesByTurn.get(turnId);
    if (!list) {
      throw new Error(`Unknown turn: ${turnId}`);
    }
    const visibility = options?.visibility ?? "all";
    const filtered =
      visibility === "all" ? list : list.filter((entry) => entry.visibility === visibility);
    return clone(filtered);
  }

  listTurnsWithEntries(
    sessionId: string,
    options?: { afterSeq?: number; visibility?: EntryVisibility | "all" },
  ): LoadedTurn[] {
    const turns = this.listTurns(sessionId, { afterSeq: options?.afterSeq });
    const visibility = options?.visibility ?? "all";
    return turns.map((turn) => {
      const list = this.#entriesByTurn.get(turn.id);
      if (!list) {
        return { turn, entries: [] };
      }
      const filtered =
        visibility === "all" ? list : list.filter((e) => e.visibility === visibility);
      return { turn, entries: clone(filtered) };
    });
  }

  getHistorySnapshot(snapshotId: string): HistorySnapshot | null {
    const snapshot = this.#historySnapshots.get(snapshotId);
    return snapshot ? clone(snapshot) : null;
  }

  listSessions(options?: { limit?: number; offset?: number }): Session[] {
    const all = [...this.#sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
    const offset = options?.offset ?? 0;
    const sliced =
      options?.limit !== undefined
        ? all.slice(offset, offset + Math.max(0, options.limit))
        : all.slice(offset);
    return clone(sliced);
  }

  listSessionsByParent(parentSessionId: string): Session[] {
    const matches = [...this.#sessions.values()]
      .filter((s) => s.parentSessionId === parentSessionId)
      .sort((a, b) => b.createdAt - a.createdAt);
    return clone(matches);
  }

  insertSession(session: Session): void {
    if (this.#sessions.has(session.id)) {
      throw new Error(`Session already exists: ${session.id}`);
    }
    this.#sessions.set(session.id, clone(session));
    this.#turnsBySession.set(session.id, []);
  }

  updateSession(session: Session, options?: { expectedVersion?: number }): void {
    const current = this.#sessions.get(session.id);
    if (!current) {
      throw new Error(`Unknown session: ${session.id}`);
    }
    if (options?.expectedVersion !== undefined && current.version !== options.expectedVersion) {
      throw new Error(
        `Concurrent session update: expected version ${options.expectedVersion}, got ${current.version}`,
      );
    }
    this.#sessions.set(session.id, clone(session));
  }

  insertTurn(turn: Turn): void {
    if (this.#turnsById.has(turn.id)) {
      throw new Error(`Turn already exists: ${turn.id}`);
    }
    const turns = this.#turnsBySession.get(turn.sessionId);
    if (!turns) {
      throw new Error(`Unknown session: ${turn.sessionId}`);
    }
    if (turns.some((existing) => existing.seq === turn.seq)) {
      throw new Error(`Turn sequence already exists: ${turn.sessionId}#${turn.seq}`);
    }
    const cloned = clone(turn);
    turns.push(cloned);
    turns.sort((a, b) => a.seq - b.seq);
    this.#turnsById.set(turn.id, cloned);
    this.#entriesByTurn.set(turn.id, []);
  }

  updateTurn(turn: Turn, options?: { expectedVersion?: number }): void {
    const current = this.#turnsById.get(turn.id);
    if (!current) {
      throw new Error(`Unknown turn: ${turn.id}`);
    }
    if (options?.expectedVersion !== undefined && current.version !== options.expectedVersion) {
      throw new Error(
        `Concurrent turn update: expected version ${options.expectedVersion}, got ${current.version}`,
      );
    }
    const turns = this.#turnsBySession.get(turn.sessionId);
    if (!turns) {
      throw new Error(`Unknown session: ${turn.sessionId}`);
    }
    const index = turns.findIndex((existing) => existing.id === turn.id);
    if (index === -1) {
      throw new Error(`Unknown turn: ${turn.id}`);
    }
    const cloned = clone(turn);
    turns[index] = cloned;
    this.#turnsById.set(turn.id, cloned);
  }

  appendTurnEntries(entries: ReadonlyArray<TurnEntry>): void {
    for (const entry of entries) {
      const list = this.#entriesByTurn.get(entry.turnId);
      if (!list) {
        throw new Error(`Unknown turn: ${entry.turnId}`);
      }
      if (list.some((existing) => existing.order === entry.order)) {
        throw new Error(`Entry order already exists: ${entry.turnId}#${entry.order}`);
      }
      list.push(clone(entry));
      list.sort((a, b) => a.order - b.order);
    }
  }

  insertHistorySnapshot(snapshot: HistorySnapshot): void {
    if (this.#historySnapshots.has(snapshot.id)) {
      throw new Error(`History snapshot already exists: ${snapshot.id}`);
    }
    if (!this.#sessions.has(snapshot.sessionId)) {
      throw new Error(`Unknown session: ${snapshot.sessionId}`);
    }
    this.#historySnapshots.set(snapshot.id, clone(snapshot));
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
