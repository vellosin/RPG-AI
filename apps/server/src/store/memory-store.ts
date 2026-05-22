import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { customAlphabet, nanoid } from "nanoid";
import { defaultCampaignMemory } from "../game/campaign-memory.js";
import { buildOpeningScene, calculateArmorClass, defaultRoomSetup, experienceThresholdsByLevel, nextLevelExperience } from "../game/dnd5e.js";
import { normalizePlayerResources } from "../game/player-resources.js";
import { normalizePlayerLore } from "../game/player-lore.js";
import type { CampaignMemoryState, ChatMessage, CombatState, EnemyState, ImageJob, Player, RoomSetup, RoomState, SceneState, SessionStatus } from "../game/types.js";

const roomCodeAlphabet = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);
const require = createRequire(import.meta.url);

type SqlStatement = {
  all: (...params: unknown[]) => unknown[];
  get?: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => unknown;
};

type SqlDatabase = {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => SqlStatement;
  transaction: <Args extends unknown[], Result>(work: (...args: Args) => Result) => (...args: Args) => Result;
};

class NodeSqliteDatabase implements SqlDatabase {
  private readonly db: {
    exec: (sql: string) => unknown;
    prepare: (sql: string) => SqlStatement;
  };

  constructor(databasePath: string) {
    const sqlite = require("node:sqlite") as { DatabaseSync: new (path: string) => NodeSqliteDatabase["db"] };
    this.db = new sqlite.DatabaseSync(databasePath);
  }

  exec(sql: string): unknown {
    return this.db.exec(sql);
  }

  prepare(sql: string): SqlStatement {
    return this.db.prepare(sql);
  }

  transaction<Args extends unknown[], Result>(work: (...args: Args) => Result): (...args: Args) => Result {
    return (...args: Args) => {
      this.db.exec("BEGIN");
      try {
        const result = work(...args);
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    };
  }
}

const openSqliteDatabase = (databasePath: string): SqlDatabase => {
  try {
    return new NodeSqliteDatabase(databasePath);
  } catch {
    const BetterSqlite = require("better-sqlite3") as new (path: string) => SqlDatabase & { pragma?: (sql: string) => unknown };
    const db = new BetterSqlite(databasePath);
    return db;
  }
};

const defaultScene = (): SceneState => ({
  title: "Session Not Started",
  summary: "Configure the session, create characters, and mark all players as ready.",
  activeQuest: "Awaiting the host to begin the adventure.",
  combatRound: undefined,
});

const defaultCombatState = (): CombatState => ({
  active: false,
  round: 0,
  currentTurnIndex: 0,
  order: [],
  enemies: [],
  log: [],
  lastOutcome: undefined,
});

export type LlmCallRecord = {
  id: string;
  roomId: string | null;
  model: string;
  label: string;
  promptChars: number;
  completionChars: number;
  latencyMs: number;
  ok: boolean;
  mode: "live" | "fallback";
  error?: string;
  createdAt: string;
};

/**
 * MemoryStore is now a thin in-memory cache fronting a SQLite database with WAL mode.
 *
 * Why hybrid:
 * - In-memory Map keeps hot reads (every snapshot broadcast) instantaneous.
 * - SQLite is the durable source of truth and survives crashes mid-write.
 * - Messages, image_jobs, and llm_calls live in real tables so they can grow
 *   indefinitely without rewriting a 200KB+ JSON blob on every action.
 *
 * The class API is preserved verbatim from the previous JSON-backed implementation,
 * so consumers (engine.ts, routes/rooms.ts) need no changes.
 */
export class MemoryStore {
  private readonly rooms = new Map<string, RoomState>();
  private readonly db: SqlDatabase;

  constructor(legacyJsonPath: string, databasePath?: string) {
    const resolvedDbPath = databasePath ?? path.join(path.dirname(legacyJsonPath), "campaign.sqlite");
    mkdirSync(path.dirname(resolvedDbPath), { recursive: true });

    this.db = openSqliteDatabase(resolvedDbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");

    this.initSchema();
    this.loadFromDb();
    this.maybeImportLegacyJson(legacyJsonPath);
  }

  // ── Schema ───────────────────────────────────────────────────────────────
  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        setup_json TEXT NOT NULL,
        players_json TEXT NOT NULL,
        scene_json TEXT NOT NULL,
        combat_json TEXT NOT NULL,
        memory_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        author_name TEXT NOT NULL,
        content TEXT NOT NULL,
        raw_content TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);

