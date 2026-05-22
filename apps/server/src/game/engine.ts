import type { Server as SocketServer } from "socket.io";
import { nanoid } from "nanoid";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { planPlayerAction } from "./action-orchestrator.js";
import { buildAiPlayerGraph } from "./ai-player-graph.js";
import { buildGmTurnGraph } from "./gm-turn-graph.js";
import { enforceRollRequestConsistency, evaluateMechanicalRuling, type MechanicalRuling } from "./mechanics-guard.js";
import { applyRetrievedMemoryTouches, applySummarizedMemory, findCompressionWindow, recordCampaignTurn, recordPlayerCharacters } from "./campaign-memory.js";
import { recordLoreFromTurn } from "./player-lore.js";
import { enforcePlayerGenderAgreement } from "./gender-language.js";
import { withRoomLock } from "./turn-lock.js";
import { applyExperienceToPlayer, applyLevelUpChoice, buildCharacterPortraitPrompt, buildEnemyGroup, buildEnemyProfile, buildNpcStats, buildOpeningScene, buildPlayerFromCharacter, buildScenePrompt } from "./dnd5e.js";
import { createInitialStoryArc, recordCombatInStoryArc, updateStoryArcFromTurn } from "./story-arc.js";
import { buildBeastVisualLocks, enemyIsNaturalBeast, npcIsAnimalCompanion, visualLocksFromPortuguese } from "./image-prompt-refiner.js";
import { JanClient } from "../integrations/jan-client.js";
import type { PreparedSession as _PreparedSession } from "../integrations/jan-client.js";
import type { AdventureSuggestion } from "../integrations/jan-client.js";
import { ImageService } from "../integrations/image-service.js";
import { TtsService } from "../integrations/tts-service.js";
import { config } from "../config.js";
import { MemoryStore } from "../store/memory-store.js";
import type { CampaignMemoryEntry, CharacterCreation, CombatActor, CombatState, DiceRollRequest, EnemyState, GmResponse, ImageJob, PendingRollRequest, Player, PlayerAction, PlayerLoreEvent, RoomState, SceneNpc } from "./types.js";
import { LocalCampaignMemoryProvider, type CampaignMemoryProvider } from "./memory-provider.js";
import { inferVoiceProfile, type VoiceProfile } from "./voice-catalog.js";

const rollDie = (sides: number): number => Math.floor(Math.random() * sides) + 1;

type CombatRollMeta = {
  naturalD20?: number;
  critical?: boolean;
};

export class GameEngine {
  // Single global image queue â€” all rooms share one serial slot to avoid CPU overload
  private readonly globalImageQueue: Array<() => Promise<void>> = [];
  private globalImageRunning = false;
  private readonly aiPlayerGraph: ReturnType<typeof buildAiPlayerGraph>;
  private readonly gmTurnGraph: ReturnType<typeof buildGmTurnGraph>;

  constructor(
    private readonly store: MemoryStore,
    private readonly janClient: JanClient,
    private readonly imageService: ImageService,
    private readonly io: SocketServer,
    private readonly memoryProvider: CampaignMemoryProvider = new LocalCampaignMemoryProvider(),
    private readonly ttsService: TtsService | null = null,
  ) {
    this.aiPlayerGraph = buildAiPlayerGraph(janClient);
    this.gmTurnGraph = buildGmTurnGraph(janClient, memoryProvider);
  }

  /**
   * Sintetiza uma frase pelo TTS e, quando o WAV estÃ¡ pronto, emite `room:gmAudio`
   * com o id que o cliente usa pra puxar o Ã¡udio do endpoint /api/audio/:id.
   *
   * NÃ£o bloqueia o turno: a frase aparece no chat imediatamente; o Ã¡udio chega
   * depois, quando estiver pronto. Falha silenciosa se TTS desabilitado.
   */
  private async narrateSentence(
    roomId: string,
    streamId: string,
    sentence: string,
    sequence: number,
    voiceProfile: VoiceProfile,
    speaker: string,
    messageId?: string,
  ): Promise<void> {
    if (!this.ttsService || !this.ttsService.isEnabled()) return;
    try {
      const result = await this.ttsService.synthesize(sentence, voiceProfile);
      if (!result) return;
      this.io.to(roomId).emit("room:gmAudio", {
        streamId,
        sequence,
        messageId,
        audioId: result.audioId,
        audioUrl: `/api/audio/${result.audioId}`,
        durationMs: result.durationMs,
        speaker,
        voiceProfile,
      });
    } catch (error) {
      console.warn("[engine] TTS synth failed:", (error as Error).message);
    }
  }

  private narrateText(roomId: string, streamId: string, text: string, voiceProfile: VoiceProfile = "gm-narrator", speaker = "Game Master", messageId?: string): void {
    if (!this.ttsService || !this.ttsService.isEnabled() || !text.trim()) return;
    void this.narrateSentence(roomId, streamId, text, 0, voiceProfile, speaker, messageId);
  }

  private recordPlayerLoreFromTurn(roomId: string, playerId: string, action: PlayerAction, gmResponse: { narration: string; sceneSummary: string; ruleOutcome?: string }): void {
    const room = this.store.getRoom(roomId);
    const player = room?.players.find((entry) => entry.id === playerId);
    if (!room || !player) return;

    const updated = recordLoreFromTurn(room, player, action, {
      narration: gmResponse.narration,
      sceneSummary: gmResponse.sceneSummary,
      ruleOutcome: gmResponse.ruleOutcome ?? "",
      imageJobs: [],
      npcActions: [],
      joiningNpcs: [],
      rollRequest: null,
      npcHealthUpdates: [],
    });
    if (!updated) return;

    this.store.updatePlayer(roomId, playerId, () => updated);
    this.broadcastState(roomId);
  }

  private withPlayerLanguage<T extends { narration: string; sceneSummary: string; ruleOutcome?: string }>(player: Player, response: T): T {
    return {
      ...response,
      narration: enforcePlayerGenderAgreement(response.narration, player),
      sceneSummary: enforcePlayerGenderAgreement(response.sceneSummary, player),
      ruleOutcome: response.ruleOutcome ? enforcePlayerGenderAgreement(response.ruleOutcome, player) : response.ruleOutcome,
    };
  }

  private syncGraphMemory(roomId: string): void {
    const room = this.store.getRoom(roomId);
    if (!room || !this.memoryProvider.indexRoomMemory) return;
    void this.memoryProvider.indexRoomMemory(room).catch((error) => {
      console.warn(`[engine] graph memory sync failed for room ${roomId}:`, error);
    });
  }

  private scheduleImage(_roomId: string, task: () => Promise<void>): void {
    this.globalImageQueue.push(task);
    void this.drainGlobalQueue();
  }

  private completeImageJob(roomId: string, job: ImageJob, assetUrl: string): ImageJob | undefined {
    const completed = this.store.completeImageJob(roomId, job.id, assetUrl);
    if (completed) {
      this.io.to(roomId).emit("room:image", completed);
      this.broadcastState(roomId);
    }
    return completed;
  }

  private resolveCachedOrScheduleGenerated(
    roomId: string,
    job: ImageJob,
    onComplete?: (completed: ImageJob) => void,
    options: { skipCache?: boolean } = {},
  ): void {
    const cached = options.skipCache ? null : this.imageService.resolveCached(job);
    if (cached) {
      const completed = this.completeImageJob(roomId, job, cached.assetUrl);
      if (completed) onComplete?.(completed);
      return;
    }

    this.scheduleImage(roomId, async () => {
      const result = await this.imageService.render(job, { skipCache: options.skipCache });
      if (!result) return;
      const completed = this.completeImageJob(roomId, job, result.assetUrl);
      if (completed) onComplete?.(completed);
    });
  }

  // Per-room flag so we never run two summarization passes in parallel for the same room.
  private readonly summarizingRooms = new Set<string>();

  private async maybeSummarizeMemory(roomId: string): Promise<void> {
    if (this.summarizingRooms.has(roomId)) return;
    const room = this.store.getRoom(roomId);
    if (!room) return;

    const window = findCompressionWindow(room.memory);
    if (!window || window.length === 0) return;

    this.summarizingRooms.add(roomId);
    try {
      const compressedIds = new Set(window.map((entry) => entry.id));
      const summary = await this.janClient.summarizeMemoryWindow(roomId, window.map((entry) => ({
        kind: entry.kind,
        title: entry.title,
        content: entry.content,
      })));

      if (!summary) return;

      this.store.updateMemory(roomId, (memory) => applySummarizedMemory(memory, compressedIds, summary));
      this.syncGraphMemory(roomId);
      this.broadcastState(roomId);
    } catch (error) {
      console.warn(`[engine] memory summarization failed for room ${roomId}:`, error);
    } finally {
      this.summarizingRooms.delete(roomId);
    }
  }

  private async drainGlobalQueue(): Promise<void> {
    if (this.globalImageRunning) return;
    this.globalImageRunning = true;
    try {
      while (this.globalImageQueue.length > 0) {
        const task = this.globalImageQueue.shift()!;
        try { await task(); } catch { /* individual job failure, continue queue */ }
      }
    } finally {
      this.globalImageRunning = false;
    }
  }

  createRoom(name: string, setup: RoomState["setup"]): RoomState {
    const room = this.store.createRoom(name, setup);
    this.store.addMessage(room.id, {
      role: "system",
      kind: "system",
      authorName: "System",
      content: `Sess\u00e3o ${room.name} criada. Sistema: ${setup.systemId}, n\u00edvel ${setup.startingLevel}, dificuldade ${setup.enemyDifficulty}, batalhas ${setup.battleIntensity}, mestre ${setup.gmKindness}.`,
      rawContent: `Room ${room.name} created.`,
    });
    return room;
  }

  joinRoom(roomId: string, player: Omit<Player, "id">): { player: Player; room: RoomState } {
    const createdPlayer = this.store.joinRoom(roomId, player);
    this.store.addMessage(roomId, {
      role: "system",
      kind: "system",
      authorName: "System",
      content: `${createdPlayer.characterName} entrou no grupo.`,
      rawContent: `${createdPlayer.characterName} entrou no grupo.`,
    });
    this.broadcastSnapshot(roomId);

    const room = this.store.getRoom(roomId);
    if (!room) {
      throw new Error("Room not found");
    }

    if (!createdPlayer.portraitAssetUrl) {
      this.createPortraitImage(roomId, createdPlayer);
    }

    return { player: createdPlayer, room };
  }

  setPlayerReady(roomId: string, playerId: string, ready: boolean): RoomState {
    this.store.updatePlayer(roomId, playerId, (player) => ({ ...player, ready }));
    this.store.addMessage(roomId, {
      role: "system",
      kind: "system",
      authorName: "System",
      content: `${this.store.getRoom(roomId)?.players.find((player) => player.id === playerId)?.characterName ?? "Um jogador"} ${ready ? "esta pronto" : "nao esta pronto"}.`,
      rawContent: `${playerId}:${ready}`,
    });
    this.broadcastSnapshot(roomId);
    const room = this.store.getRoom(roomId);
    if (!room) {
      throw new Error("Room not found");
    }
    return room;
  }

  updatePlayerNotes(roomId: string, playerId: string, notes: string): Player {
    const player = this.store.updatePlayer(roomId, playerId, (entry) => ({ ...entry, notes }));
    this.broadcastSnapshot(roomId);
    return player;
  }

  regeneratePlayerPortrait(roomId: string, playerId: string): RoomState {
    const room = this.store.getRoom(roomId);
    if (!room) throw new Error("Room not found");
    const player = room.players.find((entry) => entry.id === playerId);
    if (!player) throw new Error("Player not found");

    const updatedPlayer = this.store.updatePlayer(roomId, playerId, (entry) => ({ ...entry, portraitAssetUrl: undefined }));
    this.createPortraitImage(roomId, updatedPlayer);
    this.broadcastSnapshot(roomId);
    return this.store.getRoom(roomId)!;
  }

  retryQueuedImageJobs(): void {
    const allRooms = this.store.listRooms();

    // Portraits: retry for any room where a player is missing their portrait
    for (const room of allRooms) {
      for (const player of room.players) {
        if (!player.portraitAssetUrl) {
          this.createPortraitImage(room.id, player);
        }
      }
    }

    // Non-portrait scene/creature/item jobs: only retry jobs from the most recent room
    // that has pending jobs. Old test rooms can accumulate many stale queued jobs and
    // would overwhelm the CPU on every server restart.
    const mostRecentRoomWithQueued = [...allRooms]
      .reverse()
      .find((room) => room.imageJobs.some((j) => j.status === "queued" && j.profile !== "portrait"));

    if (!mostRecentRoomWithQueued) return;

    for (const job of mostRecentRoomWithQueued.imageJobs.filter((j) => j.status === "queued" && j.profile !== "portrait")) {
      const jobSnapshot = job;
      const roomId = mostRecentRoomWithQueued.id;
      this.resolveCachedOrScheduleGenerated(roomId, jobSnapshot);
    }
  }

  async handleDiceRoll(roomId: string, roll: DiceRollRequest): Promise<RoomState> {
    return withRoomLock(roomId, () => this.handleDiceRollInternal(roomId, roll));
  }

  async applyPlayerLevelUp(roomId: string, playerId: string, choice: { className: string; newSkillProficiencies?: string[]; newSpells?: string[] }): Promise<RoomState> {
    return withRoomLock(roomId, async () => {
      const room = this.store.getRoom(roomId);
      if (!room) throw new Error("Room not found");
      const player = room.players.find((entry) => entry.id === playerId);
      if (!player) throw new Error("Player not found");
      const lastCombat = room.combat.lastOutcome ? `Ãšltimo marco registrado: ${room.combat.lastOutcome}` : `Marco de aventura em ${room.scene.title}.`;
      const result = applyLevelUpChoice(player, { ...choice, source: lastCombat });
      this.store.updatePlayer(roomId, playerId, () => result.player);
      const message = this.store.addMessage(roomId, {
        role: "system",
        kind: "system",
        authorName: "Sistema",
        content: `${result.player.characterName} subiu para o nÃ­vel ${result.toLevel}: ${choice.className} ${result.classLevel}. +${result.hpGain} HP mÃ¡ximo.${result.featuresGained.length ? ` Novas caracterÃ­sticas: ${result.featuresGained.join(", ")}.` : ""}${result.spellsGained.length ? ` Novas magias: ${result.spellsGained.join(", ")}.` : ""}${result.skillsGained.length ? ` Novas perÃ­cias: ${result.skillsGained.join(", ")}.` : ""}`,
        rawContent: JSON.stringify({ type: "level-up", playerId, result }),
      });
      this.io.to(roomId).emit("room:messages", [message]);
      this.broadcastState(roomId);
      return this.store.getRoom(roomId)!;
    });
  }

