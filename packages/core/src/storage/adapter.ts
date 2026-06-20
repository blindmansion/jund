import type { Message, UserMessage } from "../types.ts";
import { generateId } from "../util/id.ts";
import type {
  MetadataBag,
  EntryVisibility,
  MessageEntryPayload,
  SessionMetadata,
  TurnEntry,
  Session,
  SessionStorageDriver,
  SessionStorageRead,
  SnapshotReason,
  ToolResultEntryPayload,
  Turn,
  TurnStatus,
  VisibleHistory,
  HistorySnapshot,
  ResumeTurnConfig,
  ReasoningEntryPayload,
} from "./types.ts";

export class SessionPersistenceAdapter {
  constructor(private readonly driver: SessionStorageDriver) {}

  async createSession(metadata: SessionMetadata): Promise<Session> {
    const session = sessionFromMetadata(metadata);
    await this.driver.transaction(async (tx) => {
      await tx.insertSession(session);
    });
    return session;
  }

  async loadSession(sessionId: string): Promise<Session | null> {
    return await this.driver.getSession(sessionId);
  }

  async loadVisibleHistory(sessionId: string): Promise<VisibleHistory | null> {
    const session = await this.driver.getSession(sessionId);
    if (!session) {
      return null;
    }
    return await this.loadVisibleHistoryIn(this.driver, session);
  }

  async loadVisibleMessages(sessionId: string): Promise<Message[]> {
    const history = await this.loadVisibleHistory(sessionId);
    return history ? visibleHistoryToMessages(history) : [];
  }

  async startTurn(input: {
    sessionId: string;
    userMessage: Message;
    turnMetadata?: MetadataBag;
    messageMetadata?: MetadataBag;
  }): Promise<{ turn: Turn; userEntry: TurnEntry }> {
    return await this.driver.transaction(async (tx) => {
      const session = await requireSession(tx, input.sessionId);
      const now = Date.now();
      const turn: Turn = {
        id: generateId(),
        sessionId: input.sessionId,
        seq: session.nextTurnSeq,
        status: "running",
        nextEntryOrder: 2,
        version: 1,
        metadata: cloneValue(input.turnMetadata),
        startedAt: now,
        updatedAt: now,
      };
      const userEntry: TurnEntry = {
        id: generateId(),
        sessionId: input.sessionId,
        turnId: turn.id,
        order: 1,
        kind: "user-message",
        visibility: "prompt",
        payload: messageEntryPayloadFor(input.userMessage, input.messageMetadata),
        createdAt: now,
      };
      await tx.insertTurn(turn);
      await tx.appendTurnEntries([userEntry]);
      await tx.updateSession(
        {
          ...session,
          nextTurnSeq: session.nextTurnSeq + 1,
          resumeTurnConfig: resumeTurnConfigFromMessage(input.userMessage),
          version: session.version + 1,
          updatedAt: now,
        },
        { expectedVersion: session.version },
      );
      return { turn, userEntry };
    });
  }

  async appendTurnEntry(input: {
    sessionId: string;
    turnId: string;
    kind: string;
    payload: unknown;
    visibility?: EntryVisibility;
  }): Promise<{ turn: Turn; entry: TurnEntry }> {
    return await this.driver.transaction(async (tx) => {
      const turn = await requireTurn(tx, input.turnId);
      assertTurnBelongsToSession(turn, input.sessionId);
      const now = Date.now();
      const entry: TurnEntry = {
        id: generateId(),
        sessionId: input.sessionId,
        turnId: input.turnId,
        order: turn.nextEntryOrder,
        kind: input.kind,
        visibility: input.visibility ?? "ui",
        payload: cloneValue(input.payload),
        createdAt: now,
      };
      await tx.appendTurnEntries([entry]);
      const nextTurn: Turn = {
        ...turn,
        nextEntryOrder: turn.nextEntryOrder + 1,
        version: turn.version + 1,
        updatedAt: now,
      };
      await tx.updateTurn(nextTurn, { expectedVersion: turn.version });
      return { turn: nextTurn, entry };
    });
  }