      CREATE TABLE IF NOT EXISTS image_jobs (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        status TEXT NOT NULL,
        profile TEXT NOT NULL,
        prompt TEXT NOT NULL,
        subject_name TEXT,
        negative_prompt TEXT,
        seed INTEGER,
        asset_url TEXT,
        message_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_room_status ON image_jobs(room_id, status);

      CREATE TABLE IF NOT EXISTS llm_calls (
        id TEXT PRIMARY KEY,
        room_id TEXT,
        model TEXT NOT NULL,
        label TEXT NOT NULL,
        prompt_chars INTEGER NOT NULL,
        completion_chars INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        mode TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_llm_calls_recent ON llm_calls(created_at DESC);
    `);
  }

  // ── Bootstrapping ────────────────────────────────────────────────────────
  private loadFromDb(): void {
    const roomRows = this.db.prepare(`SELECT * FROM rooms`).all() as Array<{
      id: string; code: string; name: string; status: string;
      setup_json: string; players_json: string; scene_json: string;
      combat_json: string; memory_json: string;
    }>;

    const messagesByRoom = new Map<string, ChatMessage[]>();
    const messageRows = this.db.prepare(`SELECT * FROM messages ORDER BY created_at ASC`).all() as Array<{
      id: string; room_id: string; role: string; kind: string;
      author_name: string; content: string; raw_content: string | null; created_at: string;
    }>;
    for (const row of messageRows) {
      const list = messagesByRoom.get(row.room_id) ?? [];
      list.push({
        id: row.id,
        roomId: row.room_id,
        role: row.role as ChatMessage["role"],
        kind: row.kind as ChatMessage["kind"],
        authorName: row.author_name,
        content: row.content,
        rawContent: row.raw_content ?? undefined,
        createdAt: row.created_at,
      });
      messagesByRoom.set(row.room_id, list);
    }

    const jobsByRoom = new Map<string, ImageJob[]>();
    const jobRows = this.db.prepare(`SELECT * FROM image_jobs ORDER BY created_at ASC`).all() as Array<{
      id: string; room_id: string; status: string; profile: string;
      prompt: string; subject_name: string | null; negative_prompt: string | null;
      seed: number | null; asset_url: string | null; message_id: string | null;
    }>;
    for (const row of jobRows) {
      const list = jobsByRoom.get(row.room_id) ?? [];
      list.push({
        id: row.id,
        roomId: row.room_id,
        status: row.status as ImageJob["status"],
        profile: row.profile as ImageJob["profile"],
        prompt: row.prompt,
        subjectName: row.subject_name ?? undefined,
        negativePrompt: row.negative_prompt ?? undefined,
        seed: row.seed ?? undefined,
        assetUrl: row.asset_url ?? undefined,
        messageId: row.message_id ?? undefined,
      });
      jobsByRoom.set(row.room_id, list);
    }

    for (const row of roomRows) {
      const room: RoomState = {
        id: row.id,
        code: row.code,
        name: row.name,
        status: this.normalizeStatus(row.status as SessionStatus),
        setup: JSON.parse(row.setup_json),
        players: JSON.parse(row.players_json),
        messages: messagesByRoom.get(row.id) ?? [],
        scene: JSON.parse(row.scene_json),
        combat: this.normalizeCombat(JSON.parse(row.combat_json)),
        imageJobs: jobsByRoom.get(row.id) ?? [],
        memory: JSON.parse(row.memory_json),
      };
      this.rooms.set(room.id, this.normalizeRoom(room));
    }
  }

  private maybeImportLegacyJson(legacyJsonPath: string): void {
    if (this.rooms.size > 0) return;
    if (!existsSync(legacyJsonPath)) return;

    try {
      const raw = readFileSync(legacyJsonPath, "utf-8");
      const rooms = JSON.parse(raw) as RoomState[];
      if (!Array.isArray(rooms) || rooms.length === 0) return;

      const importTx = this.db.transaction((entries: RoomState[]) => {
        for (const entry of entries) {
          const normalized = this.normalizeRoom(entry);
          this.rooms.set(normalized.id, normalized);
          this.upsertRoomCore(normalized);
          for (const message of normalized.messages) {
            this.insertMessageRow(message);
          }
          for (const job of normalized.imageJobs) {
            this.insertImageJobRow(job);
          }
        }
      });

      importTx(rooms);

      // Move the legacy file aside so it can be inspected but not re-imported.
      const archivedPath = `${legacyJsonPath}.imported-${Date.now()}.bak`;
      try {
        renameSync(legacyJsonPath, archivedPath);
      } catch {
        // best-effort; if rename fails, the next boot will see rooms in DB and skip import anyway
      }
      console.log(`[store] Imported ${rooms.length} room(s) from legacy rooms.json — archived at ${archivedPath}`);
    } catch (error) {
      console.warn("[store] Failed to import legacy rooms.json:", error);
    }
  }

  // ── Public API (preserves the original MemoryStore signature) ────────────
  createRoom(name: string, setup: RoomSetup): RoomState {
    const openingScene = buildOpeningScene(setup);
    const room: RoomState = {
      id: nanoid(),
      code: roomCodeAlphabet(),
      name,
      status: "lobby",
      setup,
      players: [],
      messages: [],
      scene: {
        title: openingScene.title,
        summary: "Configure the session, create characters, and wait for all players to be ready.",
        activeQuest: openingScene.quest || undefined,
        combatRound: undefined,
      },
      combat: defaultCombatState(),
      imageJobs: [],
      memory: defaultCampaignMemory(),
    };

    this.rooms.set(room.id, room);
    this.upsertRoomCore(room);
    return room;
  }

  listRooms(): RoomState[] {
    return [...this.rooms.values()];
  }

  getRoom(roomId: string): RoomState | undefined {
    return this.rooms.get(roomId);
  }

  deleteRoom(roomId: string): boolean {
    const existed = this.rooms.delete(roomId);
    this.db.prepare(`DELETE FROM rooms WHERE id = ?`).run(roomId);
    return existed;
  }

  updateRoom(roomId: string, updater: (room: RoomState) => RoomState): RoomState {
    const room = this.requireRoom(roomId);
    const updated = updater(room);
    this.rooms.set(roomId, updated);
    this.upsertRoomCore(updated);
    return updated;
  }

  joinRoom(roomId: string, player: Omit<Player, "id">): Player {
    const room = this.requireRoom(roomId);
    const createdPlayer: Player = { ...player, id: nanoid() };
    room.players.push(createdPlayer);
    if (!room.setup.hostPlayerId) {
      room.setup.hostPlayerId = createdPlayer.id;
    }
    this.persistRoomMeta(room);
    return createdPlayer;
  }

  updatePlayers(roomId: string, updater: (players: Player[]) => Player[]): Player[] {
    const room = this.requireRoom(roomId);
    room.players = updater(room.players);
    this.persistRoomMeta(room);
    return room.players;
  }

  updatePlayer(roomId: string, playerId: string, updater: (player: Player) => Player): Player {
    const room = this.requireRoom(roomId);
    const playerIndex = room.players.findIndex((player) => player.id === playerId);
    if (playerIndex === -1) {
      throw new Error(`Player ${playerId} was not found`);
    }
    room.players[playerIndex] = updater(room.players[playerIndex]);
    this.persistRoomMeta(room);
    return room.players[playerIndex];
  }

  addMessage(roomId: string, message: Omit<ChatMessage, "id" | "createdAt" | "roomId">): ChatMessage {
    const room = this.requireRoom(roomId);
    const createdMessage: ChatMessage = {
      id: nanoid(),
      roomId,
      createdAt: new Date().toISOString(),
      ...message,
    };
    room.messages.push(createdMessage);
    this.insertMessageRow(createdMessage);
    return createdMessage;
  }

  /**
   * Removes a message from in-memory state and from the messages table.
   * Used by the GM regenerate flow to take back the last GM response.
   */
  deleteMessage(roomId: string, messageId: string): boolean {
    const room = this.requireRoom(roomId);
    const before = room.messages.length;
    room.messages = room.messages.filter((entry) => entry.id !== messageId);
    if (room.messages.length === before) return false;
    this.db.prepare(`DELETE FROM messages WHERE id = ? AND room_id = ?`).run(messageId, roomId);
    return true;
  }

  updateScene(roomId: string, scene: Partial<SceneState>): SceneState {
    const room = this.requireRoom(roomId);
    room.scene = { ...room.scene, ...scene };
    this.persistRoomMeta(room);
    return room.scene;
  }

  updateStatus(roomId: string, status: SessionStatus): SessionStatus {
    const room = this.requireRoom(roomId);
    room.status = status;
    this.persistRoomMeta(room);
    return room.status;
  }

  updateSetup(roomId: string, setup: Partial<RoomSetup>): RoomSetup {
    const room = this.requireRoom(roomId);
    room.setup = { ...room.setup, ...setup };
    this.persistRoomMeta(room);
    return room.setup;
  }

  updateCombat(roomId: string, combat: Partial<CombatState>): CombatState {
    const room = this.requireRoom(roomId);
    room.combat = this.normalizeCombat({ ...room.combat, ...combat });
    this.persistRoomMeta(room);
    return room.combat;
  }

  updateMemory(roomId: string, updater: (memory: CampaignMemoryState) => CampaignMemoryState): CampaignMemoryState {
    const room = this.requireRoom(roomId);
    room.memory = updater(room.memory);
    this.persistRoomMeta(room);
    return room.memory;
  }

  addImageJobs(roomId: string, jobs: Array<Omit<ImageJob, "id" | "roomId" | "status">>): ImageJob[] {
    const room = this.requireRoom(roomId);
    const created = jobs.map((job) => ({
      id: nanoid(),
      roomId,
      status: "queued" as const,
      ...job,
    }));
    room.imageJobs.push(...created);
    const insertMany = this.db.transaction((rows: ImageJob[]) => {
      for (const job of rows) this.insertImageJobRow(job);
    });
    insertMany(created);
    return created;
  }

  completeImageJob(roomId: string, jobId: string, assetUrl: string): ImageJob | undefined {
    const room = this.requireRoom(roomId);
    const job = room.imageJobs.find((entry) => entry.id === jobId);
    if (!job) {
      return undefined;
    }

    job.status = "done";
    job.assetUrl = assetUrl;

    this.db.prepare(`UPDATE image_jobs SET status = ?, asset_url = ? WHERE id = ?`).run("done", assetUrl, jobId);
    return job;
  }

  // ── LLM observability ───────────────────────────────────────────────────
  recordLlmCall(record: Omit<LlmCallRecord, "id" | "createdAt"> & { id?: string; createdAt?: string }): void {
    const id = record.id ?? nanoid();
    const createdAt = record.createdAt ?? new Date().toISOString();
    this.db.prepare(`
      INSERT INTO llm_calls
        (id, room_id, model, label, prompt_chars, completion_chars, latency_ms, ok, mode, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      record.roomId ?? null,
      record.model,
      record.label,
      record.promptChars,
      record.completionChars,
      record.latencyMs,
      record.ok ? 1 : 0,
      record.mode,
      record.error ?? null,
      createdAt,
    );
  }

  recentLlmCalls(limit = 50): LlmCallRecord[] {
    const rows = this.db.prepare(`
      SELECT id, room_id, model, label, prompt_chars, completion_chars, latency_ms, ok, mode, error, created_at
      FROM llm_calls ORDER BY created_at DESC LIMIT ?
    `).all(limit) as Array<{
      id: string; room_id: string | null; model: string; label: string;
      prompt_chars: number; completion_chars: number; latency_ms: number;
      ok: number; mode: string; error: string | null; created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      roomId: row.room_id,
      model: row.model,
      label: row.label,
      promptChars: row.prompt_chars,
      completionChars: row.completion_chars,
      latencyMs: row.latency_ms,
      ok: row.ok === 1,
      mode: row.mode as "live" | "fallback",
      error: row.error ?? undefined,
      createdAt: row.created_at,
    }));
  }

