import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { buildPlayerFromCharacter, defaultRoomSetup, roomSetupOptions } from "../game/dnd5e.js";
import { monsterCatalog } from "../game/monster-catalog.js";
import { z } from "zod";
import { config } from "../config.js";
import type { GameEngine } from "../game/engine.js";
import type { MemoryStore } from "../store/memory-store.js";

const createRoomSchema = z.object({
  name: z.string().max(80).optional().default(""),
  setup: z.object({
    systemId: z.literal("dnd5e-srd"),
    startingLevel: z.number().int().min(1).max(5),
    npcCompanions: z.number().int().min(0).max(3).optional().default(0),
    enemyDifficulty: z.enum(["story", "standard", "deadly"]),
    battleIntensity: z.enum(["low", "medium", "high"]),
    gmKindness: z.enum(["merciful", "balanced", "grim"]),
  }).optional(),
});

const joinRoomSchema = z.object({
  name: z.string().min(2).max(40),
  characterName: z.string().min(2).max(40),
  appearanceDescription: z.string().max(400).optional().default(""),
  physicalDescription: z.string().max(220).optional().default(""),
  weaponDescription: z.string().max(180).optional().default(""),
  outfitDescription: z.string().max(220).optional().default(""),
  className: z.enum(["Fighter", "Rogue", "Wizard", "Cleric", "Ranger", "Bard", "Paladin", "Druid"]),
  species: z.enum(["Human", "Elf", "Dwarf", "Halfling"]),
  gender: z.enum(["male", "female"]).optional().default("male"),
  background: z.enum(["Soldier", "Scholar", "Acolyte", "Outlander", "Entertainer", "Hermit"]),
  origin: z.string().max(700).optional().default(""),
  motivation: z.string().max(700).optional().default(""),
  turningPoint: z.string().max(700).optional().default(""),
  connections: z.string().max(700).optional().default(""),
  backstory: z.string().max(1800).optional().default(""),
  portraitUrl: z.string().max(300).optional(),
  attributeOverrides: z.record(z.string(), z.number().int().min(8).max(15)).optional(),
  skillProficiencies: z.array(z.string().max(40)).max(6).optional(),
  spellSelection: z.array(z.string().max(60)).max(10).optional(),
  equipmentChoice: z.number().int().min(0).max(5).optional(),
  controller: z.enum(["human", "ai"]).optional().default("human"),
  aiPersonality: z.string().max(500).optional(),
  aiGoal: z.string().max(500).optional(),
});

const actionSchema = z.object({
  playerId: z.string().min(1),
  content: z.string().min(1).max(600),
});

const readySchema = z.object({
  ready: z.boolean(),
});

const notesSchema = z.object({
  notes: z.string().max(5000),
});

const startSchema = z.object({
  hostPlayerId: z.string().min(1),
  adventureHook: z.string().max(600).optional(),
  sceneKeyword: z.string().max(60).optional(),
  adventureTitle: z.string().max(120).optional(),
});

const rollSchema = z.object({
  playerId: z.string().min(1),
  count: z.number().int().min(1).max(6),
  sides: z.union([
    z.literal(4),
    z.literal(6),
    z.literal(8),
    z.literal(10),
    z.literal(12),
    z.literal(20),
  ]),
  modifier: z.number().int().min(-10).max(20),
  results: z.array(z.number().int().min(1).max(20)).min(1).max(6),
});

const aiTurnSchema = z.object({
  playerId: z.string().optional(),
});

const encounterSchema = z.object({
  triggeringPlayerId: z.string().min(1),
});

const levelUpSchema = z.object({
  className: z.enum(["Fighter", "Rogue", "Wizard", "Cleric", "Ranger", "Bard", "Paladin", "Druid"]),
  newSkillProficiencies: z.array(z.string().max(40)).max(2).optional(),
  newSpells: z.array(z.string().max(60)).max(6).optional(),
});

const milestoneSchema = z.object({
  playerId: z.string().min(1),
  title: z.string().min(3).max(120),
  description: z.string().max(700).optional(),
  xp: z.number().int().min(1).max(5000),
});

type PortraitOption = {
  url: string;
  quality: "curated" | "standard";
  source: string;
  label: string;
};

const collectPortraitFiles = async (directory: string): Promise<string[]> => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectPortraitFiles(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".png")) {
      files.push(entryPath);
    }
  }

  return files;
};