  async appendTurnEntries(input: {
    sessionId: string;
    turnId: string;
    entries: ReadonlyArray<{
      kind: string;
      payload: unknown;
      visibility?: EntryVisibility;
    }>;
  }): Promise<{ turn: Turn; entries: TurnEntry[] }> {
    if (input.entries.length === 0) {
      const turn = await requireTurn(this.driver, input.turnId);
      return { turn, entries: [] };
    }
    return await this.driver.transaction(async (tx) => {
      const turn = await requireTurn(tx, input.turnId);
      assertTurnBelongsToSession(turn, input.sessionId);
      const now = Date.now();
      const newEntries: TurnEntry[] = input.entries.map((e, i) => ({
        id: generateId(),
        sessionId: input.sessionId,
        turnId: input.turnId,
        order: turn.nextEntryOrder + i,
        kind: e.kind,
        visibility: e.visibility ?? "ui",
        payload: cloneValue(e.payload),
        createdAt: now,
      }));
      await tx.appendTurnEntries(newEntries);
      const nextTurn: Turn = {
        ...turn,
        nextEntryOrder: turn.nextEntryOrder + newEntries.length,
        version: turn.version + 1,
        updatedAt: now,
      };
      await tx.updateTurn(nextTurn, { expectedVersion: turn.version });
      return { turn: nextTurn, entries: newEntries };
    });
  }

  async appendAssistantMessage(input: {
    sessionId: string;
    turnId: string;
    message: Message;
    messageMetadata?: MetadataBag;
  }): Promise<{ turn: Turn; entry: TurnEntry }> {
    return await this.appendTurnEntry({
      sessionId: input.sessionId,
      turnId: input.turnId,
      kind: "assistant-message",
      visibility: "prompt",
      payload: messageEntryPayloadFor(input.message, input.messageMetadata),
    });
  }

  async appendToolResult(input: {
    sessionId: string;
    turnId: string;
    callId: string;
    tool: string;
    output?: string;
    error?: string;
    durationMs?: number;
    metadata?: MetadataBag;
  }): Promise<{ turn: Turn; entry: TurnEntry }> {
    const payload: ToolResultEntryPayload = {
      callId: input.callId,
      tool: input.tool,
      output: input.output,
      error: input.error,
      durationMs: input.durationMs,
      metadata: cloneValue(input.metadata),
    };
    return await this.appendTurnEntry({
      sessionId: input.sessionId,
      turnId: input.turnId,
      kind: "tool-result",
      visibility: "prompt",
      payload,
    });
  }

  async appendReasoning(input: {
    sessionId: string;
    turnId: string;
    text: string;
    metadata?: MetadataBag;
  }): Promise<{ turn: Turn; entry: TurnEntry }> {
    const payload: ReasoningEntryPayload = {
      text: input.text,
      metadata: cloneValue(input.metadata),
    };
    return await this.appendTurnEntry({
      sessionId: input.sessionId,
      turnId: input.turnId,
      kind: "reasoning",
      visibility: "ui",
      payload,
    });
  }

  async completeTurn(input: {
    sessionId: string;
    turnId: string;
    status?: Exclude<TurnStatus, "running">;
  }): Promise<{ turn: Turn }> {
    return await this.driver.transaction(async (tx) => {
      const session = await requireSession(tx, input.sessionId);
      const turn = await requireTurn(tx, input.turnId);
      assertTurnBelongsToSession(turn, input.sessionId);
      const now = Date.now();

      const completedTurn: Turn = {
        ...turn,
        status: input.status ?? "completed",
        version: turn.version + 1,
        updatedAt: now,
        completedAt: now,
      };
      await tx.updateTurn(completedTurn, { expectedVersion: turn.version });

      const resumeConfig = await deriveResumeTurnConfig(tx, turn.id);
      if (resumeConfig) {
        await tx.updateSession(
          {
            ...session,
            resumeTurnConfig: resumeConfig,
            version: session.version + 1,
            updatedAt: now,
          },
          { expectedVersion: session.version },
        );
      }

      return { turn: completedTurn };
    });
  }

