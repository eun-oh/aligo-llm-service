import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Context, Effect, Layer } from "effect";
import * as schema from "./schema";

export type DrizzleDbClient = ReturnType<typeof drizzle<typeof schema>>;

export class DrizzleDb extends Context.Tag("DrizzleDb")<
  DrizzleDb,
  { readonly client: DrizzleDbClient }
>() {}

export const DrizzleLiveLayer = Layer.scoped(
  DrizzleDb,
  Effect.gen(function* () {
    const sqlite = new Database("data/aligo-llm.db");

    sqlite.exec("PRAGMA journal_mode = WAL");
    sqlite.exec("PRAGMA busy_timeout = 5000");
    sqlite.exec("PRAGMA synchronous = NORMAL");
    sqlite.exec("PRAGMA foreign_keys = ON");

    const schemaFile = Bun.file("src/db/schema.sql");
    const schemaSql = yield* Effect.tryPromise({
      try: () => schemaFile.text(),
      catch: () => new Error("Failed to read schema.sql"),
    });
    sqlite.exec(schemaSql);

    const client = drizzle(sqlite, { schema });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        sqlite.close();
      }),
    );

    return { client };
  }),
);