  async startEncounter(roomId: string, triggeringPlayerId: string): Promise<RoomState> {
    return withRoomLock(roomId, async () => {
      const room = this.store.getRoom(roomId);
      if (!room) throw new Error("Room not found");
      if (room.status !== "active") throw new Error("A sessao precisa estar ativa para iniciar combate.");
      if (room.combat.active) return room;
      const player = room.players.find((entry) => entry.id === triggeringPlayerId);
      if (!player) throw new Error("Player not found");
      if ((room.scene.storyArc?.recentCombatsSinceLongRest ?? 0) >= 3) {
        throw new Error("O ritmo da aventura recomenda um descanso longo antes de outro combate em sequencia.");
      }
      this.startCombat(roomId, room, triggeringPlayerId);
      const updated = this.store.getRoom(roomId)!;
      this.broadcastState(roomId);
      return updated;
    });
  }

  async awardMilestoneExperience(roomId: string, playerId: string, milestone: { title: string; description?: string; xp: number }): Promise<RoomState> {
    return withRoomLock(roomId, async () => {
      const room = this.store.getRoom(roomId);
      if (!room) throw new Error("Room not found");
      const player = room.players.find((entry) => entry.id === playerId);
      if (!player) throw new Error("Player not found");
      const xp = Math.max(0, Math.floor(milestone.xp));
      const result = applyExperienceToPlayer(player, xp);
      const loreEvent: PlayerLoreEvent = {
        id: `milestone-${player.id}-${Date.now()}`,
        category: "achievement",
        title: milestone.title,
        summary: milestone.description || `${player.characterName} alcancou um marco importante da aventura.`,
        importance: result.leveledUp ? "major" : "notable",
        location: room.scene.title,
        consequence: `${xp} XP de marco narrativo. XP atual: ${result.player.experiencePoints}.`,
        createdAt: new Date().toISOString(),
      };
      this.store.updatePlayer(roomId, playerId, () => ({
        ...result.player,
        loreEvents: [...(result.player.loreEvents ?? []), loreEvent].slice(-40),
      }));
      this.store.updateScene(roomId, {
        storyArc: {
          ...(room.scene.storyArc ?? createInitialStoryArc(room)),
          completedBeats: [...(room.scene.storyArc?.completedBeats ?? []), `${milestone.title}: ${milestone.description ?? "marco narrativo"}`].slice(-12),
        },
      });
      const message = this.store.addMessage(roomId, {
        role: "system",
        kind: "system",
        authorName: "Sistema",
        content: `${player.characterName} recebeu ${xp} XP por marco narrativo: ${milestone.title}.${result.leveledUp ? ` Level-up disponivel: aplique ${result.player.pendingLevelUps} nivel(is) de classe.` : ""}`,
        rawContent: JSON.stringify({ type: "milestone-xp", playerId, milestone, result }),
      });
      this.io.to(roomId).emit("room:messages", [message]);
      this.broadcastState(roomId);
      return this.store.getRoom(roomId)!;
    });
  }

  private async handleDiceRollInternal(roomId: string, roll: DiceRollRequest): Promise<RoomState> {
    const room = this.store.getRoom(roomId);
    if (!room) {
      throw new Error("Room not found");
    }
    if (room.status !== "active") {
      throw new Error("The session has not started yet.");
    }

    const player = room.players.find((entry) => entry.id === roll.playerId);
    if (!player) {
      throw new Error("Player not found");
    }

    if (roll.results.length !== roll.count) {
      throw new Error("Dice result count does not match the selected number of dice.");
    }

    if (roll.results.some((value) => value < 1 || value > roll.sides)) {
      throw new Error(`Dice results must be between 1 and ${roll.sides}.`);
    }

    const pendingRoll = room.scene.pendingRollRequest;
    if (pendingRoll && pendingRoll.playerName === player.characterName) {
      const expectedCount = pendingRoll.advantage && pendingRoll.die === "d20"
        ? 2
        : (pendingRoll.diceCount ?? pendingRoll.damageDiceCount ?? 1);
      const expectedSides = Number(pendingRoll.die.replace("d", ""));
      if (roll.sides !== expectedSides || roll.results.length !== expectedCount || roll.count !== expectedCount) {
        throw new Error(`Esta rolagem precisa ser ${expectedCount}${pendingRoll.die}${pendingRoll.modifier !== 0 ? ` ${this.formatModifier(pendingRoll.modifier)}` : ""}.`);
      }
    }
    const useAdvantage =
      pendingRoll?.playerName === player.characterName &&
      pendingRoll.advantage &&
      roll.sides === 20 &&
      roll.results.length >= 2;
    const subtotal = useAdvantage
      ? pendingRoll.advantage === "disadvantage"
        ? Math.min(...roll.results)
        : Math.max(...roll.results)
      : roll.results.reduce((sum, value) => sum + value, 0);
    const total = subtotal + roll.modifier;
    const naturalD20 = roll.sides === 20
      ? useAdvantage
        ? subtotal
        : roll.results[0]
      : undefined;
    const rollMeta: CombatRollMeta = {
      naturalD20,
      critical: naturalD20 === 20,
    };
    const modifierText = roll.modifier === 0 ? "" : ` ${roll.modifier > 0 ? "+" : "-"} ${Math.abs(roll.modifier)}`;
    const advantageText = useAdvantage
      ? ` (${pendingRoll.advantage === "disadvantage" ? "desvantagem: menor dado" : "vantagem: maior dado"} ${subtotal})`
      : "";
    const message = this.store.addMessage(roomId, {
      role: "player",
      kind: "roll",
      authorName: player.characterName,
      content: `${player.characterName} rolou ${roll.count}d${roll.sides}: [${roll.results.join(", ")}]${advantageText}${modifierText} = ${total}`,
      rawContent: JSON.stringify(roll),
    });

    this.io.to(roomId).emit("room:messages", [message]);
    this.broadcastState(roomId);

    // If there's a pending roll request and this player matches, resolve it with the LLM
    if (pendingRoll && pendingRoll.playerName === player.characterName) {
      this.store.updateScene(roomId, { pendingRollRequest: null });
      if (pendingRoll.kind?.startsWith("combat_")) {
        this.resolveCombatRoll(roomId, player, pendingRoll, total, rollMeta);
        this.broadcastState(roomId);
        return this.store.getRoom(roomId)!;
      }

      const freshRoom = this.store.getRoom(roomId);
      if (freshRoom) {
        try {
          const resolution = await this.janClient.resolveRollResult(freshRoom, pendingRoll, total);
          const resolutionMessage = this.store.addMessage(roomId, {
            role: "gm",
            kind: "gm",
            authorName: "Game Master",
            content: resolution.ruleOutcome ? `${resolution.narration}\n\nRegra: ${resolution.ruleOutcome}` : resolution.narration,
            rawContent: resolution.narration,
          });
          this.narrateText(roomId, `roll-${resolutionMessage.id}`, resolution.narration, "gm-narrator", "Game Master", resolutionMessage.id);
          this.store.updateScene(roomId, { summary: resolution.sceneSummary });
          this.io.to(roomId).emit("room:messages", [resolutionMessage]);
          this.broadcastState(roomId);
        } catch (error) {
          console.error("[engine] Failed to resolve roll result:", error);
        }
      }
    }

    return this.store.getRoom(roomId)!;
  }

  async startSession(roomId: string, hostPlayerId: string, adventureHook?: string, sceneKeyword?: string, adventureTitle?: string): Promise<RoomState> {
    const room = this.store.getRoom(roomId);
    if (!room) {
      throw new Error("Room not found");
    }
    if (room.setup.hostPlayerId !== hostPlayerId) {
      throw new Error("Only the host can start the session.");
    }
    if (room.players.length < 1) {
      throw new Error("At least one player is required to start a session.");
    }
    if (room.players.some((player) => !player.ready)) {
      throw new Error("All players must be ready before the host starts the session.");
    }

    // Initialise core scene/combat state immediately so the room has a valid base.
    const openingScene = buildOpeningScene(room.setup);
    // Override with chosen adventure suggestion title if provided
    if (adventureTitle) {
      openingScene.title = adventureTitle;
      if (adventureHook) openingScene.summary = adventureHook.split(".")[0] ?? openingScene.summary;
    }
    this.store.updateScene(roomId, {
      title: openingScene.title,
      summary: openingScene.summary,
      activeQuest: openingScene.quest || undefined,
      combatRound: undefined,
      storyArc: createInitialStoryArc({ ...room, scene: { ...room.scene, title: openingScene.title, summary: openingScene.summary } }, adventureHook),
    });
    this.store.updateCombat(roomId, {
      active: false,
      round: 0,
      currentTurnIndex: 0,
      order: [],
      enemies: [],
      log: [],
      lastOutcome: undefined,
    });

    // Move to "preparing" and broadcast immediately â€” the HTTP response returns this state
    // so every connected client can display the loading transition screen straight away.
    this.store.updateStatus(roomId, "preparing");
    this.broadcastSnapshot(roomId);

    // Fire the full preparation pipeline in the background without blocking the HTTP response.
    void this.runPreparation(roomId, hostPlayerId, openingScene, adventureHook, sceneKeyword);

    return this.store.getRoom(roomId)!;
  }

  async generateAdventureSuggestions(roomId: string): Promise<AdventureSuggestion[]> {
    const room = this.store.getRoom(roomId);
    if (!room) throw new Error("Room not found");
    const imageInventory = this.imageService.getImageInventory();
    return this.janClient.runAdventureSuggestions(room, imageInventory);
  }

  async generatePortraitPreview(character: CharacterCreation, level: number): Promise<{ assetUrl: string; prompt: string }> {
    if (config.textOnly) {
      throw new Error("GeraÃ§Ã£o de imagens estÃ¡ desativada.");
    }
    const player = buildPlayerFromCharacter(character, level);
    const portrait = buildCharacterPortraitPrompt(player);
    const job: ImageJob = {
      id: `preview-${nanoid()}`,
      roomId: "portrait-preview",
      status: "queued",
      profile: "portrait",
      prompt: portrait.prompt,
      subjectName: player.characterName,
      negativePrompt: portrait.negativePrompt,
      seed: portrait.seed + Math.floor(Math.random() * 100000),
    };
    const result = await this.imageService.render(job);
    if (!result) {
      throw new Error("NÃ£o foi possÃ­vel gerar o retrato agora.");
    }
    return { assetUrl: result.assetUrl, prompt: portrait.prompt };
  }

  /**
   * Regenerates the last GM response. Called by the host when the model hallucinates
   * or contradicts established canon. Strategy:
   *
   * 1. Find the most recent GM message and the player action that triggered it.
   * 2. Delete the GM message and any NPC-action messages that came in the same batch
   *    (everything between the last player message and the last GM message).
   * 3. Re-run the gmTurnGraph for that action with a slight nudge in temperature.
   * 4. Persist the new response just like a normal turn.
   *
   * Does NOT undo dice rolls or combat state changes â€” those are mechanical, not narrative.
   */
  async regenerateLastGmTurn(roomId: string, requestingPlayerId: string): Promise<RoomState> {
    return withRoomLock(roomId, async () => {
      const room = this.store.getRoom(roomId);
      if (!room) throw new Error("Room not found");
      if (room.setup.hostPlayerId && room.setup.hostPlayerId !== requestingPlayerId) {
        throw new Error("Apenas o host da mesa pode pedir regeneraÃ§Ã£o.");
      }

      // Find the last player action message (kind: action/speech/whisper/question/roll).
      let lastPlayerActionIndex = -1;
      for (let i = room.messages.length - 1; i >= 0; i--) {
        const msg = room.messages[i];
        if (msg.role === "player" && (msg.kind === "action" || msg.kind === "speech" || msg.kind === "whisper" || msg.kind === "question")) {
          lastPlayerActionIndex = i;
          break;
        }
      }

      if (lastPlayerActionIndex === -1) {
        throw new Error("Nenhuma aÃ§Ã£o de jogador para regenerar.");
      }

      const triggeringMessage = room.messages[lastPlayerActionIndex];
      const triggeringPlayer = room.players.find((p) => p.characterName === triggeringMessage.authorName);
      if (!triggeringPlayer) {
        throw new Error("Jogador da Ãºltima aÃ§Ã£o nÃ£o encontrado.");
      }

      // Delete every message after the player action â€” those are the GM and NPC responses
      // that we want to discard.
      const messagesToDelete = room.messages.slice(lastPlayerActionIndex + 1);
      for (const message of messagesToDelete) {
        this.store.deleteMessage(roomId, message.id);
      }

      this.store.addMessage(roomId, {
        role: "system",
        kind: "system",
        authorName: "System",
        content: "ðŸ”„ O Mestre reconsidera a cena e narra novamente...",
        rawContent: "regeneration-marker",
      });

      const action: PlayerAction = {
        playerId: triggeringPlayer.id,
        content: triggeringMessage.rawContent ?? triggeringMessage.content,
      };

      const turn = await this.gmTurnGraph.invoke({
        room: this.store.getRoom(roomId)!,
        player: triggeringPlayer,
        action,
      });

      const gmResponse = this.withPlayerLanguage(triggeringPlayer, turn.response);
      const gmMessage = this.store.addMessage(roomId, {
        role: "gm",
        kind: "gm",
        authorName: "Game Master",
        content: gmResponse.ruleOutcome ? `${gmResponse.narration}\n\nRegra: ${gmResponse.ruleOutcome}` : gmResponse.narration,
        rawContent: gmResponse.narration,
      });
      this.narrateText(roomId, `regenerate-${gmMessage.id}`, gmResponse.narration, "gm-narrator", "Game Master", gmMessage.id);

      this.store.updateScene(roomId, {
        summary: gmResponse.sceneSummary,
        pendingRollRequest: gmResponse.rollRequest
          ? {
              ...gmResponse.rollRequest,
              playerName: triggeringPlayer.characterName,
              requestedAt: new Date().toISOString(),
            }
          : null,
      });

      const npcMessages = (gmResponse.npcActions ?? []).map((npcAction) => {
        const message = this.store.addMessage(roomId, {
          role: "gm",
          kind: "gm",
          authorName: npcAction.npcName,
          content: npcAction.narration,
          rawContent: npcAction.narration,
        });
        this.narrateText(roomId, `regenerate-npc-${message.id}`, npcAction.narration, "gm-narrator", npcAction.npcName, message.id);
        return message;
      });

      this.io.to(roomId).emit("room:messages", [gmMessage, ...npcMessages]);
      this.broadcastSnapshot(roomId);

      return this.store.getRoom(roomId)!;
    });
  }