  async updateSessionMetadata(
    sessionId: string,
    patch: Partial<
      Omit<Session, "id" | "currentHistorySnapshotId" | "nextTurnSeq" | "createdAt" | "version">
    >,
  ): Promise<Session> {
    return await this.driver.transaction(async (tx) => {
      const current = await requireSession(tx, sessionId);
      const next: Session = {
        ...current,
        ...patch,
        version: current.version + 1,
        updatedAt: Date.now(),
      };
      await tx.updateSession(next, { expectedVersion: current.version });
      return next;
    });
  }

  async writeCompactionHistorySnapshot(
    sessionId: string,
    messages: Message[],
    reason: SnapshotReason = "compaction",
  ): Promise<HistorySnapshot> {
    return await this.driver.transaction(async (tx) => {
      const session = await requireSession(tx, sessionId);
      const now = Date.now();
      const snapshot: HistorySnapshot = {
        id: generateId(),
        sessionId,
        throughTurnSeq: Math.max(0, session.nextTurnSeq - 1),
        messages: cloneValue(messages),
        reason,
        createdAt: now,
      };
      await tx.insertHistorySnapshot(snapshot);
      await tx.updateSession(
        {
          ...session,
          currentHistorySnapshotId: snapshot.id,
          version: session.version + 1,
          updatedAt: now,
        },
        { expectedVersion: session.version },
      );
      return snapshot;
    });
  }

  async branchSession(input: {
    childSession: SessionMetadata;
    parentSessionId: string;
    branchMessageId: string;
  }): Promise<{ child: Session; historySnapshot: HistorySnapshot }> {
    return await this.driver.transaction(async (tx) => {
      const parent = await requireSession(tx, input.parentSessionId);
      const parentHistory = await this.loadVisibleHistoryIn(tx, parent);
      const parentMessages = visibleHistoryToMessages(parentHistory);
      const branchIndex = parentMessages.findIndex(
        (message) => message.id === input.branchMessageId,
      );
      if (branchIndex === -1) {
        throw new Error(`Unknown branch point: ${input.branchMessageId}`);
      }

      const baseMessages = parentMessages.slice(0, branchIndex + 1);
      const now = Date.now();
      const child: Session = {
        ...sessionFromMetadata(input.childSession),
        parentSessionId: input.parentSessionId,
        branchedFromMessageId: input.branchMessageId,
        updatedAt: now,
      };
      const branchSnapshot: HistorySnapshot = {
        id: generateId(),
        sessionId: child.id,
        throughTurnSeq: 0,
        messages: cloneValue(baseMessages),
        reason: "branch-base",
        createdAt: now,
        sourceSessionId: parent.id,
        sourceMessageId: input.branchMessageId,
      };

      await tx.insertSession(child);
      await tx.insertHistorySnapshot(branchSnapshot);
      const childWithSnapshot: Session = {
        ...child,
        currentHistorySnapshotId: branchSnapshot.id,
        version: child.version + 1,
      };
      await tx.updateSession(childWithSnapshot, { expectedVersion: child.version });

      return {
        child: childWithSnapshot,
        historySnapshot: branchSnapshot,
      };
    });
  }