  llmCallStats(): { byLabel: Record<string, { count: number; avgLatency: number; failureRate: number; fallbackRate: number }> } {
    const rows = this.db.prepare(`
      SELECT label,
             COUNT(*) AS count,
             AVG(latency_ms) AS avg_latency,
             SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS failure_rate,
             SUM(CASE WHEN mode = 'fallback' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS fallback_rate
      FROM llm_calls GROUP BY label
    `).all() as Array<{ label: string; count: number; avg_latency: number; failure_rate: number; fallback_rate: number }>;

    const result: Record<string, { count: number; avgLatency: number; failureRate: number; fallbackRate: number }> = {};
    for (const row of rows) {
      result[row.label] = {
        count: row.count,
        avgLatency: Math.round(row.avg_latency ?? 0),
        failureRate: Number((row.failure_rate ?? 0).toFixed(3)),
        fallbackRate: Number((row.fallback_rate ?? 0).toFixed(3)),
      };
    }
    return { byLabel: result };
  }

  // ── Internal helpers ────────────────────────────────────────────────────
  private upsertRoomCore(room: RoomState): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO rooms (id, code, name, status, setup_json, players_json, scene_json, combat_json, memory_json, created_at, updated_at)
      VALUES (@id, @code, @name, @status, @setup, @players, @scene, @combat, @memory, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        code = excluded.code,
        name = excluded.name,
        status = excluded.status,
        setup_json = excluded.setup_json,
        players_json = excluded.players_json,
        scene_json = excluded.scene_json,
        combat_json = excluded.combat_json,
        memory_json = excluded.memory_json,
        updated_at = excluded.updated_at
    `).run({
      id: room.id,
      code: room.code,
      name: room.name,
      status: room.status,
      setup: JSON.stringify(room.setup),
      players: JSON.stringify(room.players),
      scene: JSON.stringify(room.scene),
      combat: JSON.stringify(room.combat),
      memory: JSON.stringify(room.memory),
      createdAt: now,
      updatedAt: now,
    });
  }

  private persistRoomMeta(room: RoomState): void {
    this.db.prepare(`
      UPDATE rooms SET
        code = ?, name = ?, status = ?,
        setup_json = ?, players_json = ?, scene_json = ?, combat_json = ?, memory_json = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      room.code,
      room.name,
      room.status,
      JSON.stringify(room.setup),
      JSON.stringify(room.players),
      JSON.stringify(room.scene),
      JSON.stringify(room.combat),
      JSON.stringify(room.memory),
      new Date().toISOString(),
      room.id,
    );
  }

  private insertMessageRow(message: ChatMessage): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO messages (id, room_id, role, kind, author_name, content, raw_content, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.roomId,
      message.role,
      message.kind,
      message.authorName,
      message.content,
      message.rawContent ?? null,
      message.createdAt,
    );
  }

  private insertImageJobRow(job: ImageJob): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO image_jobs
        (id, room_id, status, profile, prompt, subject_name, negative_prompt, seed, asset_url, message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id,
      job.roomId,
      job.status,
      job.profile,
      job.prompt,
      job.subjectName ?? null,
      job.negativePrompt ?? null,
      job.seed ?? null,
      job.assetUrl ?? null,
      job.messageId ?? null,
      new Date().toISOString(),
    );
  }

  private normalizeStatus(status: SessionStatus | undefined): SessionStatus {
    // "preparing" is transient — if we crashed mid-prep the session is unrecoverable.
    return status === "preparing" ? "lobby" : (status ?? "lobby");
  }

  private normalizeCombat(combat: Partial<CombatState> & { enemy?: EnemyState | null | unknown }): CombatState {
    // Backwards compat: legacy schema had combat.enemy (single enemy). Promote it to enemies[].
    const rawEnemies = Array.isArray(combat.enemies)
      ? combat.enemies
      : (this.isEnemyState(combat.enemy) ? [combat.enemy] : []);
    const enemies = rawEnemies.map((enemy) => ({
      ...enemy,
      xpValue: enemy.xpValue ?? Math.max(10, enemy.threat * 25),
      armorClass: enemy.armorClass ?? 11 + enemy.threat,
    }));
    return {
      active: combat.active ?? false,
      round: combat.round ?? 0,
      currentTurnIndex: combat.currentTurnIndex ?? 0,
      order: combat.order ?? [],
      enemies,
      log: combat.log ?? [],
      lastOutcome: combat.lastOutcome,
    };
  }

  private isEnemyState(value: unknown): value is EnemyState {
    if (!value || typeof value !== "object") return false;
    const enemy = value as Partial<EnemyState>;
    return (
      typeof enemy.id === "string" &&
      typeof enemy.name === "string" &&
      typeof enemy.hitPoints === "number" &&
      typeof enemy.maxHitPoints === "number" &&
      typeof enemy.threat === "number" &&
      typeof enemy.description === "string"
    );
  }

  private normalizeRoom(room: RoomState & { combat?: CombatState & { enemy?: unknown } }): RoomState {
    const setup = room.setup ?? defaultRoomSetup();
    const openingScene = buildOpeningScene(setup);
    const normalizedMemory = room.memory ?? defaultCampaignMemory();
    return {
      ...room,
      status: this.normalizeStatus(room.status),
      setup,
      players: room.players.map((player) => {
        const inventory = player.inventory ?? { equipped: [], backpack: [], gold: 0 };
        const attributes = player.attributes ?? {};
        return normalizePlayerLore({
        ...player,
        controller: player.controller ?? "human",
        appearanceDescription: player.appearanceDescription ?? `${player.characterName} is a fantasy adventurer with practical equipment and a distinctive silhouette.`,
        physicalDescription: player.physicalDescription ?? player.appearanceDescription ?? `${player.characterName} has a distinctive fantasy adventurer silhouette.`,
        weaponDescription: player.weaponDescription ?? player.inventory?.equipped?.[0] ?? "signature adventuring weapon",
        outfitDescription: player.outfitDescription ?? player.inventory?.equipped?.slice(1).join(", ") ?? "practical fantasy travel clothing",
        className: player.className ?? "Fighter",
        species: player.species ?? "Human",
        background: player.background ?? "Soldier",
        origin: player.origin ?? "",
        motivation: player.motivation ?? "",
        turningPoint: player.turningPoint ?? "",
        connections: player.connections ?? "",
        backstory: player.backstory ?? "",
        level: player.level ?? setup.startingLevel,
        classLevels: player.classLevels ?? { [player.className ?? "Fighter"]: player.level ?? setup.startingLevel },
        experiencePoints: player.experiencePoints ?? experienceThresholdsByLevel[player.level ?? setup.startingLevel] ?? 0,
        nextLevelExperience: player.nextLevelExperience ?? nextLevelExperience(player.level ?? setup.startingLevel),
        pendingLevelUps: player.pendingLevelUps ?? 0,
        maxHitPoints: player.maxHitPoints ?? player.hitPoints,
        armorClass: calculateArmorClass(attributes, inventory),
        proficiencyBonus: player.proficiencyBonus ?? 2,
        ready: player.ready ?? false,
        notes: player.notes ?? "",
        portraitAssetUrl: player.portraitAssetUrl,
        inventory,
        spells: player.spells ?? [],
        features: player.features ?? [],
        resources: normalizePlayerResources(player),
        loreEvents: player.loreEvents ?? [],
        moralProfile: player.moralProfile,
        aiPersonality: player.aiPersonality,
        aiGoal: player.aiGoal,
      });
      }),
      messages: room.messages.map((message) => ({
        ...message,
        kind: message.kind ?? (message.role === "gm" ? "gm" : message.role === "system" ? "system" : "action"),
        rawContent: message.rawContent ?? message.content,
      })),
      scene: room.scene ?? {
        title: openingScene.title,
        summary: openingScene.summary,
        activeQuest: openingScene.quest || undefined,
      },
      combat: this.normalizeCombat(room.combat ?? defaultCombatState()),
      memory: {
        entries: normalizedMemory.entries ?? [],
        summary: normalizedMemory.summary ?? "No campaign memories recorded yet.",
        updatedAt: normalizedMemory.updatedAt,
      },
    };
  }

  private requireRoom(roomId: string): RoomState {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new Error(`Room ${roomId} was not found`);
    }
    return room;
  }
}