  async handleAiPlayerTurn(roomId: string, requestedPlayerId?: string): Promise<RoomState> {
    return withRoomLock(roomId, async () => {
      const room = this.store.getRoom(roomId);
      if (!room) throw new Error("Room not found");
      if (room.status !== "active") {
        throw new Error("The session has not started yet.");
      }

      const turn = await this.aiPlayerGraph.invoke({ room, requestedPlayerId });
      if (!turn) {
        throw new Error("No active AI player found.");
      }

      return await this.handleActionInternal(roomId, turn.action) ?? this.store.getRoom(roomId)!;
    });
  }

  private emitPreparationStep(roomId: string, step: string, progress: number): void {
    this.io.to(roomId).emit("room:preparationStep", { step, progress });
  }

  private async runPreparation(
    roomId: string,
    hostPlayerId: string,
    openingScene: { title: string; summary: string; quest: string },
    adventureHook?: string,
    sceneKeyword?: string,
  ): Promise<void> {
    // Safety net: if preparation takes longer than 28 s (e.g. slow/unavailable LLM),
    // force-activate so players are never stuck on the loading screen indefinitely.
    const safetyTimer = setTimeout(() => {
      const room = this.store.getRoom(roomId);
      if (room?.status === "preparing") {
        console.warn("[engine] Preparation safety timeout fired â€” forcing session active.");
        this.emitPreparationStep(roomId, "Tudo pronto! A aventura comeÃ§a...", 100);
        this.store.updateStatus(roomId, "active");
        this.broadcastSnapshot(roomId);
      }
    }, 28000);

    try {
      // â”€â”€ Step 1: Announce start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      this.emitPreparationStep(roomId, "O Mestre escolhe um ponto de partida aberto...", 10);

      this.store.addMessage(roomId, {
        role: "system",
        kind: "system",
        authorName: "System",
        content: `${this.store.getRoom(roomId)?.name ?? ""} inÃ­cio de sessÃ£o. ${this.store.getRoom(roomId)?.players.map((p) => p.characterName).join(", ") ?? ""} se encontram em ${openingScene.title}.`,
        rawContent: "session-started",
      });

      // â”€â”€ Step 2: LLM preparation call â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      this.emitPreparationStep(roomId, "O Mestre prepara situacoes iniciais, sem fechar a aventura...", 28);
      const freshRoom = this.store.getRoom(roomId);
      if (!freshRoom) return;

      const imageInventory = this.imageService.getImageInventory();
      const prep = await this.janClient.runSessionPreparation(freshRoom, imageInventory, adventureHook);
      const hostPlayerForLanguage = freshRoom.players.find((p) => p.id === hostPlayerId) ?? freshRoom.players[0];
      const prepOpeningNarration = enforcePlayerGenderAgreement(prep.openingNarration, hostPlayerForLanguage);
      const prepSceneSummary = enforcePlayerGenderAgreement(prep.sceneSummary, hostPlayerForLanguage);
      const prepPartyContext = enforcePlayerGenderAgreement(prep.partyContext, hostPlayerForLanguage);

      // â”€â”€ Step 3: Seed campaign memory with lore â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      this.emitPreparationStep(roomId, "Registrando lore e memÃ³rias do mundo...", 55);

      this.store.updateScene(roomId, {
        title: prep.startingLocationTitle ?? openingScene.title,
        summary: prepSceneSummary,
        activeQuest: undefined,
        activeNpcs: prep.activeNpcs.map((npc) => {
          const isAnimalCompanion = this.isEstablishedAnimalCompanion(freshRoom, npc);
          const stats = isAnimalCompanion ? this.buildAnimalCompanionStats(npc) : buildNpcStats(npc.className ?? "Fighter", 1);
          return { ...npc, ...stats, relation: isAnimalCompanion ? "companion" as const : "scene" as const, portraitAssetUrl: undefined };
        }),
        partyContext: prepPartyContext,
        storyArc: {
          ...(freshRoom.scene.storyArc ?? createInitialStoryArc(freshRoom, adventureHook)),
          title: prep.startingLocationTitle ?? openingScene.title,
          premise: prepPartyContext || prepSceneSummary,
          phase: "opening",
          openQuestions: [
            ...((freshRoom.scene.storyArc?.openQuestions ?? []).slice(0, 2)),
            ...prep.loreHooks.slice(0, 2),
          ].slice(0, 5),
          knownClues: prep.possibleQuests.map((quest) => quest.description).slice(0, 3),
          activeThreats: prep.possibleEnemies.map((enemy) => `${enemy.name}: ${enemy.description}`).slice(0, 3),
          npcAgendas: prep.activeNpcs.map((npc) => `${npc.name}: ${npc.role}; ${npc.description}`).slice(0, 3),
        },
      });

      this.store.updateMemory(roomId, (memory) => {
        const hostPlayer = freshRoom.players.find((p) => p.id === hostPlayerId) ?? freshRoom.players[0];
        return recordCampaignTurn(
          { ...freshRoom, memory, scene: { ...freshRoom.scene, summary: prepSceneSummary } },
          hostPlayer,
          { playerId: hostPlayerId, content: "The host begins the adventure." },
          { narration: prepOpeningNarration, sceneSummary: prepSceneSummary, ruleOutcome: "Session started." },
        );
      });

      if (prepPartyContext) {
        this.store.updateMemory(roomId, (memory) => ({
          ...memory,
          entries: [
            ...memory.entries,
            {
              id: `prep-partyctx-${Date.now()}`,
              kind: "summary" as const,
              title: "Contexto do grupo",
              content: prepPartyContext,
              tags: ["party", "context", "preparation"],
              importance: 5,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        }));
      }

      for (const npc of prep.activeNpcs) {
        this.store.updateMemory(roomId, (memory) => ({
          ...memory,
          entries: [
            ...memory.entries,
            {
              id: `prep-activenpc-${Date.now()}-${Math.random()}`,
              kind: "npc" as const,
              title: npc.name,
              content: `[PRESENTE NA CENA] ${npc.role} â€” ${npc.description}`,
              tags: ["npc", "active", "presente"],
              importance: 5,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        }));
      }

      for (const enemy of prep.possibleEnemies) {
        this.store.updateMemory(roomId, (memory) => ({
          ...memory,
          entries: [
            ...memory.entries,
            {
              id: `prep-enemy-${Date.now()}-${Math.random()}`,
              kind: "event" as const,
              title: enemy.name,
              content: enemy.description,
              tags: ["enemy", "preparation"],
              importance: 3,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        }));
      }
      for (const npc of prep.possibleNpcs) {
        this.store.updateMemory(roomId, (memory) => ({
          ...memory,
          entries: [
            ...memory.entries,
            {
              id: `prep-npc-${Date.now()}-${Math.random()}`,
              kind: "npc" as const,
              title: npc.name,
              content: `${npc.role} â€” ${npc.description}`,
              tags: ["npc", "preparation"],
              importance: 3,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        }));
      }
      for (const quest of prep.possibleQuests) {
        this.store.updateMemory(roomId, (memory) => ({
          ...memory,
          entries: [
            ...memory.entries,
            {
              id: `prep-quest-${Date.now()}-${Math.random()}`,
              kind: "event" as const,
              title: `Gancho possivel: ${quest.title}`,
              content: quest.description,
              tags: ["lead", "opening", "preparation"],
              importance: 4,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ],
        }));
      }

      // â”€â”€ Step 4: Post the GM opening narration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      this.syncGraphMemory(roomId);
      this.emitPreparationStep(roomId, "O Mestre narra a cena de abertura...", 72);

      const narrationMessage = this.store.addMessage(roomId, {
        role: "gm",
        kind: "gm",
        authorName: "Game Master",
        content: prepOpeningNarration,
        rawContent: prepOpeningNarration,
      });
      this.narrateText(roomId, `opening-${narrationMessage.id}`, prepOpeningNarration, "gm-narrator", "Game Master", narrationMessage.id);

      // Generate portraits for scene NPCs from their own description and current scene.
      const preparedActiveNpcs = this.store.getRoom(roomId)?.scene.activeNpcs ?? prep.activeNpcs;
      for (const npc of preparedActiveNpcs) {
        this.createNpcPortraitImage(roomId, npc, npc.relation === "companion");
      }

      // Post scene NPC introductions so players know who is physically present now.
      if (preparedActiveNpcs.length > 0) {
        for (const npc of preparedActiveNpcs) {
          const classLine = [npc.className ?? npc.role, npc.race, npc.level ? `NÃ­vel ${npc.level}` : null].filter(Boolean).join(" Â· ");
          const relationLine = npc.relation === "companion"
            ? "Companheiro do personagem. JÃ¡ faz parte do grupo."
            : "NPC presente na cena. Ainda nÃ£o faz parte do grupo.";
          this.store.addMessage(roomId, {
            role: "gm",
            kind: "system",
            authorName: "Game Master",
            content: `**${npc.name}** (${classLine})\n${npc.description}\n\n${relationLine}`,
            rawContent: `scene-npc-intro:${npc.name}`,
          });
        }
      }

      // â”€â”€ Step 5: Queue the opening scene image â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      this.emitPreparationStep(roomId, "Pintando a cena de abertura...", 88);
      this.createSceneImage(roomId, prep.startingLocationTitle ?? openingScene.title, prep.sceneSummary, sceneKeyword, narrationMessage.id);

    } catch (error) {
      // If anything fails, still activate so players aren't stuck forever.
      console.error("Session preparation failed:", error);
    } finally {
      clearTimeout(safetyTimer);
      // â”€â”€ Step 6: Go live â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      this.emitPreparationStep(roomId, "Tudo pronto! A aventura comeÃ§a...", 100);
      this.store.updateStatus(roomId, "active");
      this.broadcastSnapshot(roomId);
    }
  }

  async handleAction(roomId: string, action: PlayerAction) {
    return withRoomLock(roomId, () => this.handleActionInternal(roomId, action));
  }

  private async handleActionInternal(roomId: string, action: PlayerAction) {
    const room = this.store.getRoom(roomId);
    if (!room) {
      throw new Error("Room not found");
    }
    if (room.status !== "active") {
      throw new Error("The session has not started yet.");
    }

    // Barge-in: ao receber nova aÃ§Ã£o, descarta Ã¡udio TTS pendente e avisa o cliente
    // pra silenciar a fila local. Audios jÃ¡ tocando no browser continuam (estÃ£o em RAM dele).
    if (this.ttsService) {
      this.ttsService.cancelAll();
      this.io.to(roomId).emit("room:gmAudioCancel", { reason: "new-action" });
    }

    const player = room.players.find((entry) => entry.id === action.playerId);
    if (!player) {
      throw new Error("Player not found");
    }

    const actionPlan = planPlayerAction(room, player, action);

    const playerMessage = this.store.addMessage(roomId, {
      role: "player",
      kind: actionPlan.kind,
      authorName: player.characterName,
      content: actionPlan.content,
      rawContent: action.content,
    });

    // Emit player message immediately so the client sees it before the LLM/combat resolves
    this.io.to(roomId).emit("room:messages", [playerMessage]);
    this.broadcastState(roomId);

    const preRuling = evaluateMechanicalRuling(room, player, action, actionPlan);
    if (preRuling.status === "denied" || preRuling.status === "resolved") {
      this.applyMechanicalRulingEffects(roomId, player.id, preRuling);
      const gmResponse = preRuling.response ? this.withPlayerLanguage(player, preRuling.response) : null;
      if (!gmResponse) {
        return this.store.getRoom(roomId);
      }
      const gmMessage = this.store.addMessage(roomId, {
        role: "gm",
        kind: "gm",
        authorName: "Game Master",
        content: gmResponse.ruleOutcome ? `${gmResponse.narration}\n\nRegra: ${gmResponse.ruleOutcome}` : gmResponse.narration,
        rawContent: gmResponse.narration,
      });
      this.narrateText(roomId, `ruling-${gmMessage.id}`, gmResponse.narration, "gm-narrator", "Game Master", gmMessage.id);
      const updatedRoom = this.store.getRoom(roomId);
      if (updatedRoom) {
        this.store.updateMemory(roomId, (memory) => recordCampaignTurn(
          { ...updatedRoom, memory, scene: { ...updatedRoom.scene, summary: gmResponse.sceneSummary } },
          player,
          action,
          gmResponse,
        ));
        this.recordPlayerLoreFromTurn(roomId, player.id, action, gmResponse);
        this.syncGraphMemory(roomId);
      }
      this.io.to(roomId).emit("room:messages", [gmMessage]);
      this.broadcastState(roomId);
      return this.store.getRoom(roomId);
    }

    if (!room.combat.active && actionPlan.shouldStartCombat) {
      this.startCombat(roomId, room, action.playerId);
    }

    if (!this.store.getRoom(roomId)?.combat.active && actionPlan.intent === "attack") {
      const gmResponse = this.withPlayerLanguage(player, {
        narration: `${player.characterName} se prepara para atacar, mas o alvo declarado nao existe de forma estabelecida nesta cena. ${room.scene.title} permanece conforme o canone atual; nenhum inimigo foi confirmado diante dele.`,
        sceneSummary: room.scene.summary,
        ruleOutcome: "Ataque recusado: jogadores nao podem criar inimigos apenas declarando ataque. O Mestre so inicia combate contra alvo presente no estado canonico da cena.",
      });
      const gmMessage = this.store.addMessage(roomId, {
        role: "gm",
        kind: "gm",
        authorName: "Game Master",
        content: `${gmResponse.narration}\n\nRegra: ${gmResponse.ruleOutcome}`,
        rawContent: gmResponse.narration,
      });
      this.narrateText(roomId, `attack-denied-${gmMessage.id}`, gmResponse.narration, "gm-narrator", "Game Master", gmMessage.id);
      this.store.updateMemory(roomId, (memory) => recordCampaignTurn(
        { ...room, memory },
        player,
        action,
        gmResponse,
      ));
      this.recordPlayerLoreFromTurn(roomId, player.id, action, gmResponse);
      this.syncGraphMemory(roomId);
      this.io.to(roomId).emit("room:messages", [gmMessage]);
      this.broadcastState(roomId);
      return this.store.getRoom(roomId);
    }

    if (this.store.getRoom(roomId)?.combat.active && actionPlan.intent === "attack") {
      const combatResolution = this.requestCombatAttackRoll(roomId, action.playerId, actionPlan.content);
      const gmMessage = this.store.addMessage(roomId, {
        role: "gm",
        kind: "gm",
        authorName: "Game Master",
        content: `${combatResolution.narration}\n\nRegra: ${combatResolution.ruleOutcome}`,
        rawContent: combatResolution.narration,
      });
      this.narrateText(roomId, `combat-pending-${gmMessage.id}`, combatResolution.narration, "gm-narrator", "Game Master", gmMessage.id);

      const roomAfterCombat = this.store.getRoom(roomId);
      if (roomAfterCombat) {
        this.store.updateMemory(roomId, (memory) => recordCampaignTurn(
          { ...roomAfterCombat, memory },
          player,
          action,
          {
            narration: combatResolution.narration,
            sceneSummary: roomAfterCombat.scene.summary,
            ruleOutcome: combatResolution.ruleOutcome,
          },
        ));
        this.recordPlayerLoreFromTurn(roomId, player.id, action, {
          narration: combatResolution.narration,
          sceneSummary: roomAfterCombat.scene.summary,
          ruleOutcome: combatResolution.ruleOutcome,
        });
        this.syncGraphMemory(roomId);
      }

      this.io.to(roomId).emit("room:messages", [gmMessage]);
      this.broadcastState(roomId);
      return this.store.getRoom(roomId);
    }

    const streamId = nanoid();
    this.io.to(roomId).emit("room:gmStream", {
      streamId,
      status: "start",
      authorName: "Game Master",
    });

    // Buffer de frases para o TTS: acumula chunks do stream e dispara sÃ­ntese
    // assim que detecta limite de frase. SÃ­ntese acontece em paralelo ao stream.
    let turn: Awaited<ReturnType<typeof this.gmTurnGraph.invoke>>;
    try {
      turn = await this.gmTurnGraph.invoke({
        room,
        player,
        action,
        onNarrationChunk: (chunk) => {
          this.io.to(roomId).emit("room:gmStream", {
            streamId,
            status: "chunk",
            chunk,
          });
        },
      });
    } catch (error) {
      this.io.to(roomId).emit("room:gmStream", { streamId, status: "done" });
      throw error;
    }
    let gmResponse = this.withPlayerLanguage(player, turn.response);
    gmResponse = enforceRollRequestConsistency(room, player, action, turn.actionPlan, gmResponse);
    if (turn.mechanicalRuling) {
      this.applyMechanicalRulingEffects(roomId, player.id, turn.mechanicalRuling);
    }
    if (turn.relevantMemories.length > 0) {
      this.store.updateMemory(roomId, (memory) => applyRetrievedMemoryTouches(memory, turn.relevantMemories));
    }
    const gmMessage = this.store.addMessage(roomId, {
      role: "gm",
      kind: "gm",
      authorName: "Game Master",
      content: gmResponse.ruleOutcome ? `${gmResponse.narration}\n\nRegra: ${gmResponse.ruleOutcome}` : gmResponse.narration,
      rawContent: gmResponse.narration,
    });
    this.narrateText(roomId, `gm-${gmMessage.id}`, gmResponse.narration, "gm-narrator", "Game Master", gmMessage.id);
    const visualCorrection = this.shouldQueueSceneImageCorrection(room, actionPlan.content);

    // Save pending roll request to scene if GM is asking for a dice roll
    const pendingRollUpdate = gmResponse.rollRequest
      ? {
          summary: gmResponse.sceneSummary,
          pendingRollRequest: {
            ...gmResponse.rollRequest,
            playerName: player.characterName,
            requestedAt: new Date().toISOString(),
          },
        }
      : { summary: gmResponse.sceneSummary, pendingRollRequest: null };
    this.store.updateScene(roomId, pendingRollUpdate);

    // Apply NPC health/status updates reported by the GM
    if (gmResponse.npcHealthUpdates && gmResponse.npcHealthUpdates.length > 0) {
      const sceneNow = this.store.getRoom(roomId)?.scene;
      if (sceneNow?.activeNpcs) {
        const updatedNpcs = sceneNow.activeNpcs.map((npc) => {
          const update = gmResponse.npcHealthUpdates!.find((u) => u.npcName.toLowerCase() === npc.name.toLowerCase());
          return update ? { ...npc, hitPoints: update.hitPoints, status: update.status } : npc;
        });
        this.store.updateScene(roomId, { activeNpcs: updatedNpcs });
      }
    }

    const updatedRoom = this.store.getRoom(roomId);
    if (updatedRoom) {
      this.store.updateMemory(roomId, (memory) => recordCampaignTurn(
        { ...updatedRoom, memory, scene: { ...updatedRoom.scene, summary: gmResponse.sceneSummary } },
        player,
        action,
        gmResponse,
      ));
      this.store.updateScene(roomId, { storyArc: updateStoryArcFromTurn(updatedRoom, player, action, gmResponse) });
      this.recordPlayerLoreFromTurn(roomId, player.id, action, gmResponse);
      this.syncGraphMemory(roomId);
    }

    // Fire-and-forget: if campaign memory has grown past the comfort window,
    // ask the LLM to compress old events into a rolling summary. This prevents
    // long sessions from drowning the GM prompt in stale event entries.
    void this.maybeSummarizeMemory(roomId);

    // Handle NPCs joining the party mid-adventure
    if (gmResponse.joiningNpcs && gmResponse.joiningNpcs.length > 0) {
      const currentScene = this.store.getRoom(roomId)?.scene;
      const existingNpcs = currentScene?.activeNpcs ?? [];
      const newNpcs = gmResponse.joiningNpcs.filter((n) => !existingNpcs.some((e) => e.name === n.name));
      if (newNpcs.length > 0) {
        const newNpcsWithStats = newNpcs.map((npc) => {
          const stats = buildNpcStats(npc.className ?? "Fighter", npc.level ?? 1);
          return { ...npc, ...stats, relation: "companion" as const, portraitAssetUrl: undefined };
        });
        this.store.updateScene(roomId, { activeNpcs: [...existingNpcs, ...newNpcsWithStats] });
        for (const npc of newNpcsWithStats) {
          this.store.addMessage(roomId, {
            role: "system",
            kind: "system",
            authorName: "System",
            content: `${npc.name} (${npc.race ?? ""} ${npc.className ?? npc.role} nÃ­vel ${npc.level ?? 1}) se juntou ao grupo.`,
            rawContent: `npc-joined:${npc.name}`,
          });
          if (!npc.portraitAssetUrl) {
            this.createNpcPortraitImage(roomId, npc, true);
          }
        }
      }
    }
    /*
      this.store.updatePlayer(roomId, player.id, (current) => {
        const resource = current.resources.limited[resourceUse.key];
        const updatedResource = resource
          ? { ...resource, used: Math.min(resource.max, resource.used + 1) }
          : undefined;
        return {
          ...current,
          hitPoints: resourceUse.heal ? Math.min(current.maxHitPoints, current.hitPoints + resourceUse.heal) : current.hitPoints,
          resources: {
            ...current.resources,
            limited: updatedResource
              ? { ...current.resources.limited, [resourceUse.key]: updatedResource }
              : current.resources.limited,
          },
        };
      });
    }
    if (turn.mechanicalRuling?.resourceRecovery) {
      const recovery = turn.mechanicalRuling.resourceRecovery;
      this.store.updatePlayer(roomId, player.id, (current) => {
        const limited = Object.fromEntries(Object.entries(current.resources.limited).map(([key, resource]) => [
          key,
          recovery === "long_rest" || resource.recovery === "short_rest" ? { ...resource, used: 0 } : resource,
        ]));
        return {
          ...current,
          resources: {
            ...current.resources,
            limited,
            conditions: recovery === "long_rest" ? [] : current.resources.conditions,
          },
        };
      });
    }
    if (turn.relevantMemories.length > 0) {
      this.store.updateMemory(roomId, (memory) => applyRetrievedMemoryTouches(memory, turn.relevantMemories));
    }
    const gmMessage = this.store.addMessage(roomId, {
      role: "gm",
      kind: "gm",
      authorName: "Game Master",
      content: gmResponse.ruleOutcome ? `${gmResponse.narration}\n\nRegra: ${gmResponse.ruleOutcome}` : gmResponse.narration,
      rawContent: gmResponse.narration,
    });

    // Save pending roll request to scene if GM is asking for a dice roll
    const pendingRollUpdate = gmResponse.rollRequest
      ? {
          summary: gmResponse.sceneSummary,
          pendingRollRequest: {
            ...gmResponse.rollRequest,
            playerName: player.characterName,
            requestedAt: new Date().toISOString(),
          },
        }
      : { summary: gmResponse.sceneSummary, pendingRollRequest: null };
    this.store.updateScene(roomId, pendingRollUpdate);

    // Apply NPC health/status updates reported by the GM
    if (gmResponse.npcHealthUpdates && gmResponse.npcHealthUpdates.length > 0) {
      const sceneNow = this.store.getRoom(roomId)?.scene;
      if (sceneNow?.activeNpcs) {
        const updatedNpcs = sceneNow.activeNpcs.map((npc) => {
          const update = gmResponse.npcHealthUpdates!.find((u) => u.npcName.toLowerCase() === npc.name.toLowerCase());
          return update ? { ...npc, hitPoints: update.hitPoints, status: update.status } : npc;
        });
        this.store.updateScene(roomId, { activeNpcs: updatedNpcs });
      }
    }

    const updatedRoom = this.store.getRoom(roomId);
    if (updatedRoom) {
      this.store.updateMemory(roomId, (memory) => recordCampaignTurn(
        { ...updatedRoom, memory, scene: { ...updatedRoom.scene, summary: gmResponse.sceneSummary } },
        player,
        action,
        gmResponse,
      ));
      this.syncGraphMemory(roomId);
    }

    // Fire-and-forget: if campaign memory has grown past the comfort window,
    // ask the LLM to compress old events into a rolling summary. This prevents
    // long sessions from drowning the GM prompt in stale event entries.
    void this.maybeSummarizeMemory(roomId);

    // Handle NPCs joining the party mid-adventure
    if (gmResponse.joiningNpcs && gmResponse.joiningNpcs.length > 0) {
      const currentScene = this.store.getRoom(roomId)?.scene;
      const existingNpcs = currentScene?.activeNpcs ?? [];
      const newNpcs = gmResponse.joiningNpcs.filter((n) => !existingNpcs.some((e) => e.name === n.name));
      if (newNpcs.length > 0) {
        const newNpcsWithStats = newNpcs.map((npc) => {
          const stats = buildNpcStats(npc.className ?? "Fighter", npc.level ?? 1);
          return { ...npc, ...stats, relation: "companion" as const, portraitAssetUrl: undefined };
        });
        this.store.updateScene(roomId, { activeNpcs: [...existingNpcs, ...newNpcsWithStats] });
        for (const npc of newNpcsWithStats) {
          this.store.addMessage(roomId, {
            role: "system",
            kind: "system",
            authorName: "System",
            content: `${npc.name} (${npc.race ?? ""} ${npc.className ?? npc.role} nÃ­vel ${npc.level ?? 1}) se juntou ao grupo.`,
            rawContent: `npc-joined:${npc.name}`,
          });
          if (!npc.portraitAssetUrl) {
            this.createNpcPortraitImage(roomId, npc, false);
          }
        }
      }
    }

    */
    // Post individual NPC action messages (each NPC narrates itself).
    // Cada NPC ganha sua prÃ³pria voz inferida do role/className/race.
    const activeNpcs = this.store.getRoom(roomId)?.scene.activeNpcs ?? [];
    const npcMessages = (gmResponse.npcActions ?? []).map((npcAction) => {
      const message = this.store.addMessage(roomId, {
        role: "gm",
        kind: "gm",
        authorName: npcAction.npcName,
        content: npcAction.narration,
        rawContent: npcAction.narration,
      });
      const matchingNpc: Pick<SceneNpc, "name" | "role" | "className" | "race" | "description"> | undefined =
        activeNpcs.find((entry) => entry.name.toLowerCase() === npcAction.npcName.toLowerCase());
      const voiceProfile: VoiceProfile = matchingNpc ? inferVoiceProfile(matchingNpc) : "gm-narrator";
      // NPCs ganham um stream-id prÃ³prio por fala (nÃ£o buferiza entre frases do NPC).
      this.narrateText(roomId, `npc-${message.id}`, npcAction.narration, voiceProfile, npcAction.npcName, message.id);
      return message;
    });

    const explicitImageRequest = this.isExplicitImageRequest(actionPlan.content, gmResponse);

    // Limit to 1 image job per player action to avoid overloading CPU.
    // Explicit requests like "mostra uma imagem desse monstro" are routed
    // deterministically below, because OOC/question turns normally suppress
    // model-generated imageJobs.
    const imageJobs = config.textOnly || visualCorrection || explicitImageRequest ? [] : gmResponse.imageJobs;
    const jobs = this.store.addImageJobs(roomId, imageJobs.slice(0, 1).map((j) => ({ ...j, messageId: gmMessage.id })));
    if (visualCorrection) {
      this.store.updateMemory(roomId, (memory) => ({
        ...memory,
        entries: [
          ...memory.entries,
          {
            id: `visual-correction-${Date.now()}`,
            kind: "event" as const,
            title: "Correcao visual da cena",
            content: `O jogador apontou incoerencia visual. O canone confirmado permanece: ${room.scene.title} - ${room.scene.summary}`,
            tags: ["imagem", "correcao", "canone"],
            importance: 4,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      }));
      this.createSceneImage(roomId, room.scene.title, room.scene.summary, undefined, gmMessage.id);
    }
    if (explicitImageRequest && !visualCorrection) {
      this.createRequestedVisualImage(roomId, room, actionPlan.content, gmMessage.id);
    }

    this.io.to(roomId).emit("room:messages", [gmMessage, ...npcMessages]);
    this.broadcastState(roomId);

    // Queue image rendering serially â€” one image at a time
    for (const job of jobs) {
      const jobSnapshot = job;
      this.resolveCachedOrScheduleGenerated(roomId, jobSnapshot);
    }

    return this.store.getRoom(roomId);
  }

  private applyMechanicalRulingEffects(roomId: string, playerId: string, ruling?: MechanicalRuling): void {
    if (!ruling) return;

    if (ruling.resourceUse) {
      const resourceUse = ruling.resourceUse;
      this.store.updatePlayer(roomId, playerId, (current) => {
        const resource = current.resources.limited[resourceUse.key];
        const updatedResource = resource ? { ...resource, used: Math.min(resource.max, resource.used + 1) } : undefined;
        return {
          ...current,
          hitPoints: resourceUse.heal ? Math.min(current.maxHitPoints, current.hitPoints + resourceUse.heal) : current.hitPoints,
          resources: {
            ...current.resources,
            limited: updatedResource ? { ...current.resources.limited, [resourceUse.key]: updatedResource } : current.resources.limited,
          },
        };
      });
    }

    if (ruling.resourceRecovery) {
      const recovery = ruling.resourceRecovery;
      this.store.updatePlayer(roomId, playerId, (current) => {
        const limited = Object.fromEntries(Object.entries(current.resources.limited).map(([key, resource]) => [
          key,
          recovery === "long_rest" || resource.recovery === "short_rest" ? { ...resource, used: 0 } : resource,
        ]));
        return {
          ...current,
          hitPoints: recovery === "long_rest" ? current.maxHitPoints : current.hitPoints,
          resources: {
            ...current.resources,
            limited,
            conditions: recovery === "long_rest" ? [] : current.resources.conditions,
          },
        };
      });
    }
  }

  private startCombat(roomId: string, room: RoomState, triggeringPlayerId: string): void {
    const averageLevel = Math.max(1, Math.round(room.players.reduce((sum, player) => sum + player.level, 0) / Math.max(1, room.players.length)));
    const sceneContext = [
      room.scene.title,
      room.scene.summary,
      room.scene.activeQuest,
      room.scene.partyContext,
      room.memory.summary,
      ...room.memory.entries.slice(-6).map((entry) => entry.content),
    ].filter(Boolean).join(" ");
    const enemyProfiles = buildEnemyGroup(room.players.length, averageLevel, room.setup.enemyDifficulty, room.setup.battleIntensity, sceneContext);
    const enemies: EnemyState[] = enemyProfiles.map((profile) => ({
      id: nanoid(),
      catalogId: profile.id,
      name: profile.name,
      hitPoints: profile.hitPoints,
      maxHitPoints: profile.hitPoints,
      threat: profile.threat,
      xpValue: profile.xpValue,
      armorClass: profile.armorClass ?? 11 + profile.threat,
      challengeRating: profile.challengeRating,
      kind: profile.kind,
      abilities: profile.abilities,
      traits: profile.traits,
      actions: profile.actions,
      description: profile.description,
    }));

    const playerOrder: CombatActor[] = room.players
      .map((player) => ({
        id: nanoid(),
        actorId: player.id,
        actorName: player.characterName,
        side: "player" as const,
        initiative: rollDie(20) + player.attributes.agility,
      }))
      .sort((left, right) => right.initiative - left.initiative);

    const enemyEntries: CombatActor[] = enemies.map((enemy) => ({
      id: nanoid(),
      actorId: enemy.id,
      actorName: enemy.name,
      side: "enemy" as const,
      initiative: rollDie(20) + enemy.threat,
    }));

    // Interleave by initiative so faster enemies act before slow players, matching D&D5e.
    const order: CombatActor[] = [...playerOrder, ...enemyEntries].sort((left, right) => right.initiative - left.initiative);

    const triggeringTurnIndex = Math.max(0, order.findIndex((entry) => entry.actorId === triggeringPlayerId));
    const enemyLabel = enemies.length === 1 ? enemies[0].name : `${enemies.length} inimigos (${enemies.map((e) => e.name).join(", ")})`;

    const combat: CombatState = {
      active: true,
      round: 1,
      currentTurnIndex: triggeringTurnIndex,
      order,
      enemies,
      log: [`Combate iniciado contra ${enemyLabel}.`],
      lastOutcome: `${order[triggeringTurnIndex]?.actorName ?? order[0]?.actorName} age primeiro.`,
    };

    this.store.updateCombat(roomId, combat);
    this.store.updateScene(roomId, {
      combatRound: 1,
      summary: `${room.scene.title}: o perigo irrompe quando ${enemyLabel} atacam o grupo.`,
    });

    const combatSystemMessage = this.store.addMessage(roomId, {
      role: "system",
      kind: "system",
      authorName: "System",
      content: `Combate iniciado contra ${enemyLabel}. Ordem de iniciativa: ${order.map((entry) => `${entry.actorName} (${entry.initiative})`).join(", ")}.`,
      rawContent: `Combate iniciado contra ${enemyLabel}`,
    });

    // One combat image per encounter, focused on the lead enemy or group.
    this.createCombatImage(roomId, enemies[0], room.scene.title, combatSystemMessage.id);
  }

  private requestCombatAttackRoll(roomId: string, playerId: string, content: string): { narration: string; ruleOutcome: string } {
    const room = this.store.getRoom(roomId);
    if (!room || !room.combat.active) {
      return {
        narration: "O campo de batalha fica estranhamente quieto.",
        ruleOutcome: "O combate nao estava ativo.",
      };
    }

    const combat = room.combat;
    const aliveEnemies = combat.enemies.filter((enemy) => enemy.hitPoints > 0);
    if (aliveEnemies.length === 0) {
      return {
        narration: "A presenca inimiga ja se dissipou do campo de batalha.",
        ruleOutcome: "Nao restam inimigos ativos no combate.",
      };
    }

    const currentActor = combat.order[combat.currentTurnIndex];
    const player = room.players.find((entry) => entry.id === playerId);
    if (!player) {
      throw new Error("Player not found");
    }

    if (!currentActor || currentActor.side !== "player" || currentActor.actorId !== playerId) {
      return {
        narration: `${player.characterName} precisa aguardar enquanto ${currentActor?.actorName ?? "o combate"} resolve o turno atual.`,
        ruleOutcome: "Acao recusada porque nao e o turno deste jogador.",
      };
    }

    const targetMismatch = this.findDeclaredTargetMismatch(aliveEnemies, content);
    if (targetMismatch) {
      return {
        narration: `${player.characterName} procura ${targetMismatch} para atacar, mas esse alvo nao esta entre os inimigos ativos. Os inimigos confirmados sao: ${aliveEnemies.map((enemy) => enemy.name).join(", ")}.`,
        ruleOutcome: `Ataque recusado: ${targetMismatch} nao e alvo valido neste combate.`,
      };
    }

    // Try to honour an explicit target named in the action text; otherwise hit the lowest-HP foe.
    const lowered = content.toLowerCase();
    const targetEnemy = aliveEnemies.find((enemy) => lowered.includes(enemy.name.toLowerCase()))
      ?? aliveEnemies.slice().sort((a, b) => a.hitPoints - b.hitPoints)[0];

    const attackModifier = this.attackModifier(player, content);
    const targetNumber = targetEnemy.armorClass ?? 11 + targetEnemy.threat;
    const damageSpec = this.damageSpecForAction(player, content);
    const attackSkill = this.isRangedAttack(content) ? "Ataque a distancia" : "Ataque corpo a corpo";
    const advantage = this.attackHasAdvantage(room, player, content) ? "advantage" as const : null;
    const hunterMarkActive = this.hasHuntersMarkDamage(room, player, targetEnemy, content);
    this.store.updateScene(roomId, {
      pendingRollRequest: {
        kind: "combat_attack",
        playerName: player.characterName,
        requestedAt: new Date().toISOString(),
        skill: attackSkill,
        die: "d20",
        modifier: attackModifier,
        difficulty: targetNumber,
        description: `Ataque de ${player.characterName} contra ${targetEnemy.name} (CA ${targetNumber})${advantage ? " com vantagem" : ""}`,
        advantage,
        targetEnemyId: targetEnemy.id,
        targetEnemyName: targetEnemy.name,
        sourceAction: content,
        damageDie: damageSpec.die,
        damageDiceCount: 1,
        damageModifier: damageSpec.modifier,
        damageType: damageSpec.type,
        extraDamageDie: hunterMarkActive ? "d6" : undefined,
        extraDamageDiceCount: hunterMarkActive ? 1 : undefined,
        extraDamageLabel: hunterMarkActive ? "Marca do Caçador" : undefined,
      },
    });
    const rollText = advantage
      ? `Role 2d20 ${this.formatModifier(attackModifier)} de ${attackSkill} com vantagem contra CD ${targetNumber}; use o maior d20.`
      : `Role 1d20 ${this.formatModifier(attackModifier)} de ${attackSkill} contra CD ${targetNumber}.`;
    return {
      narration: `${player.characterName} se prepara para atacar ${targetEnemy.name}. Antes de declarar acerto ou dano, a mesa precisa da rolagem. ${rollText}`,
      ruleOutcome: `Ataque pendente: nenhum dano foi aplicado. Alvo: ${targetEnemy.name}.${advantage ? " Vantagem aplicada porque Jeremiah estava oculto e o alvo ainda nao havia detectado sua posicao." : ""}${hunterMarkActive ? " Marca do Caçador ativa: se acertar, haverá dano extra de 1d6." : ""}`,
    };
    /*
    const attackRoll = rollDie(20) + attackModifier;
    let narration: string;
    let ruleOutcome: string;
    const combatLog = [...combat.log];
    const updatedEnemies: EnemyState[] = combat.enemies.map((enemy) => ({ ...enemy }));
    const updatedTarget = updatedEnemies.find((enemy) => enemy.id === targetEnemy.id)!;

    if (attackRoll >= targetNumber) {
      const damage = rollDie(8) + player.attributes.strength;
      updatedTarget.hitPoints = Math.max(0, updatedTarget.hitPoints - damage);
      narration = `${player.characterName} acerta ${updatedTarget.name} com firmeza, causando ${damage} de dano.`;
      ruleOutcome = `Ataque ${attackRoll} vs CD ${targetNumber}, dano ${damage}.`;
      combatLog.push(`${player.characterName} acertou ${updatedTarget.name} e causou ${damage} de dano.`);
    } else {
      narration = `${player.characterName} se compromete com o ataque, mas ${updatedTarget.name} desvia o golpe.`;
      ruleOutcome = `Ataque ${attackRoll} vs CD ${targetNumber}: falha.`;
      combatLog.push(`${player.characterName} errou ${updatedTarget.name}.`);
    }

    let postNarration = narration;
    let updatedOrder = combat.order;

    // If the targeted enemy fell, remove it from the initiative order and announce it.
    if (updatedTarget.hitPoints <= 0) {
      combatLog.push(`${updatedTarget.name} was defeated.`);
      postNarration = `${narration} ${updatedTarget.name} colapsa no chÃ£o.`;
      updatedOrder = combat.order.filter((entry) => entry.actorId !== updatedTarget.id);
    }

    const remainingAliveEnemies = updatedEnemies.filter((enemy) => enemy.hitPoints > 0);

    if (remainingAliveEnemies.length === 0) {
      const resolvedCombat: CombatState = {
        active: false,
        round: combat.round,
        currentTurnIndex: 0,
        order: [],
        enemies: updatedEnemies,
        log: combatLog,
        lastOutcome: `${player.characterName} encerrou o combate.`,
      };
      this.store.updateCombat(roomId, resolvedCombat);
      this.store.updateScene(roomId, {
        combatRound: undefined,
        summary: `${room.scene.title}: o grupo sobrevive ao confronto e retoma o controle da cena.`,
      });
      return {
        narration: `${postNarration} O grupo sobrevive ao confronto e retoma o controle da cena.`,
        ruleOutcome,
      };
    }

    const afterPlayerTurn = this.advanceCombat({ ...combat, enemies: updatedEnemies, order: updatedOrder, log: combatLog, lastOutcome: ruleOutcome });
    const upcomingActor = afterPlayerTurn.order[afterPlayerTurn.currentTurnIndex];
    const enemyResolution = upcomingActor?.side === "enemy"
      ? this.resolveEnemyTurn(afterPlayerTurn, room.players)
      : {
          combat: afterPlayerTurn,
          players: room.players,
          narration: "O restante do grupo se posiciona para o proximo turno.",
          ruleOutcome: "O inimigo ainda nao agiu.",
          summary: "o grupo se reposiciona e prepara o proximo golpe",
        };
    const finalCombat = upcomingActor?.side === "enemy" ? this.advanceCombat(enemyResolution.combat) : enemyResolution.combat;

    this.store.updateCombat(roomId, finalCombat);
    this.store.updatePlayers(roomId, () => enemyResolution.players);
    this.store.updateScene(roomId, {
      combatRound: finalCombat.round,
      summary: `${room.scene.title}: ${enemyResolution.summary}`,
    });

    return {
      narration: `${postNarration} ${enemyResolution.narration} PrÃ³ximo turno: ${finalCombat.order[finalCombat.currentTurnIndex]?.actorName ?? "party"}.`,
      ruleOutcome: `${ruleOutcome} Turno inimigo: ${enemyResolution.ruleOutcome}`,
    };
    */
  }

  private resolveEnemyTurn(combat: CombatState, players: Player[]): { combat: CombatState; players: Player[]; narration: string; ruleOutcome: string; summary: string } {
    const currentActor = combat.order[combat.currentTurnIndex];
    const acting = combat.enemies.find((enemy) => enemy.id === currentActor?.actorId && enemy.hitPoints > 0);

    if (!currentActor || currentActor.side !== "enemy" || !acting) {
      return {
        combat,
        players,
        narration: "O inimigo hesita e perde o impulso.",
        ruleOutcome: "Turno do inimigo ignorado.",
        summary: "o inimigo vacila sob pressao",
      };
    }

    const alivePlayers = players.filter((player) => player.hitPoints > 0);
    const target = alivePlayers[0] ?? players[0];
    if (!target) {
      return {
        combat,
        players,
        narration: "Nenhum heroi permanece de pe para receber o golpe.",
        ruleOutcome: "O inimigo nao tem alvo valido.",
        summary: "o campo de batalha fica estranhamente quieto",
      };
    }

    const primaryAction = acting.actions?.[0];
    const attackBonus = primaryAction?.attackBonus ?? acting.threat;
    const d20 = rollDie(20);
    const attackRoll = d20 + attackBonus;
    const targetNumber = target.armorClass;
    const updatedPlayers = players.map((player) => ({ ...player }));
    const victim = updatedPlayers.find((player) => player.id === target.id)!;

    if (d20 !== 1 && (d20 === 20 || attackRoll >= targetNumber)) {
      const damage = this.rollEnemyDamage(acting);
      victim.hitPoints = Math.max(0, victim.hitPoints - damage);
      return {
        combat: {
          ...combat,
          log: [...combat.log, `${acting.name} acertou ${victim.characterName} e causou ${damage} de dano.`],
          lastOutcome: `${acting.name} acertou ${victim.characterName}.`,
        },
        players: updatedPlayers,
        narration: `${acting.name} usa ${primaryAction?.name ?? "ataque"} e fere ${victim.characterName}, causando ${damage} PV.`,
        ruleOutcome: `Ataque do inimigo: d20 ${d20} ${this.formatModifier(attackBonus)} = ${attackRoll} vs CA ${targetNumber}: acerto. Dano ${damage}.`,
        summary: `${acting.name} pressiona ${victim.characterName}`,
      };
    }

    return {
      combat: {
        ...combat,
        log: [...combat.log, `${acting.name} errou ${victim.characterName}.`],
        lastOutcome: `${acting.name} errou ${victim.characterName}.`,
      },
      players: updatedPlayers,
      narration: `${acting.name} usa ${primaryAction?.name ?? "ataque"}, mas ${victim.characterName} evita o golpe.`,
      ruleOutcome: `Ataque do inimigo: d20 ${d20} ${this.formatModifier(attackBonus)} = ${attackRoll} vs CA ${targetNumber}: falha.`,
      summary: `${victim.characterName} mantem a formacao`,
    };
  }

  private resolveCombatRoll(roomId: string, player: Player, pendingRoll: PendingRollRequest, total: number, meta: CombatRollMeta = {}): void {
    if (pendingRoll.kind === "combat_attack") {
      this.resolveCombatAttackRoll(roomId, player, pendingRoll, total, meta);
      return;
    }
    if (pendingRoll.kind === "combat_damage") {
      this.resolveCombatDamageRoll(roomId, player, pendingRoll, total);
      return;
    }
    if (pendingRoll.kind === "combat_defense") {
      this.resolveCombatDefenseRoll(roomId, player, pendingRoll, total);
    }
  }

  private resolveCombatAttackRoll(roomId: string, player: Player, pendingRoll: PendingRollRequest, total: number, meta: CombatRollMeta = {}): void {
    const room = this.store.getRoom(roomId);
    if (!room || !room.combat.active) return;
    const target = room.combat.enemies.find((enemy) => enemy.id === pendingRoll.targetEnemyId && enemy.hitPoints > 0)
      ?? room.combat.enemies.find((enemy) => enemy.hitPoints > 0);
    if (!target) return;

    if (total >= pendingRoll.difficulty) {
      const damageDie = pendingRoll.damageDie ?? "d8";
      const damageDiceCount = (pendingRoll.damageDiceCount ?? 1) * (meta.critical ? 2 : 1);
      const extraDamageDiceCount = pendingRoll.extraDamageDie
        ? (pendingRoll.extraDamageDiceCount ?? 1) * (meta.critical ? 2 : 1)
        : undefined;
      const damageModifier = pendingRoll.damageModifier ?? 0;
      this.store.updateScene(roomId, {
        pendingRollRequest: {
          kind: "combat_damage",
          playerName: player.characterName,
          requestedAt: new Date().toISOString(),
          skill: "Dano da arma",
          die: damageDie,
          diceCount: damageDiceCount,
          modifier: damageModifier,
          difficulty: 0,
          description: `Dano de ${player.characterName} contra ${target.name}${meta.critical ? " (crítico)" : ""}`,
          targetEnemyId: target.id,
          targetEnemyName: target.name,
          sourceAction: pendingRoll.sourceAction,
          damageDie,
          damageDiceCount,
          damageModifier,
          damageType: pendingRoll.damageType,
          extraDamageDie: pendingRoll.extraDamageDie,
          extraDamageDiceCount,
          extraDamageLabel: pendingRoll.extraDamageLabel,
        },
      });
      const bonusDamageText = pendingRoll.extraDamageDie
        ? ` Depois role ${extraDamageDiceCount}${pendingRoll.extraDamageDie} de ${pendingRoll.extraDamageLabel ?? "dano extra"}.`
        : "";
      this.addGmCombatMessage(
        roomId,
        `${player.characterName} encontra uma abertura em ${target.name}.${meta.critical ? " O d20 natural foi 20: este ataque e critico." : ""} O golpe ainda nao causa dano ate a rolagem de dano ser feita. Role ${damageDiceCount}${damageDie} ${this.formatModifier(damageModifier)} de dano.${bonusDamageText}`,
        `Ataque ${total} vs CD ${pendingRoll.difficulty}: acerto${meta.critical ? " critico" : ""}. Dano pendente.${pendingRoll.extraDamageDie ? ` ${pendingRoll.extraDamageLabel ?? "Dano extra"} pendente.` : ""}`,
      );
      return;
    }

    const afterMiss = this.advanceCombat({
      ...room.combat,
      log: [...room.combat.log, `${player.characterName} errou ${target.name}.`],
      lastOutcome: `${player.characterName} errou ${target.name}.`,
    });
    this.store.updateCombat(roomId, afterMiss);
    this.store.updateScene(roomId, {
      combatRound: afterMiss.round,
      summary: `${room.scene.title}: ${player.characterName} atacou ${target.name}, mas nao encontrou abertura.`,
    });
    this.continueCombatAfterTurn(roomId, `${player.characterName} ataca, mas ${target.name} desvia no ultimo instante.`, `Ataque ${total} vs CD ${pendingRoll.difficulty}: falha.`);
  }

  private resolveCombatDamageRoll(roomId: string, player: Player, pendingRoll: PendingRollRequest, total: number): void {
    const room = this.store.getRoom(roomId);
    if (!room || !room.combat.active) return;
    const combat = room.combat;
    const updatedEnemies = combat.enemies.map((enemy) => ({ ...enemy }));
    const target = updatedEnemies.find((enemy) => enemy.id === pendingRoll.targetEnemyId && enemy.hitPoints > 0)
      ?? updatedEnemies.find((enemy) => enemy.hitPoints > 0);
    if (!target) return;

    const damage = Math.max(0, total);
    target.hitPoints = Math.max(0, target.hitPoints - damage);
    const damageLabel = pendingRoll.isBonusDamage ? (pendingRoll.extraDamageLabel ?? "dano extra") : "dano";
    const log = [...combat.log, `${player.characterName} causou ${damage} de ${damageLabel} em ${target.name}.`];
    let order = combat.order;
    let narration = pendingRoll.isBonusDamage
      ? `${pendingRoll.extraDamageLabel ?? "O dano extra"} de ${player.characterName} consome ${target.name}, causando mais ${damage} de dano${pendingRoll.damageType ? ` ${pendingRoll.damageType}` : ""}.`
      : `${player.characterName} atinge ${target.name} e causa ${damage} de dano${pendingRoll.damageType ? ` ${pendingRoll.damageType}` : ""}.`;

    if (!pendingRoll.isBonusDamage && pendingRoll.extraDamageDie && target.hitPoints > 0) {
      const bonusDiceCount = pendingRoll.extraDamageDiceCount ?? 1;
      this.store.updateCombat(roomId, { ...combat, enemies: updatedEnemies, log, lastOutcome: `Dano ${damage} em ${target.name}; dano extra pendente.` });
      this.store.updateScene(roomId, {
        pendingRollRequest: {
          kind: "combat_damage",
          playerName: player.characterName,
          requestedAt: new Date().toISOString(),
          skill: pendingRoll.extraDamageLabel ?? "Dano extra",
          die: pendingRoll.extraDamageDie,
          diceCount: bonusDiceCount,
          modifier: 0,
          difficulty: 0,
          description: `${pendingRoll.extraDamageLabel ?? "Dano extra"} contra ${target.name}`,
          targetEnemyId: target.id,
          targetEnemyName: target.name,
          sourceAction: pendingRoll.sourceAction,
          damageDie: pendingRoll.extraDamageDie,
          damageDiceCount: bonusDiceCount,
          damageModifier: 0,
          damageType: pendingRoll.damageType,
          extraDamageLabel: pendingRoll.extraDamageLabel,
          isBonusDamage: true,
        },
        summary: `${room.scene.title}: ${player.characterName} acertou ${target.name}; dano extra pendente.`,
      });
      this.addGmCombatMessage(
        roomId,
        `${narration} A ${pendingRoll.extraDamageLabel ?? "fonte de dano extra"} ainda precisa ser rolada antes do inimigo agir. Role ${bonusDiceCount}${pendingRoll.extraDamageDie}.`,
        `Dano da arma aplicado: ${damage}. ${pendingRoll.extraDamageLabel ?? "Dano extra"} pendente.`,
      );
      return;
    }

    if (target.hitPoints <= 0) {
      log.push(`${target.name} foi derrotado.`);
      order = combat.order.filter((entry) => entry.actorId !== target.id);
      narration += ` ${target.name} cai derrotado.`;
    }

    if (updatedEnemies.every((enemy) => enemy.hitPoints <= 0)) {
      const xpNarration = this.awardCombatExperience(roomId, updatedEnemies);
      const resolvedCombat: CombatState = {
        active: false,
        round: combat.round,
        currentTurnIndex: 0,
        order: [],
        enemies: updatedEnemies,
        log,
        lastOutcome: `${player.characterName} encerrou o combate.`,
      };
      this.store.updateCombat(roomId, resolvedCombat);
      this.store.updateScene(roomId, {
        combatRound: undefined,
        pendingRollRequest: null,
        summary: `${room.scene.title}: o grupo sobrevive ao confronto e retoma o controle da cena.`,
        storyArc: recordCombatInStoryArc(room, `${player.characterName} encerrou o combate contra ${updatedEnemies.map((enemy) => enemy.name).join(", ")}.`),
      });
      this.addGmCombatMessage(roomId, `${narration} O grupo sobrevive ao confronto e retoma o controle da cena.${xpNarration ? ` ${xpNarration}` : ""}`, `Dano ${damage}. Combate encerrado.`);
      return;
    }

    const afterDamage = this.advanceCombat({ ...combat, enemies: updatedEnemies, order, log, lastOutcome: `Dano ${damage} em ${target.name}.` });
    this.store.updateCombat(roomId, afterDamage);
    this.store.updateScene(roomId, {
      combatRound: afterDamage.round,
      summary: `${room.scene.title}: ${player.characterName} fere ${target.name}, e a iniciativa continua.`,
    });
    this.continueCombatAfterTurn(roomId, narration, `Dano aplicado: ${damage}.`);
  }

  private resolveCombatDefenseRoll(roomId: string, player: Player, pendingRoll: PendingRollRequest, total: number): void {
    const room = this.store.getRoom(roomId);
    if (!room || !room.combat.active) return;
    const enemy = room.combat.enemies.find((entry) => entry.id === pendingRoll.targetEnemyId && entry.hitPoints > 0)
      ?? room.combat.enemies.find((entry) => entry.name === pendingRoll.targetEnemyName && entry.hitPoints > 0);
    if (!enemy) return;

    const updatedPlayers = room.players.map((entry) => ({ ...entry }));
    const target = updatedPlayers.find((entry) => entry.id === player.id);
    const log = [...room.combat.log];
    let narration: string;
    let ruleOutcome: string;

    if (total >= pendingRoll.difficulty) {
      narration = `${player.characterName} le o movimento de ${enemy.name} e evita o golpe.`;
      ruleOutcome = `Defesa ${total} vs CD ${pendingRoll.difficulty}: sucesso. Nenhum dano sofrido.`;
      log.push(`${player.characterName} evitou o ataque de ${enemy.name}.`);
    } else {
      const damage = this.rollEnemyDamage(enemy);
      if (target) target.hitPoints = Math.max(0, target.hitPoints - damage);
      narration = `${enemy.name} rompe a guarda de ${player.characterName} e causa ${damage} de dano.`;
      ruleOutcome = `Defesa ${total} vs CD ${pendingRoll.difficulty}: falha. Dano recebido: ${damage}.`;
      log.push(`${enemy.name} causou ${damage} de dano em ${player.characterName}.`);
    }

    const afterEnemy = this.advanceCombat({ ...room.combat, log, lastOutcome: ruleOutcome });
    this.store.updatePlayers(roomId, () => updatedPlayers);
    this.store.updateCombat(roomId, afterEnemy);
    this.store.updateScene(roomId, {
      combatRound: afterEnemy.round,
      summary: `${room.scene.title}: ${enemy.name} pressiona ${player.characterName}, e a ordem de iniciativa continua.`,
    });
    this.continueCombatAfterTurn(roomId, narration, ruleOutcome);
  }

  private continueCombatAfterTurn(roomId: string, narration: string, ruleOutcome?: string): void {
    const room = this.store.getRoom(roomId);
    if (!room || !room.combat.active) {
      this.addGmCombatMessage(roomId, narration, ruleOutcome);
      return;
    }

    const actor = room.combat.order[room.combat.currentTurnIndex];
    if (!actor) {
      this.addGmCombatMessage(roomId, narration, ruleOutcome);
      return;
    }

    let currentRoom = room;
    let currentCombat = room.combat;
    let collectedNarration = narration;
    const ruleParts = ruleOutcome ? [ruleOutcome] : [];

    for (let guard = 0; guard < 12; guard += 1) {
      const currentActor = currentCombat.order[currentCombat.currentTurnIndex];
      if (!currentActor || currentActor.side !== "enemy") break;

      const enemyResolution = this.resolveEnemyTurn(currentCombat, currentRoom.players);
      const advancedCombat = this.advanceCombat(enemyResolution.combat);
      const playersAfterEnemy = enemyResolution.players;
      const allPlayersDown = playersAfterEnemy.length > 0 && playersAfterEnemy.every((player) => player.hitPoints <= 0);
      const finalCombat = allPlayersDown
        ? { ...advancedCombat, active: false, lastOutcome: "Todos os personagens jogadores cairam." }
        : advancedCombat;

      this.store.updatePlayers(roomId, () => playersAfterEnemy);
      this.store.updateCombat(roomId, finalCombat);
      this.store.updateScene(roomId, {
        combatRound: finalCombat.active ? finalCombat.round : undefined,
        pendingRollRequest: null,
        summary: `${currentRoom.scene.title}: ${enemyResolution.summary}.`,
      });

      collectedNarration = `${collectedNarration} ${enemyResolution.narration}`;
      ruleParts.push(enemyResolution.ruleOutcome);

      currentRoom = {
        ...currentRoom,
        players: playersAfterEnemy,
        combat: finalCombat,
        scene: { ...currentRoom.scene, pendingRollRequest: null },
      };
      currentCombat = finalCombat;

      if (!finalCombat.active) {
        this.addGmCombatMessage(roomId, collectedNarration, ruleParts.join(" "));
        return;
      }
    }

    const nextActor = currentCombat.order[currentCombat.currentTurnIndex];
    this.addGmCombatMessage(roomId, `${collectedNarration} Proximo turno: ${nextActor?.actorName ?? "grupo"}.`, ruleParts.join(" "));
  }

  private awardCombatExperience(roomId: string, defeatedEnemies: EnemyState[]): string {
    const room = this.store.getRoom(roomId);
    if (!room) return "";
    const totalXp = defeatedEnemies.reduce((sum, enemy) => sum + Math.max(0, enemy.xpValue ?? enemy.threat * 25), 0);
    if (totalXp <= 0) return "";

    const eligiblePlayers = room.players.filter((player) => player.hitPoints > 0);
    const recipients = eligiblePlayers.length > 0 ? eligiblePlayers : room.players;
    if (recipients.length === 0) return "";

    const xpEach = Math.max(1, Math.floor(totalXp / recipients.length));
    const updates: Array<{ name: string; xp: number; pending: number; unlocked: boolean; from: number; to: number }> = [];
    const recipientIds = new Set(recipients.map((player) => player.id));

    this.store.updatePlayers(roomId, (players) => players.map((player) => {
      if (!recipientIds.has(player.id)) return player;
      const result = applyExperienceToPlayer(player, xpEach);
      updates.push({
        name: player.characterName,
        xp: result.player.experiencePoints,
        pending: result.player.pendingLevelUps ?? 0,
        unlocked: result.leveledUp,
        from: result.fromLevel,
        to: result.toLevel,
      });
      return result.player;
    }));

    const defeatedNames = defeatedEnemies.map((enemy) => `${enemy.name} (${enemy.xpValue ?? 0} XP)`).join(", ");
    const levelUps = updates.filter((entry) => entry.unlocked);
    const base = `Recompensa: ${totalXp} XP pelo combate contra ${defeatedNames}; ${xpEach} XP para cada personagem elegÃ­vel.`;
    if (levelUps.length === 0) return base;
    return `${base} NÃ­vel disponÃ­vel: ${levelUps.map((entry) => `${entry.name} pode aplicar ${entry.pending} nÃ­vel(is) de classe`).join(", ")}.`;
  }

  private requestCombatDefenseRoll(roomId: string, actor: CombatActor, narration: string, ruleOutcome?: string): void {
    const room = this.store.getRoom(roomId);
    if (!room || !room.combat.active) return;
    const enemy = room.combat.enemies.find((entry) => entry.id === actor.actorId && entry.hitPoints > 0);
    const target = room.players.find((entry) => entry.hitPoints > 0) ?? room.players[0];
    if (!enemy || !target) {
      this.addGmCombatMessage(roomId, `${narration} O inimigo hesita, sem alvo valido.`, ruleOutcome);
      return;
    }

    const defenseModifier = this.defenseModifier(target);
    const primaryAction = enemy.actions?.[0];
    const difficulty = 10 + (primaryAction?.attackBonus ?? enemy.threat);
    this.store.updateScene(roomId, {
      pendingRollRequest: {
        kind: "combat_defense",
        playerName: target.characterName,
        requestedAt: new Date().toISOString(),
        skill: `Defesa / Agilidade contra ${primaryAction?.name ?? "ataque"}`,
        die: "d20",
        modifier: defenseModifier,
        difficulty,
        description: `Defesa de ${target.characterName} contra ${enemy.name}`,
        targetEnemyId: enemy.id,
        targetEnemyName: enemy.name,
      },
    });
    this.addGmCombatMessage(
      roomId,
      `${narration} ${enemy.name} contra-ataca com ${primaryAction?.name ?? "ataque"}. ${target.characterName}, role 1d20 ${this.formatModifier(defenseModifier)} de Defesa/Agilidade contra CD ${difficulty} para evitar o golpe.`,
      ruleOutcome ? `${ruleOutcome} Defesa pendente contra ${enemy.name}.` : `Defesa pendente contra ${enemy.name}.`,
    );
  }

  private addGmCombatMessage(roomId: string, narration: string, ruleOutcome?: string): void {
    const message = this.store.addMessage(roomId, {
      role: "gm",
      kind: "gm",
      authorName: "Game Master",
      content: ruleOutcome ? `${narration}\n\nRegra: ${ruleOutcome}` : narration,
      rawContent: narration,
    });
    this.narrateText(roomId, `combat-${message.id}`, narration, "gm-narrator", "Game Master", message.id);
    this.io.to(roomId).emit("room:messages", [message]);
  }

  private pickCombatTarget(enemies: EnemyState[], content: string): EnemyState {
    const lowered = content.toLowerCase();
    return enemies.find((enemy) => lowered.includes(enemy.name.toLowerCase()))
      ?? enemies.slice().sort((a, b) => a.hitPoints - b.hitPoints)[0];
  }

  private findDeclaredTargetMismatch(enemies: EnemyState[], content: string): string | null {
    const text = this.normalizeText(content);
    const match = text.match(/\b(?:ataco|atacar|golpeio|corto|esfaqueio|mato)\s+(?:o|a|os|as|um|uma|uns|umas)?\s*([a-z0-9 ]{3,50}?)(?:\s+com|\s+usando|\s+de|\s+na minha frente|$)/);
    const target = match?.[1]?.trim();
    if (!target) return null;
    const genericTargets = ["inimigo", "inimigos", "criatura", "criaturas", "monstro", "monstros", "alvo"];
    if (genericTargets.some((term) => target === term || target.startsWith(`${term} `))) return null;

    const normalizedEnemies = enemies.map((enemy) => this.normalizeText(enemy.name));
    const aliases: Record<string, string[]> = {
      guard: ["guarda", "sentinela"],
      blackstone: ["blackstone", "pedra negra"],
    };
    const targetTerms = [target, ...(aliases[target] ?? [])];
    const matchesEnemy = normalizedEnemies.some((enemyName) =>
      targetTerms.some((term) => enemyName.includes(term) || term.includes(enemyName))
    );
    return matchesEnemy ? null : target;
  }

  private abilityModifier(score: number | undefined): number {
    return Math.floor(((score ?? 10) - 10) / 2);
  }

  private attackModifier(player: Player, content: string): number {
    if (this.isRangedAttack(content)) {
      return (player.proficiencyBonus ?? 2) + this.abilityModifier(player.attributes.agility);
    }
    return (player.proficiencyBonus ?? 2) + this.abilityModifier(player.attributes.strength);
  }

  private isRangedAttack(content: string): boolean {
    const lowered = content.toLowerCase();
    return lowered.includes("arco")
      || lowered.includes("besta")
      || lowered.includes("adaga arremessada")
      || lowered.includes("flecha")
      || lowered.includes("disparo");
  }

  private attackHasAdvantage(room: RoomState, _player: Player, content: string): boolean {
    const actionText = this.normalizeText(content);
    const recentText = this.normalizeText([
      room.scene.summary,
      room.combat.lastOutcome,
      ...room.messages.slice(-10).map((message) => message.content),
    ].filter(Boolean).join(" "));

    const stealthWasBroken = [
      "percebeu jeremiah",
      "detectou jeremiah",
      "notou jeremiah",
      "posicao exposta",
      "agora exposto",
      "alvo ciente de sua presenca",
    ].some((term) => recentText.includes(this.normalizeText(term)));
    if (stealthWasBroken) return false;

    const canonicalHidden = [
      "teste de furtividade foi bem-sucedido",
      "sem que o monstro registre sua presenca",
      "sem que a criatura registre sua presenca",
      "manteve uma distancia segura",
      "posicao escondida",
      "oculto",
      "escondido",
      "nao havia detectado",
      "nao detectou",
    ].some((term) => recentText.includes(this.normalizeText(term)));

    const actionClaimsUnseenAttack = [
      "posicao escondida",
      "estou escondido",
      "sem ser percebido",
      "nao me detectou",
      "não me detectou",
      "nao fui detectado",
      "não fui detectado",
      "ataque surpresa",
    ].some((term) => actionText.includes(this.normalizeText(term)));

    return canonicalHidden || (actionClaimsUnseenAttack && !room.combat.log.some((entry) => this.normalizeText(entry).includes("percebeu")));
  }

  private hasHuntersMarkDamage(room: RoomState, player: Player, target: EnemyState, content: string): boolean {
    const text = this.normalizeText([
      content,
      room.scene.summary,
      room.combat.lastOutcome,
      ...room.messages.slice(-10).map((message) => message.content),
    ].filter(Boolean).join(" "));
    const mentionsMark = [
      "marca do cacador",
      "marca de cacador",
      "hunter's mark",
      "hunters mark",
    ].some((term) => text.includes(this.normalizeText(term)));
    if (!mentionsMark) return false;

    const targetText = this.normalizeText(`${target.name} criatura corrompida monstro alvo`);
    const markedTarget = text.includes("alvo marcado")
      || text.includes("marcado com")
      || text.includes("inimigo esta marcado")
      || text.includes("inimigo está marcado")
      || targetText.split(" ").filter((part) => part.length > 3).some((part) => text.includes(part));
    const playerCanUseMark = player.spells.some((spell) => this.normalizeText(spell).includes("marca"))
      || player.features.some((feature) => this.normalizeText(feature).includes("marca"))
      || mentionsMark;
    return playerCanUseMark && markedTarget;
  }

  private defenseModifier(player: Player): number {
    return Math.max(this.abilityModifier(player.attributes.agility), player.skills.acrobatics ?? -99, player.skills.stealth ?? -99);
  }

  private rollEnemyDamage(enemy: EnemyState): number {
    const action = enemy.actions?.[0];
    if (!action) return Math.max(1, rollDie(6) + enemy.threat);
    const sides = Number(action.damageDie.replace("d", "")) as 4 | 6 | 8 | 10 | 12;
    const diceCount = Math.max(1, action.damageDiceCount ?? 1);
    let total = 0;
    for (let index = 0; index < diceCount; index += 1) {
      total += rollDie(sides);
    }
    return Math.max(1, total + (action.damageModifier ?? 0));
  }

  private damageSpecForAction(player: Player, content: string): { die: "d4" | "d6" | "d8" | "d10" | "d12"; modifier: number; type: string } {
    const lowered = content.toLowerCase();
    const strength = this.abilityModifier(player.attributes.strength);
    const agility = this.abilityModifier(player.attributes.agility);
    if (lowered.includes("machado") && (lowered.includes("2 mao") || lowered.includes("duas mao") || lowered.includes("duas mÃ£os"))) {
      return { die: "d12", modifier: strength, type: "cortante" };
    }
    if (lowered.includes("espada") || lowered.includes("machado")) {
      return { die: "d8", modifier: strength, type: "cortante" };
    }
    if (lowered.includes("arco") || lowered.includes("besta")) {
      return { die: "d8", modifier: agility, type: "perfurante" };
    }
    if (lowered.includes("adaga")) {
      return { die: "d4", modifier: Math.max(strength, agility), type: "perfurante" };
    }
    return { die: "d8", modifier: strength, type: "da arma" };
  }

  private formatModifier(modifier: number): string {
    return modifier === 0 ? "+0" : `${modifier > 0 ? "+" : ""}${modifier}`;
  }

  private advanceCombat(combat: CombatState): CombatState {
    if (!combat.active || combat.order.length === 0) {
      return combat;
    }

    const nextTurnIndex = (combat.currentTurnIndex + 1) % combat.order.length;
    const nextRound = nextTurnIndex === 0 ? combat.round + 1 : combat.round;
    return {
      ...combat,
      currentTurnIndex: nextTurnIndex,
      round: nextRound,
    };
  }

  private isEstablishedAnimalCompanion(
    room: RoomState,
    npc: { name: string; role: string; description: string },
  ): boolean {
    if (!npcIsAnimalCompanion(npc.name, npc.role, npc.description)) return false;
    const npcName = this.normalizeText(npc.name);
    return room.players.some((player) => {
      const loreText = this.normalizeText([
        player.backstory,
        player.connections,
        player.motivation,
        player.turningPoint,
        player.origin,
      ].filter(Boolean).join(" "));
      return loreText.includes(npcName) || /cachorro|cao|beagle|companheiro animal|fiel companheiro/.test(loreText);
    });
  }

  private buildAnimalCompanionStats(npc: { description: string }): { hitPoints: number; maxHitPoints: number; armorClass: number } {
    const text = this.normalizeText(npc.description);
    if (/beagle|cachorro|cao|hound|dog/.test(text)) {
      return { hitPoints: 5, maxHitPoints: 5, armorClass: 12 };
    }
    return { hitPoints: 7, maxHitPoints: 7, armorClass: 12 };
  }

  private createCombatImage(roomId: string, enemy: EnemyState, sceneTitle: string, messageId?: string): void {
    if (config.textOnly) return;
    const room = this.store.getRoom(roomId);
    const sceneSummary = room?.scene.summary ?? "";
    const beastLocks = enemyIsNaturalBeast(enemy.name, enemy.description)
      ? buildBeastVisualLocks(enemy.name, enemy.description)
      : { positive: [], negative: [] };
    const creatureKind = beastLocks.positive.length > 0
      ? "natural beast enemy, not humanoid"
      : "dark fantasy enemy, anatomy follows the written monster description";
    const [job] = this.store.addImageJobs(roomId, [
      {
        profile: "creature",
        prompt: [
          "full body dark fantasy enemy illustration, one creature only, in the active RPG scene",
          creatureKind,
          `enemy: ${enemy.name}`,
          `STRICT ENEMY BRIEF, must match exactly: ${enemy.description}`,
          beastLocks.positive.length ? `visual locks: ${beastLocks.positive.join(", ")}` : "",
          `scene background: ${sceneTitle}, ${sceneSummary}`,
          "body fully visible from head to feet, readable silhouette, natural attack visible if described",
          "integrated lighting from the scene, cinematic Dungeons and Dragons art, painterly, detailed anatomy",
          "not a token, not top-down, not white background, not a character sheet",
        ].join(", "),
        negativePrompt: beastLocks.negative.join(", "),
        messageId,
      },
    ]);
    this.broadcastState(roomId);
    this.resolveCachedOrScheduleGenerated(roomId, job, undefined, { skipCache: true });
  }

  private createPortraitImage(roomId: string, player: Player): void {
    if (config.textOnly) return;
    const existingRoom = this.store.getRoom(roomId);
    if (existingRoom?.imageJobs.some((job) => job.profile === "portrait" && job.status === "queued" && job.subjectName === player.characterName)) {
      return;
    }
    const portrait = buildCharacterPortraitPrompt(player);
    const [job] = this.store.addImageJobs(roomId, [
      {
        profile: "portrait",
        prompt: portrait.prompt,
        subjectName: player.characterName,
        negativePrompt: portrait.negativePrompt,
        seed: portrait.seed,
      },
    ]);
    this.broadcastState(roomId);
    this.resolveCachedOrScheduleGenerated(roomId, job, (completed) => {
      // Guard: if the player already has a portrait by the time this job completes
      // (e.g. they selected one after this job was queued), do not overwrite it.
      const currentPortrait = this.store.getRoom(roomId)?.players.find((p) => p.id === player.id)?.portraitAssetUrl;
      if (currentPortrait) return;
      this.store.updatePlayer(roomId, player.id, (entry) => ({ ...entry, portraitAssetUrl: completed.assetUrl }));
      const updatedRoom = this.store.getRoom(roomId);
      if (updatedRoom) {
        this.store.updateMemory(roomId, (memory) => recordPlayerCharacters({ ...updatedRoom, memory }));
        this.syncGraphMemory(roomId);
      }
      this.broadcastState(roomId);
    });
  }

  private createSceneImage(roomId: string, sceneTitle: string, sceneSummary: string, sceneKeyword?: string, messageId?: string): void {
    if (config.textOnly) return;
    const basePrompt = buildScenePrompt(sceneTitle, sceneSummary);
    const prompt = sceneKeyword ? `${basePrompt}, ${sceneKeyword}` : basePrompt;
    const [job] = this.store.addImageJobs(roomId, [
      {
        profile: "scene",
        prompt,
        messageId,
      },
    ]);
    this.broadcastState(roomId);
    this.resolveCachedOrScheduleGenerated(roomId, job, undefined, { skipCache: true });
  }

  private shouldQueueSceneImageCorrection(room: RoomState, content: string): boolean {
    if (config.textOnly) return false;
    const text = this.normalizeText(content);
    const sceneText = this.normalizeText(`${room.scene.title} ${room.scene.summary}`);
    const talksAboutImage = ["imagem", "foto", "visual", "arte", "cenario", "cenÃ¡rio"].some((term) => text.includes(term));
    const reportsMismatch = ["errada", "errado", "nao parece", "nÃ£o parece", "parece ser", "parece uma", "parece um", "nao e", "nÃ£o Ã©", "incoerente"].some((term) => text.includes(this.normalizeText(term)));
    if (!talksAboutImage || !reportsMismatch) return false;

    const canonicalSceneFamilies = [
      { expected: ["igreja", "capela", "templo", "catedral"], wrong: ["bar", "taverna", "estalagem", "taberna", "pousada"] },
      { expected: ["deserto", "duna", "areia"], wrong: ["floresta", "pantano", "pÃ¢ntano", "neve", "geleira"] },
      { expected: ["floresta", "bosque", "mata"], wrong: ["deserto", "taverna", "cidade moderna"] },
      { expected: ["caverna", "cripta", "masmorra"], wrong: ["taverna", "campo aberto", "cidade moderna"] },
      { expected: ["castelo", "fortaleza"], wrong: ["taverna", "floresta", "deserto"] },
    ];

    return canonicalSceneFamilies.some((family) =>
      family.expected.some((term) => sceneText.includes(this.normalizeText(term))) &&
      family.wrong.some((term) => text.includes(this.normalizeText(term)))
    );
  }

  private isExplicitImageRequest(content: string, response: Pick<GmResponse, "narration" | "ruleOutcome">): boolean {
    if (config.textOnly) return false;
    const text = this.normalizeText(`${content} ${response.narration} ${response.ruleOutcome}`);
    const asksForImage = [
      "imagem",
      "foto",
      "arte",
      "visual",
      "retrato",
      "mostra",
      "mostrar",
      "ver o alvo",
      "referencia visual",
      "gera",
      "gerar",
    ].some((term) => text.includes(this.normalizeText(term)));
    const target = ["monstro", "criatura", "inimigo", "npc", "personagem", "cenario", "cena", "local"].some((term) =>
      text.includes(this.normalizeText(term))
    );
    const promisedGeneration = ["vou solicitar uma imagem", "imagem sera gerada", "imagem será gerada", "referencia visual"].some((term) =>
      text.includes(this.normalizeText(term))
    );
    return asksForImage && (target || promisedGeneration);
  }

  private createRequestedVisualImage(roomId: string, room: RoomState, content: string, messageId?: string): void {
    const text = this.normalizeText(content);
    if (["cenario", "cenário", "cena", "local", "ambiente"].some((term) => text.includes(this.normalizeText(term)))) {
      this.createSceneImage(roomId, room.scene.title, room.scene.summary, undefined, messageId);
      return;
    }

    const creatureBrief = this.extractCurrentCreatureBrief(room);
    const [job] = this.store.addImageJobs(roomId, [
      {
        profile: "creature",
        subjectName: creatureBrief.name,
        prompt: [
          "full body dark fantasy creature illustration, one creature only, in the active RPG scene",
          `creature name: ${creatureBrief.name}`,
          `STRICT CREATURE BRIEF, must match exactly: ${creatureBrief.description}`,
          `scene background: ${room.scene.title}, ${room.scene.summary}`,
          "body fully visible from head to feet, readable silhouette, no extra weapons unless described",
          "cinematic Dungeons and Dragons art, painterly, detailed anatomy, coherent monster design",
          "not a token, not top-down, not white background, not humanoid unless explicitly described as humanoid",
        ].join(", "),
        negativePrompt: "extra humans, warrior with sword, armor if not described, duplicate creatures, character sheet, text, watermark",
        messageId,
      },
    ]);
    this.broadcastState(roomId);
    this.resolveCachedOrScheduleGenerated(roomId, job, undefined, { skipCache: true });
  }

  private extractCurrentCreatureBrief(room: RoomState): { name: string; description: string } {
    const activeEnemy = room.combat.enemies.find((enemy) => enemy.hitPoints > 0) ?? room.combat.enemies[0];
    if (activeEnemy) {
      return { name: activeEnemy.name, description: activeEnemy.description };
    }

    const recent = room.messages
      .slice(-12)
      .reverse()
      .find((message) => {
        const text = this.normalizeText(message.content);
        return message.role === "gm" && ["criatura", "monstro", "ser disforme", "aparicao", "aparição"].some((term) => text.includes(this.normalizeText(term)));
      });

    const description = recent?.rawContent ?? recent?.content ?? room.scene.summary;
    const nameMatch = description.match(/\b(?:criatura|monstro|ser)\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÀ-ÿ' -]{2,40})/);
    return {
      name: nameMatch?.[1]?.trim() || "Criatura corrompida",
      description: description.replace(/\n\nRegra:.*$/s, "").trim(),
    };
  }

  private normalizeText(value: string): string {
    return value
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase();
  }

  private findCompanionCatalogPortrait(npc: { name: string; role: string; description: string; className?: string; race?: string }): string | undefined {
    if (!existsSync(config.portraitsDir)) return undefined;

    const normalizeKey = (value: string | undefined, fallback: string): string =>
      this.normalizeText(value ?? fallback)
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");

    const npcText = this.normalizeText(`${npc.name} ${npc.role} ${npc.description}`);
    const gender =
      ["female", "woman", "mulher", "feminina", "garota", "elfa", "anÃ£", "ana"].some((term) => npcText.includes(term))
        ? "female"
        : ["male", "man", "homem", "masculino", "garoto", "elfo", "anÃ£o", "anao"].some((term) => npcText.includes(term))
          ? "male"
          : "";
    const classKey = normalizeKey(npc.className ?? npc.role, "fighter");
    const raceKey = normalizeKey(npc.race, "human");
    const preferredPrefix = gender ? `${classKey}_${raceKey}_${gender}` : `${classKey}_${raceKey}_`;

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (/\.(png|jpe?g|webp)$/i.test(entry.name)) files.push(fullPath);
      }
    };

    try {
      walk(config.portraitsDir);
    } catch {
      return undefined;
    }

    const ranked = files
      .map((file) => {
        const relative = path.relative(config.portraitsDir, file).replaceAll("\\", "/");
        const base = path.basename(file).toLowerCase();
        const score =
          (base.startsWith(preferredPrefix) ? 10 : 0) +
          (base.includes(`${classKey}_${raceKey}`) ? 5 : 0) +
          (gender && base.includes(`_${gender}_`) ? 2 : 0);
        return { relative, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.relative.localeCompare(right.relative));

    if (ranked.length === 0) return undefined;
    const index = Math.abs(this.hashString(npc.name || npc.description)) % Math.min(2, ranked.length);
    return `/assets/portraits/${ranked[index]?.relative}`;
  }

  private hashString(value: string): number {
    let hash = 2166136261;
    for (const character of value) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return hash;
  }

  private createNpcPortraitImage(roomId: string, npc: { name: string; role: string; description: string; className?: string; race?: string; level?: number }, isCompanion = false): void {
    if (config.textOnly) return;
    const room = this.store.getRoom(roomId);
    const sceneContext = `${room?.scene.title ?? "active scene"}, ${room?.scene.summary ?? ""}`;
    const npcClass = (npc.className ?? npc.role).toLowerCase();
    const npcRace = (npc.race ?? "human").toLowerCase();
    const npcText = this.normalizeText(`${npc.name} ${npc.role} ${npc.description}`);
    const refinedLocks = visualLocksFromPortuguese(`${npc.name} ${npc.role} ${npc.description}`);
    const isAnimal = npcIsAnimalCompanion(npc.name, npc.role, npc.description);
    const animalLocks = isAnimal ? buildBeastVisualLocks(npc.name, npc.description) : { positive: [], negative: [] };
    const visualLocks: string[] = [];
    if (/(capitao|captain|guarda|guard|soldado|lider)/.test(npcText)) {
      visualLocks.push("experienced local guard captain, authoritative stance, practical worn guard uniform, duty belt, weathered armor pieces");
    }
    if (/(meia idade|meia-idade|middle aged|experiente|veterano|veteran)/.test(npcText)) {
      visualLocks.push("middle aged face, visible age lines, mature features, not young");
    }
    if (/(corpulento|robusto|pesado|forte|large|stocky|broad)/.test(npcText)) {
      visualLocks.push("stocky heavy build, broad shoulders, thick neck, sturdy body");
    }
    if (/(aspero|duro|severo|desdem|rough|stern|harsh)/.test(npcText)) {
      visualLocks.push("stern rough expression, hard tired eyes, practical distrustful look");
    }
    if (/(uniforme gasto|gasto|velho|worn|weathered)/.test(npcText)) {
      visualLocks.push("worn faded uniform, scuffed fabric, used leather straps, no pristine noble clothing");
    }
    const profile: ImageJob["profile"] = isAnimal ? "creature" : "npc";
    const prompt = (isAnimal ? [
      "full body loyal animal companion illustration, one real animal only, inside the active RPG scene",
      `animal companion: ${npc.name}`,
      `STRICT ANIMAL BRIEF, must match exactly: ${npc.description}`,
      `MANDATORY animal locks: ${animalLocks.positive.join(", ")}`,
      `scene background: ${sceneContext}`,
      "body fully visible, four paws visible if canine, natural animal anatomy, grounded fantasy realism, painterly Dungeons and Dragons companion art",
      "the animal is an ally travelling with the player, not a humanoid NPC, not a warrior, not a person in costume",
    ] : [
      "full body fantasy RPG NPC illustration, one character only, standing naturally inside the active RPG scene",
      "single subject, full body visible from head to feet, centered composition, readable face and clothing, no beauty glamor",
      `npc: ${npc.name}`,
      `identity: ${npcRace} ${npcClass}${isCompanion ? " possible companion adventurer" : " scene NPC, not a party member yet"}`,
      `STRICT CHARACTER BRIEF, must match exactly: ${npc.description}`,
      `MANDATORY visible details from brief: ${[...visualLocks, ...refinedLocks.positive].join(", ") || "match age, body, clothing and expression described"}`,
      `scene background: ${sceneContext}`,
      "the written brief has priority over generic fantasy hero stereotypes",
      "age, body type, ethnicity only if explicitly described, posture, expression, clothing condition, colors and equipment must match the written brief",
      "integrated scene lighting, cinematic Dungeons and Dragons art, polished painterly fantasy illustration",
      "negative: handsome young hero, slim young man, clean noble uniform, generic adventurer, random portrait from catalog, wrong race, wrong class, wrong gender, extra people, crowd, top-down token, white background, close-up portrait, character sheet, text, watermark",
    ]).filter(Boolean).join(", ");
    const [job] = this.store.addImageJobs(roomId, [
      {
        profile,
        prompt,
        subjectName: npc.name,
        negativePrompt: [...refinedLocks.negative, ...animalLocks.negative].join(", "),
      },
    ]);
    this.broadcastState(roomId);
    this.scheduleImage(roomId, async () => {
      const result = await this.imageService.render(job, { skipCache: true });
      if (!result) return;
      const completed = this.completeImageJob(roomId, job, result.assetUrl);
      if (!completed) return;
      this.store.updateScene(roomId, {
        activeNpcs: (this.store.getRoom(roomId)?.scene.activeNpcs ?? []).map((entry) =>
          entry.name === npc.name ? { ...entry, portraitAssetUrl: completed.assetUrl } : entry
        ),
      });
      this.broadcastState(roomId);
    });
  }

  private broadcastState(roomId: string): void {
    const room = this.store.getRoom(roomId);
    if (!room) {
      return;
    }

    this.io.to(roomId).emit("room:scene", room.scene);
    this.io.to(roomId).emit("room:players", room.players);
    this.io.to(roomId).emit("room:combat", room.combat);
    this.io.to(roomId).emit("room:imageJobs", room.imageJobs);
  }

  private broadcastSnapshot(roomId: string): void {
    const room = this.store.getRoom(roomId);
    if (!room) {
      return;
    }

    this.io.to(roomId).emit("room:snapshot", room);
    this.broadcastState(roomId);
  }

}

