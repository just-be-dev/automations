/** Adapts Durable Object SQLite to pi-durable storage with pi-prefixed tables, without importing the native SDK. */
import {
  SQLITE_MIGRATIONS,
  SqliteStorage,
  type SqliteDatabase,
  type SqliteExecutor,
  type SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";

/**
 * pi-durable's SQLite storage over a Durable Object's SQL API, with pi's tables moved under `pi_`.
 *
 * Adapted from `openPiSessionStore` in `agents/harness/pi` (MIT). That module also loads the Agents
 * SDK lifecycle, which imports `cloudflare:workers` and so cannot load while Alchemy plans the
 * stack. Keep the table prefix compatible with it.
 */
export const openPiStorage = (storage: DurableObjectStorage) =>
  SqliteStorage.open(new DurableObjectSqliteDatabase(storage));

const PREFIX = "pi_";

const schemaNames = () => {
  const pattern =
    /\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  const names = new Set(["durable_schema"]);
  SQLITE_MIGRATIONS.forEach((migration) =>
    migration.statements.forEach((statement) =>
      Array.from(statement.matchAll(pattern)).forEach((match) => {
        if (match[1] !== undefined) {
          names.add(match[1]);
        }
      }),
    ),
  );
  return [...names];
};

/** Rewrites pi's table and index names outside string literals. */
const makePrefixer = () => {
  const pattern = new RegExp(`\\b(${schemaNames().join("|")})\\b`, "g");
  const cache = new Map<string, string>();
  return (sql: string) => {
    const cached = cache.get(sql);
    if (cached !== undefined) {
      return cached;
    }
    const rewritten = sql
      .split(/('(?:[^']|'')*')/)
      .map((part, index) => (index % 2 === 1 ? part : part.replace(pattern, `${PREFIX}$1`)))
      .join("");
    cache.set(sql, rewritten);
    return rewritten;
  };
};

/** Durable Objects bind strings, numbers, null, and ArrayBuffers. */
const toBinding = (value: SqliteValue) => {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError(`SQLite integer ${value} is outside the safe range`);
    }
    return Number(value);
  }
  if (value instanceof Uint8Array) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  return value;
};

/** Blobs come back as ArrayBuffers; pi reads Uint8Arrays. */
const fromRow = <T extends object>(raw: Record<string, SqlStorageValue>) =>
  Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key,
      value instanceof ArrayBuffer ? new Uint8Array(value) : value,
    ]),
  ) as T;

class Statements {
  constructor(
    private readonly sql: SqlStorage,
    private readonly rewrite: (sql: string) => string,
  ) {}

  exec(sql: string) {
    this.sql.exec(this.rewrite(sql));
  }

  run(sql: string, params: ReadonlyArray<SqliteValue>) {
    this.sql.exec(this.rewrite(sql), ...params.map(toBinding));
  }

  get<T extends object>(sql: string, params: ReadonlyArray<SqliteValue>) {
    const first = this.sql.exec(this.rewrite(sql), ...params.map(toBinding)).next();
    return first.done === true ? undefined : fromRow<T>(first.value);
  }

  all<T extends object>(sql: string, params: ReadonlyArray<SqliteValue>) {
    return this.sql
      .exec(this.rewrite(sql), ...params.map(toBinding))
      .toArray()
      .map((raw) => fromRow<T>(raw));
  }
}

/**
 * Orders calls on the one SQL connection. DO SQL is synchronous but pi's facade is async and its
 * transaction callbacks await between statements, so every other call waits until an open
 * transaction settles instead of running inside it.
 */
class OperationQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  run<T>(statement: () => T): Promise<T> {
    if (this.pending > 0) {
      return this.hold(async () => statement());
    }
    try {
      return Promise.resolve(statement());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  hold<T>(call: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const settled = this.tail.then(call).finally(() => {
      this.pending -= 1;
    });
    this.tail = settled.then(
      () => undefined,
      () => undefined,
    );
    return settled;
  }
}

class DurableObjectSqliteTransaction implements SqliteExecutor {
  private active = true;

  constructor(private readonly statements: Statements) {}

  end() {
    this.active = false;
  }

  private assertActive() {
    if (!this.active) {
      throw new Error("The pi SQLite transaction is no longer active");
    }
  }

  async exec(sql: string) {
    this.assertActive();
    this.statements.exec(sql);
  }

  async run(sql: string, ...params: SqliteValue[]) {
    this.assertActive();
    this.statements.run(sql, params);
  }

  async get<T extends object>(sql: string, ...params: SqliteValue[]) {
    this.assertActive();
    return this.statements.get<T>(sql, params);
  }

  async all<T extends object>(sql: string, ...params: SqliteValue[]) {
    this.assertActive();
    return this.statements.all<T>(sql, params);
  }
}

class DurableObjectSqliteDatabase implements SqliteDatabase {
  private readonly statements: Statements;
  private readonly queue = new OperationQueue();

  constructor(private readonly storage: DurableObjectStorage) {
    this.statements = new Statements(storage.sql, makePrefixer());
  }

  exec(sql: string) {
    return this.queue.run(() => this.statements.exec(sql));
  }

  run(sql: string, ...params: SqliteValue[]) {
    return this.queue.run(() => this.statements.run(sql, params));
  }

  get<T extends object>(sql: string, ...params: SqliteValue[]) {
    return this.queue.run(() => this.statements.get<T>(sql, params));
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]) {
    return this.queue.run(() => this.statements.all<T>(sql, params));
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>) {
    return this.queue.hold(() =>
      this.storage.transaction(async () => {
        const transaction = new DurableObjectSqliteTransaction(this.statements);
        try {
          return await callback(transaction);
        } finally {
          transaction.end();
        }
      }),
    );
  }

  /** The object owns the database; there is nothing to close. */
  close() {
    return this.queue.run(() => undefined);
  }
}
