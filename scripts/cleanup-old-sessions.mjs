import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const args = new Set(process.argv.slice(2));
const valueArg = (name, fallback) => {
  const found = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : fallback;
};

const keep = Math.max(1, Number(valueArg("--keep", "10")));
const apply = args.has("--apply");
const dbPath = path.resolve("apps/server/storage/campaign.sqlite");
const backupDir = path.resolve("apps/server/storage/backups");
const backupPath = path.join(backupDir, `campaign-before-session-cleanup-${Date.now()}.sqlite`);

const db = new DatabaseSync(dbPath);
const roomsToDelete = db
  .prepare(
    `SELECT id, code, name, status, created_at, updated_at
     FROM rooms
     WHERE id NOT IN (
       SELECT id FROM rooms ORDER BY updated_at DESC LIMIT ?
     )
     ORDER BY updated_at ASC`,
  )
  .all(keep);

console.log(`Database: ${dbPath}`);
console.log(`Keeping the ${keep} most recently updated rooms.`);
console.log(`${roomsToDelete.length} rooms would be removed.`);
console.table(roomsToDelete.map(({ id, code, name, updated_at }) => ({ id, code, name, updated_at })));

if (!apply) {
  console.log("Dry run only. Re-run with --apply to delete after reviewing the table above.");
  process.exit(0);
}

mkdirSync(backupDir, { recursive: true });
copyFileSync(dbPath, backupPath);
console.log(`Backup created: ${backupPath}`);

const deleteRoom = db.transaction((roomId) => {
  db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
});

for (const room of roomsToDelete) {
  deleteRoom(room.id);
}

console.log(`Deleted ${roomsToDelete.length} old rooms. Related messages and image jobs were removed by SQLite cascade.`);
