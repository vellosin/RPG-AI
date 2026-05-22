import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const dbPath = path.resolve("apps/server/storage/campaign.sqlite");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = Math.max(1, Math.min(200, Number(limitArg?.split("=")[1] ?? 30)));

const db = new DatabaseSync(dbPath, { readOnly: true });
const counts = {
  rooms: db.prepare("SELECT count(*) AS n FROM rooms").get().n,
  messages: db.prepare("SELECT count(*) AS n FROM messages").get().n,
  imageJobs: db.prepare("SELECT count(*) AS n FROM image_jobs").get().n,
  llmCalls: db.prepare("SELECT count(*) AS n FROM llm_calls").get().n,
};

console.log(`Database: ${dbPath}`);
console.log(JSON.stringify(counts, null, 2));
console.table(
  db.prepare(
    `SELECT id, code, name, status, created_at, updated_at
     FROM rooms
     ORDER BY updated_at DESC
     LIMIT ?`,
  ).all(limit),
);