export const registerRoomRoutes = async (
  app: FastifyInstance,
  dependencies: { engine: GameEngine; store: MemoryStore },
) => {
  app.get("/health", async () => ({ status: "ok" }));

  app.get("/api/status", async () => ({
    rooms: dependencies.store.listRooms().length,
  }));

  app.get("/api/portrait-options", async () => {
    const result: Record<string, PortraitOption[]> = {};
    try {
      await fs.mkdir(config.portraitsDir, { recursive: true });
      const files = await collectPortraitFiles(config.portraitsDir);
      for (const filePath of files) {
        const relativePath = path.relative(config.portraitsDir, filePath).replace(/\\/g, "/");
        const file = path.basename(filePath);
        // filename format: {class}_{species}_{gender}_{variant}.png
        const parts = file.replace(".png", "").split("_");
        if (parts.length < 3) continue;
        const key = `${parts[0]}_${parts[1]}_${parts[2]}`;
        if (!result[key]) result[key] = [];
        const quality = relativePath.startsWith("Good/") ? "curated" : "standard";
        result[key].push({
          url: `/assets/portraits/${relativePath}`,
          quality,
          source: relativePath.includes("/") ? (relativePath.split("/")[0] ?? "root") : "root",
          label: quality === "curated" ? "Curated" : "Generated",
        });
      }
      for (const key of Object.keys(result)) {
        result[key].sort((left, right) => {
          if (left.quality !== right.quality) {
            return left.quality === "curated" ? -1 : 1;
          }
          return left.url.localeCompare(right.url);
        });
      }
    } catch {
      // portraits directory not yet generated — return empty map
    }
    return result;
  });

  app.post("/api/portrait-preview", async (request, reply) => {
    const body = joinRoomSchema.parse(request.body);
    try {
      return await dependencies.engine.generatePortraitPreview(
        {
          name: body.name,
          characterName: body.characterName,
          appearanceDescription: body.appearanceDescription,
          physicalDescription: body.physicalDescription,
          weaponDescription: body.weaponDescription,
          outfitDescription: body.outfitDescription,
          className: body.className,
          species: body.species,
          gender: body.gender,
          background: body.background,
          origin: body.origin,
          motivation: body.motivation,
          turningPoint: body.turningPoint,
          connections: body.connections,
          backstory: body.backstory,
          portraitAssetUrl: undefined,
          attributeOverrides: body.attributeOverrides,
          skillProficiencies: body.skillProficiencies,
          spellSelection: body.spellSelection,
          equipmentChoice: body.equipmentChoice,
        },
        1,
      );
    } catch (error) {
      reply.code(400);
      return { message: (error as Error).message };
    }
  });

  app.get("/api/scene-options", async () => {
    type SceneCatalogEntry = {
      id: string;
      label: string;
      description: string;
      keywords: string[];
      defaultScene: string;
      files: string[];
      generationPrompt: string;
      generationNegative: string;
    };
    type SceneOption = {
      url: string;
      filename: string;
      exists: boolean;
    };
    type SceneOptionGroup = SceneCatalogEntry & { options: SceneOption[] };

    try {
      await fs.mkdir(config.scenesDir, { recursive: true });
      const catalogPath = path.join(config.scenesDir, "catalog.json");
      const raw = await fs.readFile(catalogPath, "utf-8");
      const catalog = JSON.parse(raw) as SceneCatalogEntry[];
      const dirEntries = await fs.readdir(config.scenesDir);
      const existingFiles = new Set(dirEntries.filter((f) => f.endsWith(".png")));

      const result: SceneOptionGroup[] = catalog.map((entry) => ({
        ...entry,
        options: entry.files.map((filename) => ({
          filename,
          url: `/assets/scenes/${filename}`,
          exists: existingFiles.has(filename),
        })),
      }));

      // Also surface any PNG that isn't named in the catalog
      const cataloggedFiles = new Set(catalog.flatMap((e) => e.files).concat(["default.png"]));
      const uncatalogued = [...existingFiles].filter((f) => !cataloggedFiles.has(f));

      return { scenes: result, uncatalogued: uncatalogued.map((f) => ({ filename: f, url: `/assets/scenes/${f}` })) };
    } catch {
      return { scenes: [], uncatalogued: [] };
    }
  });

  app.get("/api/lobby-options", async () => ({
    defaults: defaultRoomSetup(),
    options: roomSetupOptions,
  }));

  app.get("/api/monster-catalog", async () => ({
    systemId: "dnd5e-srd",
    sourcePolicy: "SRD-style stat blocks paraphrased for this local RPG engine.",
    monsters: monsterCatalog,
  }));

  app.get("/api/rooms/by-code/:code", async (request, reply) => {
    const params = z.object({ code: z.string().min(2) }).parse(request.params);
    const room = dependencies.store.listRooms().find((entry) => entry.code === params.code.toUpperCase());
    if (!room) {
      reply.code(404);
      return { message: "Room not found" };
    }
    return room;
  });

  app.get("/api/rooms", async () => dependencies.store.listRooms());

  app.post("/api/rooms", async (request, reply) => {
    const body = createRoomSchema.parse(request.body);
    // Create with placeholder to obtain the generated code, then set the real name
    const tempRoom = dependencies.engine.createRoom("__placeholder__", body.setup ?? defaultRoomSetup());
    const finalName = body.name || tempRoom.code;
    const finalRoom = dependencies.store.updateRoom(tempRoom.id, (r) => ({
      ...r,
      name: finalName,
      messages: r.messages.map((m) => m.rawContent === `Room __placeholder__ created.`
        ? { ...m, content: `Sess\u00e3o ${finalName} criada.`, rawContent: `Room ${finalName} created.` }
        : m),
    }));
    reply.code(201);
    return finalRoom;
  });

  app.get("/api/rooms/:roomId", async (request) => {
    const params = z.object({ roomId: z.string() }).parse(request.params);
    const room = dependencies.store.getRoom(params.roomId);
    if (!room) {
      replyNotFound();
    }
    return room;
  });

  app.delete("/api/rooms/:roomId", async (request, reply) => {
    const params = z.object({ roomId: z.string() }).parse(request.params);
    const deleted = dependencies.store.deleteRoom(params.roomId);
    if (!deleted) {
      replyNotFound();
      return { message: "Room not found" };
    }
    return { ok: true };
  });

  app.post("/api/rooms/:roomId/join", async (request, reply) => {
    const params = z.object({ roomId: z.string() }).parse(request.params);
    const body = joinRoomSchema.parse(request.body);
    try {
      const room = dependencies.store.getRoom(params.roomId);
      if (!room) {
        throw new Error("Room not found");
      }
      const builtPlayer = buildPlayerFromCharacter(
          {
            name: body.name,
            characterName: body.characterName,
            appearanceDescription: body.appearanceDescription,
            physicalDescription: body.physicalDescription,
            weaponDescription: body.weaponDescription,
            outfitDescription: body.outfitDescription,
            className: body.className,
            species: body.species,
            gender: body.gender,
            background: body.background,
            origin: body.origin,
            motivation: body.motivation,
            turningPoint: body.turningPoint,
            connections: body.connections,
            backstory: body.backstory,
            portraitAssetUrl: body.portraitUrl,
            attributeOverrides: body.attributeOverrides,
            skillProficiencies: body.skillProficiencies,
            spellSelection: body.spellSelection,
            equipmentChoice: body.equipmentChoice,
          },
          room.setup.startingLevel,
        );
      const result = dependencies.engine.joinRoom(
        params.roomId,
        {
          ...builtPlayer,
          controller: body.controller,
          aiPersonality: body.aiPersonality,
          aiGoal: body.aiGoal,
        },
      );
      reply.code(201);
      return result;
    } catch (error) {
      reply.code(404);
      return { message: (error as Error).message };
    }
  });

  app.post("/api/rooms/:roomId/players/:playerId/ready", async (request, reply) => {
    const params = z.object({ roomId: z.string(), playerId: z.string() }).parse(request.params);
    const body = readySchema.parse(request.body);
    try {
      return dependencies.engine.setPlayerReady(params.roomId, params.playerId, body.ready);
    } catch (error) {
      reply.code(400);
      return { message: (error as Error).message };
    }
  });

  app.patch("/api/rooms/:roomId/players/:playerId/notes", async (request, reply) => {
    const params = z.object({ roomId: z.string(), playerId: z.string() }).parse(request.params);
    const body = notesSchema.parse(request.body);
    try {
      return dependencies.engine.updatePlayerNotes(params.roomId, params.playerId, body.notes);
    } catch (error) {
      reply.code(400);
      return { message: (error as Error).message };
    }
  });

  app.post("/api/rooms/:roomId/players/:playerId/level-up", async (request, reply) => {
    const params = z.object({ roomId: z.string(), playerId: z.string() }).parse(request.params);
    const body = levelUpSchema.parse(request.body);
    try {
      return await dependencies.engine.applyPlayerLevelUp(params.roomId, params.playerId, body);
    } catch (error) {
      reply.code(400);
      return { message: (error as Error).message };
    }
  });

  app.post("/api/rooms/:roomId/milestones", async (request, reply) => {
    const params = z.object({ roomId: z.string() }).parse(request.params);
    const body = milestoneSchema.parse(request.body);
    try {
      return await dependencies.engine.awardMilestoneExperience(params.roomId, body.playerId, {
        title: body.title,
        description: body.description,
        xp: body.xp,
      });
    } catch (error) {
      reply.code(400);
      return { message: (error as Error).message };
    }
  });

  app.post("/api/rooms/:roomId/players/:playerId/regenerate-portrait", async (request, reply) => {
    const params = z.object({ roomId: z.string(), playerId: z.string() }).parse(request.params);
    try {
      return dependencies.engine.regeneratePlayerPortrait(params.roomId, params.playerId);
    } catch (error) {
      reply.code(400);
      return { message: (error as Error).message };
    }
  });

  app.get("/api/rooms/:roomId/suggestions", async (request, reply) => {
    const params = z.object({ roomId: z.string() }).parse(request.params);
    try {
      return await dependencies.engine.generateAdventureSuggestions(params.roomId);
    } catch (error) {
      reply.code(400);
      return { message: (error as Error).message };
    }
  });

  app.post("/api/rooms/:roomId/start", async (request, reply) => {
    const params = z.object({ roomId: z.string() }).parse(request.params);
    const body = startSchema.parse(request.body);
    try {
      return await dependencies.engine.startSession(params.roomId, body.hostPlayerId, body.adventureHook, body.sceneKeyword, body.adventureTitle);
    } catch (error) {
      reply.code(400);
      return { message: (error as Error).message };
    }
  });

  app.post("/api/rooms/:roomId/encounters/start", async (request, reply) => {
    const params = z.object({ roomId: z.string() }).parse(request.params);
    const body = encounterSchema.parse(request.body);
    try {
      return await dependencies.engine.startEncounter(params.roomId, body.triggeringPlayerId);
    } catch (error) {
      reply.code(400);
      return { message: (error as Error).message };
    }
  });

  app.post("/api/rooms/:roomId/actions", async (request, reply) => {
    const params = z.object({ roomId: z.string() }).parse(request.params);
    const body = actionSchema.parse(request.body);
    try {
      const room = await dependencies.engine.handleAction(params.roomId, body);
      return room;
    } catch (error) {
      reply.code(404);
      return { message: (error as Error).message };
    }
  });

  app.post("/api/rooms/:roomId/rolls", async (request, reply) => {
    const params = z.object({ roomId: z.string() }).parse(request.params);
    const body = rollSchema.parse(request.body);
    try {
      const room = await dependencies.engine.handleDiceRoll(params.roomId, body);
      return room;
    } catch (error) {
      reply.code(400);
      return { message: (error as Error).message };
    }
  });

  app.post("/api/rooms/:roomId/regenerate-last-gm", async (request, reply) => {
    const params = z.object({ roomId: z.string() }).parse(request.params);
    const body = z.object({ requestingPlayerId: z.string().min(1) }).parse(request.body);
    try {
      return await dependencies.engine.regenerateLastGmTurn(params.roomId, body.requestingPlayerId);
    } catch (error) {
      reply.code(400);
      return { message: (error as Error).message };
    }
  });

  app.post("/api/rooms/:roomId/ai-turns", async (request, reply) => {
    const params = z.object({ roomId: z.string() }).parse(request.params);
    const body = aiTurnSchema.parse(request.body ?? {});
    try {
      return await dependencies.engine.handleAiPlayerTurn(params.roomId, body.playerId);
    } catch (error) {
      reply.code(400);
      return { message: (error as Error).message };
    }
  });
};

const replyNotFound = (): never => {
  throw new Error("Not found");
};
