// Better Auth-generated tables (via @better-auth/cli + drizzle-kit, user table
// named `users`). schema.ts re-exports these bindings for FK builders.
import { relations } from "drizzle-orm";
import { boolean, customType, index, pgTable, text } from "drizzle-orm/pg-core";

// Better Auth passes/expects Date objects for its timestamp fields while the
// canonical storage contract is epoch-ms bigint. This type bridges both:
// driver storage is bigint epoch-ms, drizzle-level data is Date.
const tsMs = () =>
  customType<{ data: Date; driverData: number; notNull: false; default: false }>({
    dataType() {
      return "bigint";
    },
    toDriver(value: Date) {
      return value.getTime();
    },
    fromDriver(value: number) {
      return new Date(Number(value));
    },
  });

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  // Epoch-ms timestamps, consistent with the rest of the schema.
  createdAt: tsMs()("created_at").notNull(),
  updatedAt: tsMs()("updated_at")
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: tsMs()("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: tsMs()("created_at").notNull(),
    updatedAt: tsMs()("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: tsMs()("access_token_expires_at"),
    refreshTokenExpiresAt: tsMs()("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: tsMs()("created_at").notNull(),
    updatedAt: tsMs()("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: tsMs()("expires_at").notNull(),
    createdAt: tsMs()("created_at").notNull(),
    updatedAt: tsMs()("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  users: one(users, {
    fields: [session.userId],
    references: [users.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  users: one(users, {
    fields: [account.userId],
    references: [users.id],
  }),
}));
