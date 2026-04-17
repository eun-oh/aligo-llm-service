import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const deliveries = sqliteTable(
  "deliveries",
  {
    deliveryId: text("delivery_id").primaryKey(),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    commitSha: text("commit_sha").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
  },
  (table) => [index("idx_deliveries_pr").on(table.repo, table.prNumber, table.status)],
);

export const reviews = sqliteTable("reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  deliveryId: text("delivery_id")
    .notNull()
    .references(() => deliveries.deliveryId),
  prUrl: text("pr_url").notNull(),
  brief: text("brief").notNull(),
  rawLlmOutput: text("raw_llm_output").notNull(),
  promptUsed: text("prompt_used").notNull(),
  modelName: text("model_name").notNull(),
  durationMs: integer("duration_ms"),
  createdAt: text("created_at").notNull().default("(datetime('now'))"),
});

export type DeliveryRow = typeof deliveries.$inferSelect;
export type NewDeliveryRow = typeof deliveries.$inferInsert;
export type ReviewRow = typeof reviews.$inferSelect;
export type NewReviewRow = typeof reviews.$inferInsert;