  private async loadVisibleHistoryIn(
    store: SessionStorageRead,
    session: Session,
  ): Promise<VisibleHistory> {
    const snapshot = session.currentHistorySnapshotId
      ? await store.getHistorySnapshot(session.currentHistorySnapshotId)
      : null;
    if (session.currentHistorySnapshotId && !snapshot) {
      throw new Error(`Missing history snapshot: ${session.currentHistorySnapshotId}`);
    }

    const trailingTurns = await store.listTurnsWithEntries(session.id, {
      afterSeq: snapshot?.throughTurnSeq ?? 0,
      visibility: "all",
    });

    return {
      session,
      historySnapshot: snapshot,
      trailingTurns,
    };
  }
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

async function requireSession(store: SessionStorageRead, sessionId: string): Promise<Session> {
  const session = await store.getSession(sessionId);
  if (!session) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  return session;
}

async function requireTurn(store: SessionStorageRead, turnId: string): Promise<Turn> {
  const turn = await store.getTurn(turnId);
  if (!turn) {
    throw new Error(`Unknown turn: ${turnId}`);
  }
  return turn;
}

function assertTurnBelongsToSession(turn: Turn, sessionId: string): void {
  if (turn.sessionId !== sessionId) {
    throw new Error(`Turn ${turn.id} does not belong to session ${sessionId}`);
  }
}

function sessionFromMetadata(metadata: SessionMetadata): Session {
  return {
    id: metadata.id,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    parentSessionId: metadata.parentSessionId,
    branchedFromMessageId: metadata.branchedFromMessageId,
    currentHistorySnapshotId: null,
    nextTurnSeq: 1,
    version: 1,
    resumeTurnConfig: {
      agent: metadata.agent,
      model: cloneValue(metadata.model),
    },
  };
}

function resumeTurnConfigFromMessage(message: Message): ResumeTurnConfig {
  return {
    agent: message.agent,
    model: cloneValue(message.model),
  };
}

function messageEntryPayloadFor(message: Message, metadata?: MetadataBag): MessageEntryPayload {
  return {
    message: cloneValue(message),
    metadata: cloneValue(metadata),
  };
}

async function deriveResumeTurnConfig(
  store: SessionStorageRead,
  turnId: string,
): Promise<ResumeTurnConfig | null> {
  const entries = await store.listTurnEntries(turnId, { visibility: "all" });
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.kind === "assistant-message") {
      const payload = entry.payload as MessageEntryPayload;
      return resumeTurnConfigFromMessage(payload.message);
    }
  }
  return null;
}

function entriesToPromptMessages(entries: TurnEntry[]): Message[] {
  const result: Message[] = [];
  for (const entry of entries) {
    if (entry.visibility !== "prompt") {
      continue;
    }
    const message = entryToPromptMessage(entry);
    if (message) {
      result.push(message);
    }
  }
  return result;
}

function entryToPromptMessage(entry: TurnEntry): Message | null {
  if (entry.kind === "user-message" || entry.kind === "assistant-message") {
    const payload = entry.payload as MessageEntryPayload;
    return cloneValue(payload.message);
  }
  if (entry.kind === "tool-result") {
    const payload = entry.payload as ToolResultEntryPayload;
    return toolResultToMessage(payload, entry);
  }
  return null;
}

function visibleHistoryToMessages(history: VisibleHistory): Message[] {
  const snapshotMessages = history.historySnapshot?.messages.map(cloneValue) ?? [];
  const trailingMessages = history.trailingTurns.flatMap((lt) =>
    entriesToPromptMessages(lt.entries),
  );
  return [...snapshotMessages, ...trailingMessages];
}

// TODO: exact shape depends on alignment with the runtime's LLM wire format
// conversion. Anthropic and OpenAI expect tool results as user-role messages
// with tool_result content blocks referencing the original tool_use id.
function toolResultToMessage(payload: ToolResultEntryPayload, entry: TurnEntry): Message {
  return {
    id: entry.id,
    role: "user",
    parts: [
      {
        type: "text",
        text: payload.error
          ? `[tool error: ${payload.tool}] ${payload.error}`
          : (payload.output ?? ""),
      },
    ],
    model: { provider: "", model: "" },
    agent: "",
  } satisfies UserMessage;
}
