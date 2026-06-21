import type { Message } from "../types.ts";

export type MaybeAsync<T> = T | Promise<T>;

export type MetadataBag = Record<string, unknown>;

export interface SessionMetadata {
  id: string;
  createdAt: number;
  updatedAt: number;
  parentSessionId?: string;
  branchedFromMessageId?: string;
  metadata?: MetadataBag;
}

export type SnapshotReason = "compaction" | "branch-base";
export type EntryVisibility = "prompt" | "ui";
export type TurnStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * Stable session record plus its append/branch bookkeeping.
 *
 * Configuration (model, agent, system prompt, etc.) is the implementer's
 * concern. If a host wants to persist any of it, it goes in the opaque
 * `metadata` blob — core takes no opinion on its contents.
 */
export interface Session {
  id: string;
  createdAt: number;
  updatedAt: number;
  parentSessionId?: string;
  branchedFromMessageId?: string;
  currentHistorySnapshotId: string | null;
  nextTurnSeq: number;
  version: number;
  metadata?: MetadataBag;
}

/**
 * A turn is the unit of execution: one user input followed by any number of
 * assistant messages, tool results, and other artifacts appended as entries.
 *
 * The turn itself is a lifecycle/grouping container. Individual messages and
 * tool results are stored as entries within the turn.
 */
export interface Turn {
  id: string;
  sessionId: string;
  seq: number;
  status: TurnStatus;
  nextEntryOrder: number;
  version: number;
  metadata?: MetadataBag;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
}

/**
 * Append-only turn-scoped artifact.
 *
 * Entries are first-class so compaction can keep prompt-relevant messages while
 * dropping or summarizing heavier tool results.
 */
export interface TurnEntry {
  id: string;
  sessionId: string;
  turnId: string;
  order: number;
  kind: string;
  visibility: EntryVisibility;
  payload: unknown;
  createdAt: number;
}

export interface MessageEntryPayload {
  message: Message;
  metadata?: MetadataBag;
}

export interface ToolResultEntryPayload {
  callId: string;
  tool: string;
  output?: string;
  error?: string;
  durationMs?: number;
  metadata?: MetadataBag;
}

export interface ReasoningEntryPayload {
  text: string;
  metadata?: MetadataBag;
}

/**
 * Materialized prompt-visible checkpoint.
 *
 * Snapshots are for rebuilding the prompt-visible message list, not for holding
 * every turn artifact.
 */
export interface HistorySnapshot {
  id: string;
  sessionId: string;
  throughTurnSeq: number;
  messages: Message[];
  reason: SnapshotReason;
  createdAt: number;
  sourceSessionId?: string;
  sourceMessageId?: string;
}

export interface SessionStorageRead {
  getSession(sessionId: string): MaybeAsync<Session | null>;
  getTurn(turnId: string): MaybeAsync<Turn | null>;
  listTurns(sessionId: string, options?: { afterSeq?: number; limit?: number }): MaybeAsync<Turn[]>;
  listTurnEntries(
    turnId: string,
    options?: { visibility?: EntryVisibility | "all" },
  ): MaybeAsync<TurnEntry[]>;
  listTurnsWithEntries(
    sessionId: string,
    options?: { afterSeq?: number; visibility?: EntryVisibility | "all" },
  ): MaybeAsync<LoadedTurn[]>;
  getHistorySnapshot(snapshotId: string): MaybeAsync<HistorySnapshot | null>;
  listSessions(options?: { limit?: number; offset?: number }): MaybeAsync<Session[]>;
  listSessionsByParent(parentSessionId: string): MaybeAsync<Session[]>;
}

export interface SessionStorageWrite {
  insertSession(session: Session): MaybeAsync<void>;
  updateSession(session: Session, options?: { expectedVersion?: number }): MaybeAsync<void>;
  insertTurn(turn: Turn): MaybeAsync<void>;
  updateTurn(turn: Turn, options?: { expectedVersion?: number }): MaybeAsync<void>;
  appendTurnEntries(entries: ReadonlyArray<TurnEntry>): MaybeAsync<void>;
  insertHistorySnapshot(snapshot: HistorySnapshot): MaybeAsync<void>;
}

export interface SessionStorageTxn extends SessionStorageRead, SessionStorageWrite {}

/**
 * Low-level storage seam.
 *
 * Drivers implement persistence and transactions. The shared adapter owns turn
 * semantics, branching, compaction, and projection back into prompt-visible
 * message history.
 */
export interface SessionStorageDriver extends SessionStorageRead {
  transaction<T>(fn: (tx: SessionStorageTxn) => MaybeAsync<T>): MaybeAsync<T>;
}

export interface LoadedTurn {
  turn: Turn;
  entries: TurnEntry[];
}

export interface VisibleHistory {
  session: Session;
  historySnapshot: HistorySnapshot | null;
  trailingTurns: LoadedTurn[];
}
