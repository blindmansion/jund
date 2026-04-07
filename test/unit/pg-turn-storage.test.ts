import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import pg from "pg";
import { SessionPersistenceAdapter } from "../../src/storage/index.ts";
import { PgStorage } from "../../src/storage/pg.ts";

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 30_000, stdio: "pipe" }).trim();
  } catch {
    return null;
  }
}

let connectionUrl: string | null = null;
let containerId: string | null = null;

if (process.env.PG_TEST_URL) {
  connectionUrl = process.env.PG_TEST_URL;
} else {
  const id = tryExec(
    "docker run --rm -d -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test_jund -e POSTGRES_USER=test -p 0:5432 postgres:17-alpine",
  );
  if (id) {
    containerId = id;
    const port = tryExec(
      `docker inspect --format='{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' ${id}`,
    );
    if (port) {
      connectionUrl = `postgres://test:test@localhost:${port.replace(/'/g, "")}/test_jund`;
    } else {
      tryExec(`docker stop ${id}`);
      containerId = null;
    }
  }
}

const canRun = connectionUrl !== null;
if (!canRun) {
  console.warn("  [pg-turn-storage] No PG_TEST_URL and Docker unavailable — skipping tests");
}

let pool: pg.Pool | null = null;

async function waitForReady(url: string, maxMs = 20_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

describe.skipIf(!canRun)("PgStorage", () => {
  beforeAll(async () => {
    if (!connectionUrl) {
      return;
    }
    const ready = await waitForReady(connectionUrl);
    if (!ready) {
      throw new Error("Postgres did not become ready in time");
    }
    pool = new pg.Pool({ connectionString: connectionUrl });
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
      pool = null;
    }
    if (containerId) {
      tryExec(`docker stop ${containerId}`);
      containerId = null;
    }
  });

  test("creates schema and persists a session through SessionPersistenceAdapter", async () => {
    if (!pool) {
      throw new Error("pool not initialized");
    }
    const driver = await PgStorage.create(pool);
    const storage = new SessionPersistenceAdapter(driver);
    const now = Date.now();
    const session = await storage.createSession({
      id: "pg-test-session-1",
      workdir: "/tmp/pg-test",
      createdAt: now,
      updatedAt: now,
      agent: "test-agent",
      model: { provider: "test", model: "mock" },
    });
    expect(session.id).toBe("pg-test-session-1");

    const loaded = await storage.loadSession("pg-test-session-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.workdir).toBe("/tmp/pg-test");
    expect(loaded!.resumeTurnConfig.agent).toBe("test-agent");
  });
});
