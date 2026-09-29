// Task 3A: Better Auth instance on Drizzle/bun:sqlite.
// Adapter + dialect declared HERE (that's why @better-auth/cli generate needs
// no adapter/dialect flags). The user table is the Task 2 `users` table —
// alias singular `user` model key to the canonical `users` export (REQUIRED:
// drizzleAdapter looks up schema["user"], canonical export key is `users`).
import { Database } from "bun:sqlite";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createDb, schema } from "@hoborouter/db";

/** Build a Better Auth instance over an existing bun:sqlite Database. */
export function createAuth(db: Database) {
  return betterAuth({
    database: drizzleAdapter(drizzle(db, { schema }), {
      provider: "sqlite",
      schema: { ...schema, user: schema.users },
    }),
    user: { modelName: "users" },
    emailAndPassword: { enabled: true },
  });
}

// Default instance used by the app and by `@better-auth/cli generate`
// (override the target DB file with HBR_DB_PATH; defaults to in-memory).
const defaultDb = createDb(process.env.HBR_DB_PATH || ":memory:");
export const auth = createAuth(defaultDb);
