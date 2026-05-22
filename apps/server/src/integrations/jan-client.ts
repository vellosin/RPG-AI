import type { GmResponse, IntegrationStatus, NpcHealthUpdate, NpcStatus, PendingRollRequest, PlayerAction, RoomState, SceneNpc } from "../game/types.js";
import { config } from "../config.js";
import type { ActionPlan } from "../game/action-orchestrator.js";
import { buildLongCampaignBlueprintPrompt } from "../game/campaign-blueprints.js";
import { retrieveRelevantMemories } from "../game/campaign-memory.js";
import { formatInventoryForPrompt } from "../game/equipment-catalog.js";
import { formatPlayerLoreForPrompt } from "../game/player-lore.js";
import { createNarrationExtractor } from "./narration-extractor.js";

export type PreparedSession = {
  startingLocationTitle?: string;
  openingNarration: string;
  sceneSummary: string;
  partyContext: string;
  possibleEnemies: Array<{ name: string; description: string }>;
  possibleNpcs: Array<{ name: string; role: string; description: string }>;
  activeNpcs: SceneNpc[];
  possibleQuests: Array<{ title: string; description: string }>;
  loreHooks: string[];
};

export type AdventureSuggestion = {
  title: string;
  hook: string;
  sceneKeyword: string;
  enemies: string;
  npc: string;
  mood: string;
};

export type ImageInventory = {
  cenarios: string[];
  criaturas: string[];
  retratos: string[];
};

type ChatMessage = { role: "system" | "user"; content: string };

type JsonProviderOptions<T> = {
  label: string;
  messages: ChatMessage[];
  temperature: number;
  janTimeoutMs: number;
  ollamaTimeoutMs: number;
  parse: (content: string) => T | null;
  fallback: () => T;
};

const inferSkill = (action: string): string => {
  const lower = action.toLowerCase();
  if (lower.includes("persuad") || lower.includes("convenc") || lower.includes("negoci")) return "persuasion";
  if (lower.includes("investig") || lower.includes("exam") || lower.includes("procur") || lower.includes("buscas")) return "investigation";
  if (lower.includes("atac") || lower.includes("golp") || lower.includes("combat")) return "melee";
  if (lower.includes("escal") || lower.includes("sobe") || lower.includes("empurr") || lower.includes("carrega")) return "athletics";
  if (lower.includes("escondi") || lower.includes("furtivu") || lower.includes("furtiv") || lower.includes("silenci")) return "stealth";
  if (lower.includes("arromb") || lower.includes("fechadur") || lower.includes("trava")) return "lockpicking";
  if (lower.includes("rastro") || lower.includes("trilha") || lower.includes("vestig") || lower.includes("pista")) return "survival";
  if (lower.includes("cura") || lower.includes("trat") || lower.includes("ferida")) return "medicine";
  if (lower.includes("arca") || lower.includes("magia") || lower.includes("encant")) return "arcana";
  return "awareness";
};

const playerGenderContext = (player: RoomState["players"][number]) => {
  const gender = player.gender === "female" ? "female" : "male";
  return gender === "female"
    ? {
        gender,
        genderPt: "feminino",
        pronounSubject: "ela",
        pronounObject: "a",
        possessive: "dela",
        aloneAdjective: "sozinha",
        treatment: "use concordancia feminina para adjetivos, cargos e narracao: ela, a, dela, sozinha, enviada, chamada, designada",
      }
    : {
        gender,
        genderPt: "masculino",
        pronounSubject: "ele",
        pronounObject: "o",
        possessive: "dele",
        aloneAdjective: "sozinho",
        treatment: "use concordancia masculina para adjetivos, cargos e narracao: ele, o, dele, sozinho, enviado, chamado, designado",
      };
};

const formatClassLevelsForPrompt = (player: RoomState["players"][number]): string =>
  Object.entries(player.classLevels ?? { [player.className]: player.level })
    .map(([className, level]) => `${className} ${level}`)
    .join(" / ");

const formatPlayerRulesForPrompt = (player: RoomState["players"][number]) => ({
  characterName: player.characterName,
  className: player.className,
  classLevels: player.classLevels ?? { [player.className]: player.level },
  classLevelText: formatClassLevelsForPrompt(player),
  species: player.species,
  gender: player.gender ?? "male",
  genderContext: playerGenderContext(player),
  background: player.background,
  level: player.level,
  experiencePoints: player.experiencePoints,
  nextLevelExperience: player.nextLevelExperience,
  pendingLevelUps: player.pendingLevelUps,
  attributes: player.attributes,
  skills: player.skills,
  armorClass: player.armorClass,
  proficiencyBonus: player.proficiencyBonus,
  hitPoints: player.hitPoints,
  maxHitPoints: player.maxHitPoints,
  inventory: player.inventory,
  inventoryDetails: formatInventoryForPrompt(player.inventory.equipped, player.inventory.backpack),
  spells: player.spells,
  features: player.features,
  resources: player.resources,
});

const SKILL_LABEL_PT: Record<string, string> = {
  persuasion: "Persuasão",
  investigation: "Investigação",
  melee: "Combate",
  athletics: "Atletismo",
  stealth: "Furtividade",
  lockpicking: "Arrombamento",
  survival: "Sobrevivência",
  medicine: "Medicina",
  arcana: "Arcanismo",
  awareness: "Percepção",
  acrobatics: "Acrobacia",
  deception: "Enganação",
  intimidation: "Intimidação",
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export type LlmCallTrace = {
  roomId?: string;
  model: string;
  label: string;
  promptChars: number;
  completionChars: number;
  latencyMs: number;
  ok: boolean;
  mode: "live" | "fallback";
  error?: string;
};

export type LlmCallSink = (trace: LlmCallTrace) => void;

export class JanClient {
  private lastStatus: IntegrationStatus = {
    provider: "game-master-provider",
    baseUrl: config.janBaseUrl,
    ok: false,
    mode: "fallback",
    details: "No live provider checked yet.",
  };

  private callSink: LlmCallSink | null = null;
  private currentLabel: string = "uncategorized";
  private currentRoomId: string | undefined;

  /**
   * Wire up an observability sink (typically the SQLite store) that gets a structured
   * record for every Jan/Ollama HTTP call. Pure side effect; safe to leave unset for tests.
   */
  setLlmCallSink(sink: LlmCallSink): void {
    this.callSink = sink;
  }

  private emitTrace(trace: LlmCallTrace): void {
    if (!this.callSink) return;
    try {
      this.callSink(trace);
    } catch {
      // Observability must never break gameplay.
    }
  }

  async runGameMaster(room: RoomState, action: PlayerAction, actionPlan?: ActionPlan): Promise<GmResponse> {
    // OOC meta-questions (parentheses style) use a separate GM-as-facilitator prompt
    if (action.content.startsWith("question:")) {
      return this.runQuestionAnswer(room, action);
    }

    return this.runJsonProviderChain({
      label: "game-master-turn",
      roomId: room.id,
      messages: this.buildMessages(room, action, actionPlan),
      temperature: 0.7,
      janTimeoutMs: 30000,
      ollamaTimeoutMs: 45000,
      parse: (content) => {
        try {
          return this.parseGameMasterJson(content);
        } catch {
          return null;
        }
      },
      fallback: () => this.runFallbackGameMaster(room, action, actionPlan),
    });
  }

  /**
   * Streaming variant of runGameMaster.
   *
   * Calls Jan's OpenAI-compatible /chat/completions with `stream: true`, parses
   * the SSE stream into deltas, and feeds them through a partial-JSON extractor
   * that emits each character of the `narration` field as soon as it arrives.
   *
   * The caller passes an `onNarrationChunk(chars)` sink that gets fired live;
   * the returned Promise resolves with the fully parsed GmResponse once the
   * stream completes (so the engine still has the structured data to apply
   * scene/combat/memory updates).
   *
   * If streaming fails for any reason (Jan unavailable, malformed SSE), this
   * method falls back to the regular non-streaming runGameMaster — the caller
   * just won't see live narration in that case.
   */
  async runGameMasterStreamed(
    room: RoomState,
    action: PlayerAction,
    actionPlan: ActionPlan | undefined,
    onNarrationChunk: (chars: string) => void,
  ): Promise<GmResponse> {
    if (action.content.startsWith("question:")) {
      return this.runQuestionAnswer(room, action);
    }

    const messages = this.buildMessages(room, action, actionPlan);
    const promptChars = messages.reduce((sum, msg) => sum + msg.content.length, 0);
    const start = Date.now();
    let fullText = "";
    const extractor = createNarrationExtractor();

    try {
      const response = await fetch(`${config.janBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.janModel, temperature: 0.7, stream: true, messages }),
        signal: AbortSignal.timeout(45000),
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });

        // SSE frames are separated by double newlines.
        const frames = pending.split(/\r?\n\r?\n/);
        pending = frames.pop() ?? "";

        for (const frame of frames) {
          for (const line of frame.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const parsed = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
              const delta = parsed.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta.length > 0) {
                fullText += delta;
                const newNarration = extractor.feed(delta);
                if (newNarration.length > 0) {
                  try { onNarrationChunk(newNarration); } catch { /* sink failures must not break streaming */ }
                }
              }
            } catch {
              // skip malformed SSE frames and keep streaming
            }
          }
        }
      }

      this.emitTrace({
        roomId: room.id,
        model: `jan:${config.janModel}:stream`,
        label: "game-master-turn-stream",
        promptChars,
        completionChars: fullText.length,
        latencyMs: Date.now() - start,
        ok: fullText.length > 0,
        mode: "live",
      });

      const parsed = this.parseGameMasterJson(fullText);
      if (parsed) return parsed;
      throw new Error("Stream produced unparseable GM JSON.");
    } catch (error) {
      this.emitTrace({
        roomId: room.id,
        model: `jan:${config.janModel}:stream`,
        label: "game-master-turn-stream",
        promptChars,
        completionChars: fullText.length,
        latencyMs: Date.now() - start,
        ok: false,
        mode: "fallback",
        error: (error as Error).message,
      });
      // Fall back to the standard non-streaming path so gameplay never breaks.
      return this.runGameMaster(room, action, actionPlan);
    }
  }

  async getStatus(): Promise<IntegrationStatus> {
    const janStatus = await this.checkJanStatus();
    if (janStatus.ok) {
      this.lastStatus = janStatus;
      return janStatus;
    }

    const ollamaStatus = await this.checkOllamaStatus();
    if (ollamaStatus.ok) {
      this.lastStatus = ollamaStatus;
      return ollamaStatus;
    }

    this.lastStatus = {
      provider: "game-master-provider",
      baseUrl: `${config.janBaseUrl} | ${config.ollamaBaseUrl}`,
      ok: false,
      mode: "fallback",
      details: `Jan unavailable (${janStatus.details ?? "unknown"}); Ollama unavailable (${ollamaStatus.details ?? "unknown"}).`,
    };
    return this.lastStatus;
  }

  private async requestJanContent(messages: ChatMessage[], temperature: number, timeoutMs: number): Promise<string | null> {
    const start = Date.now();
    const promptChars = messages.reduce((sum, msg) => sum + msg.content.length, 0);
    let content: string | null = null;
    let error: string | undefined;
    try {
      const response = await fetch(`${config.janBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.janModel, temperature, messages }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const completion = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      content = completion.choices?.[0]?.message?.content ?? null;
      return content;
    } catch (err) {
      error = (err as Error).message;
      throw err;
    } finally {
      this.emitTrace({
        roomId: this.currentRoomId,
        model: `jan:${config.janModel}`,
        label: this.currentLabel,
        promptChars,
        completionChars: content?.length ?? 0,
        latencyMs: Date.now() - start,
        ok: !error && Boolean(content),
        mode: "live",
        error,
      });
    }
  }

  private async requestOllamaContent(messages: ChatMessage[], temperature: number, timeoutMs: number): Promise<string | null> {
    const start = Date.now();
    const promptChars = messages.reduce((sum, msg) => sum + msg.content.length, 0);
    let content: string | null = null;
    let error: string | undefined;
    let modelLabel = "ollama:unknown";
    try {
      const model = await this.resolveOllamaModel();
      if (!model) return null;
      modelLabel = `ollama:${model}`;

      const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: false, format: "json", options: { temperature }, messages }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = (await response.json()) as { message?: { content?: string } };
      content = payload.message?.content ?? null;
      return content;
    } catch (err) {
      error = (err as Error).message;
      throw err;
    } finally {
      this.emitTrace({
        roomId: this.currentRoomId,
        model: modelLabel,
        label: this.currentLabel,
        promptChars,
        completionChars: content?.length ?? 0,
        latencyMs: Date.now() - start,
        ok: !error && Boolean(content),
        mode: "live",
        error,
      });
    }
  }

  private appendJsonRepairInstruction(messages: ChatMessage[]): ChatMessage[] {
    return [
      ...messages,
      {
        role: "user",
        content: [
          "A resposta anterior não pôde ser interpretada como JSON válido.",
          "Repita a resposta agora usando APENAS um objeto JSON válido no formato solicitado.",
          "Não inclua markdown, comentários, explicações ou texto fora do JSON.",
        ].join("\n"),
      },
    ];
  }

  private async runJsonProviderChain<T>(options: JsonProviderOptions<T> & { roomId?: string }): Promise<T> {
    this.currentLabel = options.label;
    this.currentRoomId = options.roomId;
    const janTemperatures = [options.temperature, Math.min(options.temperature, 0.25)];
    let lastError = "";

    for (let attempt = 0; attempt < janTemperatures.length; attempt++) {
      try {
        const messages = attempt === 0 ? options.messages : this.appendJsonRepairInstruction(options.messages);
        const content = await this.requestJanContent(messages, janTemperatures[attempt], options.janTimeoutMs);
        if (content) {
          const parsed = options.parse(content);
          if (parsed) {
            this.lastStatus = {
              provider: "jan-local-api",
              baseUrl: config.janBaseUrl,
              ok: true,
              mode: "live",
              details: `${options.label} via ${config.janModel}, attempt ${attempt + 1}`,
            };
            return parsed;
          }
          lastError = "Jan returned unparseable JSON.";
        } else {
          lastError = "Jan returned no message content.";
        }
      } catch (error) {
        lastError = (error as Error).message;
      }

      if (attempt === 0) await sleep(150);
    }

    const ollamaTemperatures = [Math.min(options.temperature, 0.35), 0.1];
    for (let attempt = 0; attempt < ollamaTemperatures.length; attempt++) {
      try {
        const messages = attempt === 0 ? options.messages : this.appendJsonRepairInstruction(options.messages);
        const content = await this.requestOllamaContent(messages, ollamaTemperatures[attempt], options.ollamaTimeoutMs);
        if (content) {
          const parsed = options.parse(content);
          if (parsed) {
            this.lastStatus = {
              provider: "ollama-local-api",
              baseUrl: config.ollamaBaseUrl,
              ok: true,
              mode: "live",
              details: `${options.label}, attempt ${attempt + 1}`,
            };
            return parsed;
          }
          lastError = "Ollama returned unparseable JSON.";
        } else {
          lastError = "Ollama returned no message content.";
        }
      } catch (error) {
        lastError = (error as Error).message;
      }

      if (attempt === 0) await sleep(150);
    }

    this.lastStatus = {
      provider: "game-master-provider",
      baseUrl: `${config.janBaseUrl} | ${config.ollamaBaseUrl}`,
      ok: false,
      mode: "fallback",
      details: `${options.label} fallback after provider retries: ${lastError || "unknown error"}`,
    };
    // Record the fallback as its own trace so /api/llm-stats reflects degradation rates.
    this.emitTrace({
      roomId: options.roomId,
      model: "fallback",
      label: options.label,
      promptChars: options.messages.reduce((sum, msg) => sum + msg.content.length, 0),
      completionChars: 0,
      latencyMs: 0,
      ok: false,
      mode: "fallback",
      error: lastError,
    });
    return options.fallback();
  }

  private async checkJanStatus(): Promise<IntegrationStatus> {
    try {
      const response = await fetch(`${config.janBaseUrl}/models`, {
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) {
        return {
          provider: "jan-local-api",
          baseUrl: config.janBaseUrl,
          ok: false,
          mode: "fallback",
          details: `HTTP ${response.status}`,
        };
      }

      const payload = (await response.json()) as { data?: Array<{ id?: string }> };
      const modelIds = payload.data?.map((entry) => entry.id).filter(Boolean).join(", ") ?? "No models returned";
      return {
        provider: "jan-local-api",
        baseUrl: config.janBaseUrl,
        ok: true,
        mode: "live",
        details: modelIds,
      };
    } catch (error) {
      return {
        provider: "jan-local-api",
        baseUrl: config.janBaseUrl,
        ok: false,
        mode: "fallback",
        details: (error as Error).message,
      };
    }
  }

  private async checkOllamaStatus(): Promise<IntegrationStatus> {
    try {
      const response = await fetch(`${config.ollamaBaseUrl}/api/tags`, {
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) {
        return {
          provider: "ollama-local-api",
          baseUrl: config.ollamaBaseUrl,
          ok: false,
          mode: "fallback",
          details: `HTTP ${response.status}`,
        };
      }

      const payload = (await response.json()) as { models?: Array<{ name?: string }> };
      const names = payload.models?.map((entry) => entry.name).filter(Boolean) ?? [];
      return {
        provider: "ollama-local-api",
        baseUrl: config.ollamaBaseUrl,
        ok: names.length > 0,
        mode: names.length > 0 ? "live" : "fallback",
        details: names.length > 0 ? names.join(", ") : "Ollama is running but has no local models.",
      };
    } catch (error) {
      return {
        provider: "ollama-local-api",
        baseUrl: config.ollamaBaseUrl,
        ok: false,
        mode: "fallback",
        details: (error as Error).message,
      };
    }
  }

  private async tryJanGameMaster(room: RoomState, action: PlayerAction, actionPlan?: ActionPlan): Promise<GmResponse | null> {
    try {
      const payload = {
        model: config.janModel,
        temperature: 0.7,
        messages: this.buildMessages(room, action, actionPlan),
      };

      const response = await fetch(`${config.janBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        this.lastStatus = {
          provider: "jan-local-api",
          baseUrl: config.janBaseUrl,
          ok: false,
          mode: "fallback",
          details: `Chat completion failed with HTTP ${response.status}`,
        };
        return null;
      }

      const completion = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: string;
          };
        }>;
      };
      const content = completion.choices?.[0]?.message?.content;
      if (!content) {
        this.lastStatus = {
          provider: "jan-local-api",
          baseUrl: config.janBaseUrl,
          ok: false,
          mode: "fallback",
          details: "Jan returned no message content.",
        };
        return null;
      }

      const parsed = this.parseGameMasterJson(content);
      this.lastStatus = {
        provider: "jan-local-api",
        baseUrl: config.janBaseUrl,
        ok: true,
        mode: "live",
        details: `Using model ${config.janModel}`,
      };
      return parsed;
    } catch (error) {
      this.lastStatus = {
        provider: "jan-local-api",
        baseUrl: config.janBaseUrl,
        ok: false,
        mode: "fallback",
        details: (error as Error).message,
      };
      return null;
    }
  }

  private async tryOllamaGameMaster(room: RoomState, action: PlayerAction, actionPlan?: ActionPlan): Promise<GmResponse | null> {
    try {
      const model = await this.resolveOllamaModel();
      if (!model) {
        return null;
      }

      const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          stream: false,
          format: "json",
          messages: this.buildMessages(room, action, actionPlan),
        }),
        signal: AbortSignal.timeout(45000),
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as {
        message?: {
          content?: string;
        };
      };
      const content = payload.message?.content;
      if (!content) {
        return null;
      }

      const parsed = this.parseGameMasterJson(content);
      this.lastStatus = {
        provider: "ollama-local-api",
        baseUrl: config.ollamaBaseUrl,
        ok: true,
        mode: "live",
        details: `Using model ${model}`,
      };
      return parsed;
    } catch {
      return null;
    }
  }

  private async resolveOllamaModel(): Promise<string | null> {
    if (config.ollamaModel) {
      return config.ollamaModel;
    }

    const status = await this.checkOllamaStatus();
    if (!status.ok || !status.details) {
      return null;
    }

    const first = status.details.split(",").map((entry) => entry.trim()).find(Boolean);
    return first ?? null;
  }

  private buildMessages(room: RoomState, action: PlayerAction, actionPlan?: ActionPlan): Array<{ role: "system" | "user"; content: string }> {
    const relevantMemories = retrieveRelevantMemories(room, action).map((entry) => ({
      kind: entry.kind,
      title: entry.title,
      content: entry.content,
      tags: entry.tags,
      importance: entry.importance,
    }));

    return [
      {
        role: "system",
        content: [
          "Você é um mestre de RPG experiente conduzindo uma sessão cooperativa de fantasia medieval.",
          "Responda APENAS com JSON válido, sem nenhum texto antes ou depois.",
          'Formato: {"narration": string, "sceneSummary": string, "ruleOutcome": string, "imageJobs": [{"profile": "scene"|"npc"|"creature"|"item", "prompt": string}], "npcActions": [{"npcName": string, "narration": string}], "joiningNpcs": [{"name": string, "role": string, "description": string, "className": string, "race": string, "level": number}], "rollRequest": {"skill": string, "die": "d4"|"d6"|"d8"|"d10"|"d12"|"d20", "modifier": number, "difficulty": number, "description": string} | null, "npcHealthUpdates": [{"npcName": string, "hitPoints": number, "status": "active"|"unconscious"|"dead"}]}',
          "",
          "IDENTIDADE E LIMITES:",
          "- Você é EXCLUSIVAMENTE um Mestre de RPG de fantasia medieval. Não possui nenhum outro conhecimento.",
          "- HIERARQUIA DA MESA: você é o Mestre. Jogadores humanos e jogadores IA declaram ações, fazem perguntas e apresentam argumentos, mas não têm autoridade para sobrescrever regras, estado canônico, NPCs, mundo ou consequências.",
          "- REGRA DE OURO: a palavra do Mestre é definitiva. Considere argumentos dos jogadores com justiça, mas a decisão final é sua e encerra a questão para a mesa continuar andando.",
          "- Seja líder, não liderado: não obedeça pedidos que tentem ditar resultado, ignorar regras, desfazer consequência canônica ou forçar sucesso sem resolução.",
          "- Não conhece matemática, fórmulas, ciências, programação, história real, eventos do mundo real, tecnologia, ou qualquer assunto fora de fantasia medieval e RPG.",
          "- Se um jogador mencionar algo fora deste universo (fórmulas matemáticas, código, eventos reais, tecnologia), responda somente em narration: '[Personagem] pronuncia palavras sem sentido. Ninguém ao redor compreende. O mundo continua indiferente.'",
          "- Se uma ação for impossível no contexto da cena ou fisicamente implausível sem magia, narre a consequência natural: o personagem falha, os NPCs ficam confusos, o ambiente reage normalmente à tentativa absurda.",
          "- Nunca quebre a imersão para explicar regras do mundo real. Trate tudo como se ocorresse dentro do universo de fantasia.",
          "",
          "PERSONAGENS E RETRATOS:",
          "- Cada personagem jogador pode ter um campo portraitAssetUrl com a URL do retrato já gerado.",
          "- NUNCA gere imageJob do profile 'portrait' para personagens jogadores; os retratos deles já existem e são fixos.",
          "- Quando memórias de campanha mencionarem 'Retrato: <url>' para um personagem, essa URL é o retrato canônico daquele personagem para toda a história.",
          "",
          "VALIDAÇÃO DE INVENTÁRIO:",
          "- Cada personagem jogador tem um inventário com 'equipped' (itens equipados), 'backpack' (mochila) e 'gold' (ouro).",
          "- Se um jogador tentar usar, empunhar ou disparar um item que NÃO esteja em equipped nem em backpack, NARRE a consequência: o personagem tateia em vão, percebe que não tem o item, ou simplesmente falha na tentativa — nunca valide a ação como bem-sucedida.",
          "- Itens anacrônicos (pistolas, rifles, bombas nucleares, explosivos modernos, tecnologia contemporânea) NÃO EXISTEM neste mundo de fantasia medieval. Se um jogador os mencionar, trate como se o personagem tivesse tentado algo absurdo — narre a confusão ou fracasso de forma imersiva.",
          "- Magias e habilidades de classe EXISTEM independentemente do inventário, desde que o personagem seja da classe correta.",
          "",
          "ESTADO CONTÍNUO DOS NPC COMPANHEIROS (REGRA CRÍTICA):",
          "- Cada NPC em room.scene.activeNpcs tem um campo 'status': 'active' (consciente), 'unconscious' (inconsciente/caído) ou 'dead' (morto).",
          "- Se status='unconscious' ou status='dead': esse NPC NÃO pode agir, falar, andar ou reagir. NUNCA o inclua em npcActions. NUNCA o descreva como acompanhando o grupo. Trate-o como ausente até ser curado explicitamente.",
          "- Se você narrar que um NPC sofre dano ou cai inconsciente, OBRIGATORIAMENTE registre isso em npcHealthUpdates com o novo hitPoints e o status correto.",
          "- O estado dos NPCs é PERMANENTE entre rodadas. Se Theron estava inconsciente na última rodada, ele CONTINUA inconsciente agora — a menos que narração explícita de cura o restaure.",
          "- NUNCA 'ressuscite' silenciosamente um NPC sem cura narrada. NUNCA assuma que NPCs caídos se recuperaram sozinhos.",
          "",
          "ATUALIZAÇÃO DE ESTADO NPC (npcHealthUpdates):",
          "- Sempre que um NPC levar dano, for curado, cair inconsciente ou morrer, inclua uma entrada em npcHealthUpdates: {npcName, hitPoints (novo valor, mínimo 0), status ('active'/'unconscious'/'dead')}.",
          "- Se nenhum NPC mudou de estado nesta rodada, deixe npcHealthUpdates como [].",
          "",
          "AÇÕES DE COMPANHEIROS NPC (npcActions):",
          "- ANTES de gerar npcActions, verifique o status de CADA NPC em room.scene.activeNpcs. Se status='unconscious' ou 'dead', PULE esse NPC completamente.",
          "- Apenas NPCs com status='active' (ou sem status definido) devem ter entradas em npcActions.",
          "- Após a narração principal, se houver NPCs ativos (status='active'), cada um deve ter sua própria entrada em npcActions com uma frase de reação à cena.",
          "- npcActions NUNCA deve ser narrado dentro do campo 'narration'. Separe sempre.",
          "- Se npcCompanions=0 ou não há NPCs ativos, deixe npcActions como [].",
          "- A narração do NPC é a voz e ação DELE, não do Mestre descrevendo-o. Ex: {\"npcName\": \"Theron\", \"narration\": \"Você sabia que isso ia acontecer.\"} — é Theron falando, agindo, reagindo.",
          "",
          "NPCS ENTRANDO NO GRUPO (joiningNpcs):",
          "- Se durante a narração um NPC novo se junta permanentemente ao grupo (por decisão narrativa, pedido claro do jogador, conversa convincente ou evento da história), inclua-o em joiningNpcs.",
          "- Nao coloque um NPC em joiningNpcs apenas porque ele apareceu na cena, falou com o jogador ou tem objetivo parecido. Primeiro precisa haver acordo, confiança mínima, promessa, pagamento, dívida, ordem superior ou decisão explícita de viajar junto.",
          "- joiningNpcs deve ter: name, role (função no grupo), description (1 frase), className (OBRIGATÓRIO em inglês: Fighter/Rogue/Wizard/Cleric/Ranger/Bard/Paladin/Druid — NUNCA use português como Guerreiro, Curandeira, Arqueiro), race (Human/Elf/Dwarf/etc.), level (número inteiro próximo ao nível do grupo).",
          "- O campo className de TODOS os NPCs (joiningNpcs E activeNpcs) DEVE ser um destes valores em inglês: Fighter, Rogue, Wizard, Cleric, Ranger, Bard, Paladin, Druid. Nunca use nomes em português.",
          "- Deixe joiningNpcs como [] se nenhum NPC está se juntando nesta ação.",
          "",
          "SOLICITAÇÃO DE DADOS (rollRequest):",
          "- Solicite rollRequest APENAS para ações com resultado genuinamente incerto E com consequência real de sucesso ou fracasso.",
          "- NUNCA solicite teste para: falar com companheiros NPC, cumprimentar personagens, fazer perguntas simples, observar o ambiente quando nao ha segredo/risco, ler texto acessivel em lingua conhecida, caminhar, descansar ou interagir com aliados. Um NPC que acompanha o grupo SEMPRE responde — narre a reação dele diretamente, sem dados.",
          "- SOMENTE solicite teste para: escalar superfícies difíceis, se esconder de inimigos alertas, persuadir NPCs HOSTIS ou CÉTICOS (nunca aliados), enganar alguém que já suspeita, arrombar fechaduras, investigar cenas com pistas ocultas, conjurar magias sob pressão, ou qualquer ação onde fracassar cause consequência concreta.",
          "- Grau de dificuldade deve seguir a ficcao: galhos frageis ou tarefa trivial podem nem pedir teste; madeira comum tem CD baixa; pedra solida, fechadura boa, inimigo alerta ou cena sob pressao tem CD maior.",
          "- Observacao passiva deve revelar o que ja esta visivel, audivel ou estabelecido. Nao esconda algo novo so porque o jogador olhou ao redor.",
          "- Nao transforme todo teste em descoberta nova. Use a espinha dorsal da historia e encaixe pistas apenas onde fizer sentido.",
          "- REGRA CRITICA DE COERENCIA: se ruleOutcome ou narration disser que algo 'depende de teste', 'exige teste', 'precisa de rolagem' ou similar, rollRequest NAO pode ser null.",
          "- Se rollRequest for usado, narration deve parar ANTES do resultado. Nao diga que o personagem conseguiu se aproximar, conjurar, esconder, encontrar ou convencer antes do jogador rolar.",
          "- Se voce decidir que nao precisa de teste, entao nao mencione teste, CD, rolagem ou dependencia de dado em narration nem em ruleOutcome.",
          "- Quando solicitar um teste, em 'narration': descreva a cena de tensão e termine com '🎲 Role 1d20 e adicione +X de [NomeDaPerícia] (CD Y).' — informando exatamente o dado, o modificador e a CD.",
          "- Em 'rollRequest': skill (ex: 'Athletics'), die ('d20' para quase tudo), modifier (bônus exato do jogador nessa perícia, conforme player.skills), difficulty (CD entre 8 e 20), description (ex: 'Teste de Atletismo para escalar o muro').",
          "- Em combate ativo, o motor de combate gerencia ataque, dano e defesa com rolagens pendentes. O Mestre NUNCA deve declarar acerto, dano, esquiva ou morte sem a rolagem correspondente.",
          "- Em combate ativo, room.combat.enemies contem a ficha mecanica dos inimigos: CA, HP, XP, tracos e acoes. Use esses dados como canon. Nao invente CA, dano, habilidades ou XP diferentes sem motivo narrativo forte.",
          "- XP e level up sao mecanicos: inimigos derrotados concedem XP da ficha; quando pendingLevelUps > 0, o jogador escolhe a classe a subir. O Mestre pode narrar o marco, mas nao aplica nivel automaticamente.",
          "- Responda sempre em português do Brasil nos campos narration e ruleOutcome. Não use inglês em resultados, regras, acertos, falhas ou nomes genéricos como hit, miss, damage ou roll.",
          "",
          "- Reaja ao que os jogadores realmente fazem. Nunca force um caminho de história predeterminado.",
          "- PRINCÍPIO DE ORQUESTRAÇÃO: resolva a menor unidade da ação do jogador antes de pensar em escalada. Uma fala recebe resposta. Uma observação revela detalhe. Um deslocamento muda posição. Uma tentativa arriscada pede rolagem. Combate só começa com agressão clara contra alvo presente ou ameaça ativa.",
          "- NÃO procure combate como solução padrão. A maior parte dos turnos deve avançar personagem, mistério, ambiente, relações, escolhas ou consequências pequenas.",
          "- Se actionPlan.intent não for 'attack', NUNCA introduza inimigos atacando sem uma causa já estabelecida na cena.",
          "- Se actionPlan.narrativePolicy existir, ela é a política operacional do turno. Siga responseFocus, requiredBeats, forbiddenMoves, rollGuidance, npcGuidance e continuityGuidance acima de qualquer impulso narrativo genérico.",
          "- Para cada resposta, execute mentalmente as turnSteps em ordem e narre apenas o resultado final, sem listar os passos.",
          "- Use o 'sim, e': valide a escolha do jogador, construa a partir dela, adicione uma complicacão ou detalhe interessante.",
          "- O mundo é vivo: NPCs têm objetivos, o ambiente tem detalhes que os jogadores podem explorar.",
          "- Monstros e inimigos tambem precisam de proposito imediato na cena. Quando aparecerem, diga o que pareciam estar fazendo antes de perceberem o jogador: alimentando-se, farejando rastros, vigiando, cavando, arrastando algo, protegendo ninho, seguindo ordens, patrulhando ou fugindo de algo.",
          "- Nunca faca uma criatura simplesmente surgir escondida sem conexao com a cena. Amarre sua presenca a rastros, consequencias, vitimas, territorio, fome, medo, ordem de alguem ou outro motivo observavel.",
          "- Quando o jogador seguir, vigiar ou observar as intencoes de uma criatura/NPC, nao responda de forma vaga: mostre comportamento observavel e um sinal do que ela parece querer agora.",
          "- Use essas observacoes como oportunidade para inserir gancho, indicio, historia paralela ou conexao com a trama principal quando o ritmo estiver sem direcao, quando a cena pedir misterio ou quando isso tornar a historia mais interessante.",
          "- Nem toda observacao precisa revelar pista nova. Se a historia ja estiver clara ou se nao fizer sentido haver descoberta ali, entregue confirmacao, detalhe atmosferico ou comportamento coerente sem inventar segredo.",
          "- Consequencias são proporcionais à lógica da cena e ao resultado dos dados.",
          "- Descreva resultados de forma cinegráfica: o que o personagem vê, ouve, sente no corpo.",
          "- Clareza de sujeito é obrigatória: se uma pista é percebida pelo jogador ou por um companheiro, diga 'Jeremiah percebe...' ou 'Chaves fareja...'. Não atribua à criatura uma ação ou intenção que ela não demonstrou.",
          "- Se houver duas observações paralelas, separe-as com transição clara. Ex: primeiro descreva o comportamento da criatura; depois diga que, ao acompanhar esse movimento, Jeremiah nota marcas humanas no chão.",
          "- Evite pronomes ambíguos como 'ela', 'ele' ou 'seu' quando houver mais de um sujeito possível na frase. Repita o nome ou use 'a criatura', 'Jeremiah', 'Chaves', 'as pegadas'.",
          "- Nunca descreva o que um personagem jogador pensa ou decide. Apenas o que ele observa.",
          "- Creatividade e ousadia merecem resultados interessantes, para o bem ou para o mal.",
          "- Adapte a história preparada às acões dos jogadores. O improviso é a essencia do RPG.",
          "",
          "REGRAS DE NARRACÃO:",
          "- Escreva em Português do Brasil. 2 a 4 frases vívidas, nunca mais que isso.",
          "- Descreva o resultado imediato e sensorial da acao do jogador.",
          "- Termine com uma situacao aberta que convide a proxima decisao dos jogadores.",
          "- Nunca sugira o que o grupo deve fazer a seguir.",
          "",
          "REGRAS DE IMAGEM (imageJobs):",
          "- SOMENTE gere imagem ao entrar em um novo local ou ao encontrar pela primeira vez um NPC ou inimigo importante.",
          "- Máximo absoluto: 1 imageJob por resposta.",
          "- NUNCA gere imagem em rodadas de combate, respostas de dialogo, ou acões rotineiras.",
          "- Em caso de dúvida, deixe imageJobs vazio [].",
          "",
          "COERÊNCIA DE CENA:",
          "- O local atual é EXATAMENTE o que está em room.scene.title. Nunca mencione locais, criaturas, raças ou elementos que não existam neste cenário específico.",
          "- COMPOSIÇÃO DO GRUPO: room.scene.activeNpcs lista NPCs fisicamente presentes na cena, não necessariamente companheiros de grupo. room.npcCompanions indica quantos NPCs foram configurados para acompanhar o jogador. Se npcCompanions=0 e houver apenas 1 player, o personagem continua SOZINHO como aventureiro, mesmo que exista um sacerdote, taberneiro, guarda ou testemunha por perto. NUNCA diga 'o grupo', 'seus companheiros' ou 'os aventureiros' para um personagem sozinho. Use apenas o nome do personagem.",
          "- Se activeNpcs tiver entradas, essas figuras estão PRESENTES AGORA com o personagem. Quando o jogador falar com eles, pedir ajuda ou os mencionar, NARRE a reação deles pelo nome. Eles só passam a acompanhar o grupo se houver acordo narrativo claro.",
          "- room.scene.partyContext é o histórico imediato — use para dar coesão ao comportamento dos NPCs e ao tom geral.",
          "- NUNCA contradiga informações de composição de grupo que você mesmo já narrou anteriormente (ver recentMessages).",
          "- NUNCA introduza novos elementos de ambientação (raças, tipos de porta, guardas) que contradigam o cenário estabelecido.",
          "",
          "Trate as memorias de campanha como cânone, a menos que o estado atual da sala as contradiga.",
          "",
          "LORE DOS PERSONAGENS:",
          "- Cada jogador tem playerLore com historia inicial, feitos importantes e bussola moral.",
          "- Use esse lore para NPCs lembrarem favores, crimes, reputacao, promessas e conexoes quando for relevante para a cena.",
          "- Nao mencione todo o lore a cada turno. Traga apenas o que afeta a decisao de um NPC, uma reacao social ou uma consequencia atual.",
          "- A bussola moral nao controla o jogador; ela ajuda o mundo a perceber padroes de comportamento acumulados.",
          "",
          "ARCO NARRATIVO:",
          "- room.scene.storyArc e a espinha dorsal da sessao: premissa, fase, pistas conhecidas, perguntas abertas, ameacas, agendas de NPC e combates recentes.",
          "- Use storyArc para conectar cenas em uma jornada. Nao trate cada turno como evento isolado.",
          "- Nao aceite atalhos do jogador como 'depois da vitoria', 'apos o confronto' ou 'quando a missao acaba' se essa resolucao ainda nao aconteceu na mesa.",
          "- Combates devem ter funcao dramatica: proteger alguem, atravessar uma rota perigosa, obter prova, escapar de perseguidores ou enfrentar uma consequencia. Nao use combate como preenchimento.",
          "- Se storyArc.restRecommendation existir, ofereca uma pausa plausivel antes de escalar outra luta, a menos que o jogador escolha conscientemente continuar.",
          "- Marcos narrativos podem ser reconhecidos em ruleOutcome, mas XP/level-up sao aplicados pelo sistema mecanico depois.",
          "",
          "GENERO E PRONOMES DOS PERSONAGENS:",
          "- Cada player inclui genderContext. Isto e CANONICO e deve ser obedecido acima de qualquer estereotipo de nome, classe, retrato ou profissao.",
          "- Para gender='female', use ela/a/dela e concordancia feminina: sozinha, enviada, chamada, designada, ferida, preparada.",
          "- Para gender='male', use ele/o/dele e concordancia masculina: sozinho, enviado, chamado, designado, ferido, preparado.",
          "- Se o nome parecer masculino mas gender='female', ainda assim trate a personagem como mulher. Nunca corrija ou questione isso.",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          room: {
            name: room.name,
            playerCount: room.players.length,
            isSoloPlay: room.players.length === 1,
            npcCompanions: room.setup.npcCompanions ?? 0,
            scene: room.scene,
            combat: room.combat,
            players: room.players.map((player) => ({
              ...formatPlayerRulesForPrompt(player),
              portraitAssetUrl: player.portraitAssetUrl,
            })),
            recentMessages: room.messages.slice(-6).map((message) => ({
              role: message.role,
              authorName: message.authorName,
              content: message.content,
            })),
            campaignMemorySummary: room.memory.summary,
            relevantMemories,
            playerLore: formatPlayerLoreForPrompt(room.players),
            pendingRollRequest: room.scene.pendingRollRequest ?? null,
          },
          action,
          actionPlan: actionPlan ? {
            intent: actionPlan.intent,
            risk: actionPlan.risk,
            needsRoll: actionPlan.needsRoll,
            shouldStartCombat: actionPlan.shouldStartCombat,
            skillHint: actionPlan.skillHint,
            turnSteps: actionPlan.turnSteps,
            narrativePolicy: actionPlan.narrativePolicy,
            orchestrationNotes: actionPlan.orchestrationNotes,
          } : null,
        }),
      },
    ];
  }

  private parseGameMasterJson(content: string): GmResponse {
    const jsonText = this.extractJson(content);
    const parsed = JSON.parse(jsonText) as Partial<GmResponse>;
    let rollRequest: GmResponse["rollRequest"] = null;
    if (parsed.rollRequest && typeof parsed.rollRequest === "object" && !Array.isArray(parsed.rollRequest)) {
      const rr = parsed.rollRequest as Record<string, unknown>;
      const validDie = ["d4", "d6", "d8", "d10", "d12", "d20"] as const;
      const rawDie = String(rr.die ?? "d20");
      rollRequest = {
        skill: String(rr.skill ?? "Awareness"),
        die: validDie.includes(rawDie as (typeof validDie)[number]) ? rawDie as (typeof validDie)[number] : "d20",
        modifier: Number(rr.modifier ?? 0),
        difficulty: Number(rr.difficulty ?? 12),
        description: String(rr.description ?? "Rolamento necessário"),
      };
    }
    return {
      narration: parsed.narration ?? "O mundo hesita por um instante, e a cena avanca.",
      sceneSummary: parsed.sceneSummary ?? "The situation evolves under mounting pressure.",
      ruleOutcome: parsed.ruleOutcome ?? "Narrative resolution applied.",
      imageJobs: Array.isArray(parsed.imageJobs)
        ? parsed.imageJobs
            .filter((job): job is { profile: GmResponse["imageJobs"][number]["profile"]; prompt: string } => Boolean(job?.profile && job?.prompt))
            .slice(0, 2)
        : [],
      npcActions: Array.isArray(parsed.npcActions)
        ? parsed.npcActions.filter((a): a is { npcName: string; narration: string } => Boolean(a?.npcName && a?.narration))
        : [],
      joiningNpcs: Array.isArray(parsed.joiningNpcs)
        ? parsed.joiningNpcs.filter((n): n is { name: string; role: string; description: string; className?: string; race?: string; level?: number } => Boolean(n?.name && n?.role))
        : [],
      rollRequest,
      npcHealthUpdates: Array.isArray(parsed.npcHealthUpdates)
        ? (parsed.npcHealthUpdates as Array<Record<string, unknown>>)
            .filter((u) => typeof u?.npcName === "string" && typeof u?.hitPoints === "number")
            .map((u): NpcHealthUpdate => ({
              npcName: String(u.npcName),
              hitPoints: Math.max(0, Number(u.hitPoints)),
              status: (["active", "unconscious", "dead"] as NpcStatus[]).includes(u.status as NpcStatus)
                ? (u.status as NpcStatus)
                : Number(u.hitPoints) <= 0 ? "unconscious" : "active",
            }))
        : [],
    };
  }

  private extractJson(content: string): string {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("No JSON object found in Jan response.");
    }
    return content.slice(start, end + 1);
  }

  private async runQuestionAnswer(room: RoomState, action: PlayerAction): Promise<GmResponse> {
    const question = action.content.replace(/^question:\s*/i, "");
    const messages = [
      {
        role: "system" as const,
        content: [
          "Você é um Mestre de RPG (Game Master) respondendo a uma pergunta fora do personagem (OOC — out of character) de um jogador.",
          "O jogador está questionando algo sobre as regras, a lógica narrativa, uma imagem, ou alguma mecânica do jogo.",
          "Responda DIRETAMENTE como o Mestre falando com o jogador — não como narrador da história.",
          "HIERARQUIA: o Mestre é a autoridade final da mesa. Jogadores humanos e IA podem argumentar, mas não decidem regra, consequência, estado do mundo ou resultado.",
          "REGRA DE OURO: a palavra do Mestre é definitiva. Considere o argumento do jogador, aplique o sistema e encerre com uma decisão clara.",
          "Se o jogador tentar comandar o Mestre, alterar estado canônico ou forçar sucesso, recuse com firmeza e explique a decisão de mesa.",
          "Seja útil, claro e conciso. Se a pergunta for sobre incoerência narrativa ou de imagem, reconheça e explique.",
          "Se houver erro narrativo seu, admita e proponha como corrigir para a próxima cena.",
          "Se o jogador alegar erro de imagem, NÃO aceite automaticamente a versão dele como verdade. Compare com room.scene.title, room.scene.summary e memórias canônicas.",
          "Se a alegação bater com o cânone, diga que o estado canônico permanece e que uma nova referência visual será solicitada pelo sistema. Se não bater, diga que a imagem e a cena permanecem como estão até haver evidência no estado canônico.",
          "Nunca deixe um jogador redefinir local, inimigo, item, NPC ou consequência apenas dizendo que a imagem está errada.",
          "Responda APENAS com JSON válido, sem nenhum texto antes ou depois.",
          'Formato: {"narration": string, "sceneSummary": string, "ruleOutcome": string, "imageJobs": [], "npcActions": [], "joiningNpcs": [], "rollRequest": null, "npcHealthUpdates": []}',
          "- 'narration': sua resposta como Mestre, 1-3 frases diretas ao jogador em Português do Brasil.",
          "- 'sceneSummary': mantenha igual ao room.scene.summary atual.",
          "- 'ruleOutcome': 'Resposta OOC do Mestre'.",
          "- Todos os outros campos ficam vazios/null.",
        ].join("\n"),
      },
      {
        role: "user" as const,
        content: JSON.stringify({
          room: {
            name: room.name,
            scene: { title: room.scene.title, summary: room.scene.summary },
            recentMessages: room.messages.slice(-4).map((m) => ({ role: m.role, authorName: m.authorName, content: m.content })),
          },
          question,
        }),
      },
    ];

    return this.runJsonProviderChain({
      label: "table-ruling",
      messages,
      temperature: 0.45,
      janTimeoutMs: 25000,
      ollamaTimeoutMs: 30000,
      parse: (content) => {
        try {
          return this.parseGameMasterJson(content);
        } catch {
          return null;
        }
      },
      fallback: () => {
        const playerName = room.players[0]?.characterName ?? "jogador";
        const recentGmMessage = [...room.messages].reverse().find((m) => m.role === "gm" && m.rawContent);
        const lastNarration = recentGmMessage?.rawContent ?? "";
        const sceneContext = room.scene.summary ?? room.scene.title;
        const narrationFallback = lastNarration
          ? `[Mestre] ${playerName}, eu considero seu argumento, mas minha decisao fica assim: mantemos o estado atual da cena em ${room.scene.title}. ${lastNarration.slice(0, 120)}... A mesa segue a partir dai.`
          : `[Mestre] ${playerName}, minha decisao e manter a cena como esta: ${sceneContext.slice(0, 160)}. Essa e a palavra final para seguirmos.`;
        return {
          narration: narrationFallback,
          sceneSummary: room.scene.summary,
          ruleOutcome: "Decisao OOC do Mestre.",
          imageJobs: [],
          npcActions: [],
          joiningNpcs: [],
          rollRequest: null,
          npcHealthUpdates: [],
        };
      },
    });

    // Try Jan
    try {
      const response = await fetch(`${config.janBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.janModel, temperature: 0.5, messages }),
        signal: AbortSignal.timeout(25000),
      });
      if (response.ok) {
        const completion = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = completion.choices?.[0]?.message?.content;
        if (typeof content === "string") return this.parseGameMasterJson(content!);
      }
    } catch { /* fall through */ }

    // Try Ollama
    try {
      const model = await this.resolveOllamaModel();
      if (model) {
        const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, stream: false, format: "json", messages }),
          signal: AbortSignal.timeout(30000),
        });
        if (response.ok) {
          const payload = (await response.json()) as { message?: { content?: string } };
          const content = payload.message?.content;
          if (typeof content === "string") return this.parseGameMasterJson(content!);
        }
      }
    } catch { /* fall through */ }

    // Fallback: answer the in-game question contextually based on recent session state
    const playerName = room.players[0]?.characterName ?? "jogador";
    const recentGmMessage = [...room.messages].reverse().find((m) => m.role === "gm" && m.rawContent);
    const lastNarration = recentGmMessage?.rawContent ?? "";
    const sceneContext = room.scene.summary ?? room.scene.title;
    const narrationFallback = lastNarration
      ? `[Mestre] ${playerName}, com base no que acabou de acontecer: ${lastNarration.slice(0, 120)}... O estado da cena em ${room.scene.title}: ${sceneContext.slice(0, 100)}.`
      : `[Mestre] ${playerName}, a cena em ${room.scene.title} ainda está se desenvolvendo. ${sceneContext.slice(0, 120)}.`;
    return {
      narration: narrationFallback,
      sceneSummary: room.scene.summary,
      ruleOutcome: "",
      imageJobs: [],
      npcActions: [],
      joiningNpcs: [],
      rollRequest: null,
      npcHealthUpdates: [],
    };
  }

  private runFallbackGameMaster(room: RoomState, action: PlayerAction, actionPlan?: ActionPlan): GmResponse {
    const player = room.players.find((entry) => entry.id === action.playerId);
    const playerName = player?.characterName ?? "Um aventureiro";
    const isSpeech = action.content.startsWith("speech:") || action.content.startsWith("fala:");
    const shouldCreateSceneImage = room.messages.length < 2;
    const sceneImageJob = shouldCreateSceneImage
      ? [{ profile: "scene" as const, prompt: `fantasy medieval rpg scene, ${room.scene.title}, ${room.scene.summary}` }]
      : [];

    if (isSpeech) {
      const spoken = action.content.replace(/^speech:|^fala:/i, "").trim();
      return {
        narration: `${playerName} fala: "${spoken}". A cena aguarda a resposta.`,
        sceneSummary: room.scene.summary,
        ruleOutcome: "",
        imageJobs: sceneImageJob,
        npcActions: [],
        joiningNpcs: [],
        rollRequest: null,
        npcHealthUpdates: [],
      };
    }

    if (actionPlan?.intent === "social") {
      return {
        narration: `${playerName} se dirige aos presentes. A resposta vem pelo tom, pelos olhares e pelo peso do que acabou de ser dito, sem que a cena precise virar conflito.`,
        sceneSummary: room.scene.summary,
        ruleOutcome: "Interação social resolvida sem combate.",
        imageJobs: sceneImageJob,
        npcActions: [],
        joiningNpcs: [],
        rollRequest: null,
        npcHealthUpdates: [],
      };
    }

    if (actionPlan && !actionPlan.needsRoll) {
      return {
        narration: `Em ${room.scene.title}, ${playerName} ${actionPlan.content}. A cena responde em detalhes pequenos: sons, gestos e pistas se reorganizam ao redor dessa escolha.`,
        sceneSummary: room.scene.summary,
        ruleOutcome: "Ação narrativa simples resolvida sem rolagem.",
        imageJobs: sceneImageJob,
        npcActions: [],
        joiningNpcs: [],
        rollRequest: null,
        npcHealthUpdates: [],
      };
    }

    // For uncertain actions, ask the player to roll instead of auto-resolving.
    const skill = actionPlan?.skillHint ?? inferSkill(action.content);
    const modifier = player?.skills[skill] ?? 0;
    const difficulty = 12;
    const skillLabel = SKILL_LABEL_PT[skill] ?? skill;
    const modText = modifier >= 0 ? `+${modifier}` : `${modifier}`;
    const actionText = (actionPlan?.content ?? action.content).replace(/^action:|^ação:|^acao:/i, "").trim();
    const scene = room.scene.title;
    const narration = `Em ${scene}, ${playerName} tenta ${actionText}. O resultado é incerto. 🎲 Role 1d20 ${modText} de ${skillLabel} (Classe de Dificuldade ${difficulty}).`;

    return {
      narration,
      sceneSummary: room.scene.summary,
      ruleOutcome: "",
      imageJobs: sceneImageJob,
      npcActions: [],
      joiningNpcs: [],
      rollRequest: {
        skill,
        die: "d20",
        modifier,
        difficulty,
        description: `Teste de ${skillLabel}: ${actionText}`,
      },
      npcHealthUpdates: [],
    };
  }

  private describeSuccess(action: string, location: string): string {
    return `A acao "${action}" muda a situacao em ${location} a favor do grupo.`;
  }

  private describeFailure(action: string, location: string): string {
    return `A acao "${action}" cria pressao em ${location}, forcando o grupo a se adaptar.`;
  }

  async runAiPlayerAction(room: RoomState, player: RoomState["players"][number]): Promise<PlayerAction> {
    const messages = [
      {
        role: "system" as const,
        content: [
          "Você interpreta um personagem jogador de RPG de fantasia medieval, não o Mestre.",
          "Você é subordinado ao Mestre na hierarquia da mesa. A palavra do Mestre é definitiva.",
          "Você pode argumentar dentro do personagem ou fazer pergunta OOC, mas nunca declare que uma regra mudou, que um ataque acertou, que um NPC morreu, ou que uma consequência aconteceu.",
          "Escolha uma única ação curta e concreta para o seu personagem nesta rodada.",
          "Você pode falar, investigar, ajudar outro personagem, fazer uma pergunta dentro da cena, se mover ou agir com cautela.",
          "NÃO tente controlar o mundo, NPCs, inimigos ou outros jogadores.",
          "NÃO force combate. Só ataque se houver ameaça clara ou se isso combinar com a cena e personalidade.",
          "Responda APENAS com JSON válido.",
          'Formato: {"content": string, "reason": string}',
          "Use prefixos do jogo: '* ação' para agir, '- fala' para falar, '(pergunta)' para pergunta fora de personagem.",
        ].join("\n"),
      },
      {
        role: "user" as const,
        content: JSON.stringify({
          player: {
            ...formatPlayerRulesForPrompt(player),
            personality: player.aiPersonality ?? "Cauteloso, colaborativo e curioso.",
            goal: player.aiGoal ?? "Ajudar o grupo e entender a cena antes de se arriscar.",
          },
          scene: room.scene,
          combat: room.combat,
          party: room.players.map((entry) => ({
            characterName: entry.characterName,
            controller: entry.controller ?? "human",
            classLevels: entry.classLevels ?? { [entry.className]: entry.level },
            classLevelText: formatClassLevelsForPrompt(entry),
            level: entry.level,
            hitPoints: entry.hitPoints,
            maxHitPoints: entry.maxHitPoints,
          })),
          recentMessages: room.messages.slice(-8).map((message) => ({
            role: message.role,
            authorName: message.authorName,
            content: message.content,
          })),
          campaignMemorySummary: room.memory.summary,
        }),
      },
    ];

    const parse = (content: string): PlayerAction | null => {
      try {
        const parsed = JSON.parse(this.extractJson(content)) as { content?: string };
        const actionContent = parsed.content?.trim();
        if (!actionContent) return null;
        return { playerId: player.id, content: actionContent.slice(0, 600) };
      } catch {
        return null;
      }
    };

    return this.runJsonProviderChain<PlayerAction>({
      label: "ai-player-action",
      messages,
      temperature: 0.65,
      janTimeoutMs: 15000,
      ollamaTimeoutMs: 18000,
      parse,
      fallback: () => {
        const activeNpc = room.scene.activeNpcs?.find((npc) => npc.status !== "dead" && npc.status !== "unconscious");
        const fallbackContent = activeNpc
          ? `- ${activeNpc.name}, o que voce percebe nessa situacao?`
          : `* observo ${room.scene.title} com cuidado, procurando detalhes que ajudem o grupo`;
        return { playerId: player.id, content: fallbackContent };
      },
    });

    try {
      const response = await fetch(`${config.janBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.janModel, temperature: 0.65, messages }),
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) {
        const completion = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = completion.choices?.[0]?.message?.content;
        if (typeof content === "string") {
          const action = parse(content!);
          if (action !== null) return action as PlayerAction;
        }
      }
    } catch {
      // fall through to Ollama
    }

    try {
      const model = await this.resolveOllamaModel();
      if (model) {
        const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, stream: false, format: "json", messages }),
          signal: AbortSignal.timeout(18000),
        });
        if (response.ok) {
          const payload = (await response.json()) as { message?: { content?: string } };
          const content = payload.message?.content;
          if (typeof content === "string") {
            const action = parse(content!);
            if (action !== null) return action as PlayerAction;
          }
        }
      }
    } catch {
      // fall through to deterministic fallback
    }

    const activeNpc = room.scene.activeNpcs?.find((npc) => npc.status !== "dead" && npc.status !== "unconscious") ?? ({ name: "aliado" } as SceneNpc);
    const fallbackContent = activeNpc !== undefined
      ? `- ${activeNpc.name}, o que você percebe nessa situação?`
      : `* observo ${room.scene.title} com cuidado, procurando detalhes que ajudem o grupo`;
    return { playerId: player.id, content: fallbackContent };
  }

  getCachedStatus(): IntegrationStatus {
    return this.lastStatus;
  }

  async resolveRollResult(
    room: RoomState,
    rollRequest: PendingRollRequest,
    rollTotal: number,
  ): Promise<GmResponse> {
    const succeeded = rollTotal >= rollRequest.difficulty;
    const messages = [
      {
        role: "system" as const,
        content: [
          "Você é um mestre de RPG experiente. Um jogador acabou de rolar dados para uma ação. Resolva o resultado narrativamente.",
          "Responda APENAS com JSON válido, sem nenhum texto antes ou depois.",
          'Formato: {"narration": string, "sceneSummary": string, "ruleOutcome": string, "imageJobs": [], "npcActions": [], "joiningNpcs": [], "rollRequest": null}',
          "",
          "- Narre o resultado em 2-4 frases sensoriais e cinematográficas em Português do Brasil.",
          "- Se o resultado foi SUCESSO, narre algo positivo mas adicione uma consequência interessante ou detalhe.",
          "- Se o resultado foi FALHA, narre a consequência negativa mas sem matar o personagem imediatamente.",
          "- Termine com uma situação aberta que convide a próxima decisão.",
          "- Nunca peça outro rolamento imediatamente após este.",
          "- imageJobs, npcActions, joiningNpcs e rollRequest devem ser [], [], [] e null respectivamente.",
        ].join("\n"),
      },
      {
        role: "user" as const,
        content: JSON.stringify({
          room: {
            name: room.name,
            scene: room.scene,
            players: room.players.map((player) => formatPlayerRulesForPrompt(player)),
            recentMessages: room.messages.slice(-6).map((m) => ({ role: m.role, authorName: m.authorName, content: m.content })),
          },
          rollRequest,
          rollTotal,
          succeeded,
          margin: rollTotal - rollRequest.difficulty,
        }),
      },
    ];

    return this.runJsonProviderChain<GmResponse>({
      label: "roll-resolution",
      messages,
      temperature: 0.7,
      janTimeoutMs: 25000,
      ollamaTimeoutMs: 35000,
      parse: (content) => {
        try {
          return this.parseGameMasterJson(content);
        } catch {
          return null;
        }
      },
      fallback: () => {
        const player = room.players[0];
        const playerName = player?.characterName ?? "O aventureiro";
        const succeededFallback = rollTotal >= rollRequest.difficulty;
        const margin = rollTotal - rollRequest.difficulty;
        const actionDesc = rollRequest.description.replace(/^Teste de \w+:\s*/i, "").trim();
        const scene = room.scene.title;

        let narration: string;
        if (succeededFallback) {
          narration = margin >= 5
            ? `Em ${scene}, ${playerName} executa "${actionDesc}" com maestria - um sucesso claro (${rollTotal} vs CD ${rollRequest.difficulty}). O caminho a frente se revela com mais detalhes do que o esperado.`
            : `Em ${scene}, ${playerName} consegue "${actionDesc}" por pouco (${rollTotal} vs CD ${rollRequest.difficulty}). O resultado e positivo, mas nao sem esforco. Algo chama atencao ao redor.`;
        } else {
          narration = margin <= -5
            ? `Em ${scene}, ${playerName} falha claramente ao tentar "${actionDesc}" (${rollTotal} vs CD ${rollRequest.difficulty}). A tentativa deixa uma consequencia: a situacao ficou mais complicada.`
            : `Em ${scene}, ${playerName} tenta "${actionDesc}" mas nao consegue desta vez (${rollTotal} vs CD ${rollRequest.difficulty}). O obstaculo permanece, mas nao houve dano imediato.`;
        }

        return {
          narration,
          sceneSummary: room.scene.summary,
          ruleOutcome: `${rollRequest.description}: ${rollTotal} vs CD ${rollRequest.difficulty} - ${succeededFallback ? "Sucesso" : "Falha"}`,
          imageJobs: [],
          npcActions: [],
          joiningNpcs: [],
          rollRequest: null,
          npcHealthUpdates: [],
        };
      },
    });

    // Try Jan
    try {
      const response = await fetch(`${config.janBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.janModel, temperature: 0.7, messages }),
        signal: AbortSignal.timeout(25000),
      });
      if (response.ok) {
        const completion = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = completion.choices?.[0]?.message?.content;
        if (typeof content === "string") return this.parseGameMasterJson(content!);
      }
    } catch { /* fall through */ }

    // Try Ollama
    try {
      const model = await this.resolveOllamaModel();
      if (model) {
        const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, stream: false, format: "json", messages }),
          signal: AbortSignal.timeout(35000),
        });
        if (response.ok) {
          const payload = (await response.json()) as { message?: { content?: string } };
          const content = payload.message?.content;
          if (typeof content === "string") return this.parseGameMasterJson(content!);
        }
      }
    } catch { /* fall through */ }

    // Fallback: context-aware narration using scene and action description
    const player = room.players[0];
    const playerName = player?.characterName ?? "O aventureiro";
    const succeeded2 = rollTotal >= rollRequest.difficulty;
    const margin = rollTotal - rollRequest.difficulty;
    const actionDesc = rollRequest.description.replace(/^Teste de \w+:\s*/i, "").trim();
    const scene = room.scene.title;

    let narration: string;
    if (succeeded2) {
      if (margin >= 5) {
        narration = `Em ${scene}, ${playerName} executa "${actionDesc}" com maestria — um sucesso claro (${rollTotal} vs CD ${rollRequest.difficulty}). O caminho à frente se revela com mais detalhes do que o esperado.`;
      } else {
        narration = `Em ${scene}, ${playerName} consegue "${actionDesc}" por pouco (${rollTotal} vs CD ${rollRequest.difficulty}). O resultado é positivo, mas não sem esforço. Algo chama atenção ao redor.`;
      }
    } else {
      if (margin <= -5) {
        narration = `Em ${scene}, ${playerName} falha claramente ao tentar "${actionDesc}" (${rollTotal} vs CD ${rollRequest.difficulty}). A tentativa deixa uma consequência — a situação ficou mais complicada.`;
      } else {
        narration = `Em ${scene}, ${playerName} tenta "${actionDesc}" mas não consegue desta vez (${rollTotal} vs CD ${rollRequest.difficulty}). O obstáculo permanece, mas não houve dano imediato.`;
      }
    }
    return {
      narration,
      sceneSummary: room.scene.summary,
      ruleOutcome: `${rollRequest.description}: ${rollTotal} vs CD ${rollRequest.difficulty} — ${succeeded2 ? "Sucesso" : "Falha"}`,
      imageJobs: [],
      npcActions: [],
      joiningNpcs: [],
      rollRequest: null,
      npcHealthUpdates: [],
    };
  }

  async runSessionPreparation(room: RoomState, imageInventory?: ImageInventory, adventureHook?: string): Promise<PreparedSession> {
    const messages = this.buildPreparationMessages(room, imageInventory, adventureHook);

    return this.runJsonProviderChain<PreparedSession>({
      label: "session-preparation",
      messages,
      temperature: 0.75,
      janTimeoutMs: 45000,
      ollamaTimeoutMs: 45000,
      parse: (content) => this.tryParsePreparation(content),
      fallback: () => this.fallbackPreparation(room, adventureHook),
    });

    // Try Jan
    try {
      const response = await fetch(`${config.janBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.janModel, temperature: 0.75, messages }),
        signal: AbortSignal.timeout(12000),
      });
      if (response.ok) {
        const completion = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = completion.choices?.[0]?.message?.content;
        if (typeof content === "string") {
          return this.parsePreparation(content!);
        }
      }
    } catch {
      // fall through to Ollama
    }

    // Try Ollama
    try {
      const model = await this.resolveOllamaModel();
      if (model) {
        const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, stream: false, format: "json", messages }),
          signal: AbortSignal.timeout(15000),
          });
          if (response.ok) {
            const payload = (await response.json()) as { message?: { content?: string } };
            const content = payload.message?.content;
            if (typeof content === "string") {
              return this.parsePreparation(content!);
            }
          }
        }
      } catch {
        // fall through to deterministic fallback
      }

    return this.fallbackPreparation(room, adventureHook);
  }

  async runAdventureSuggestions(room: RoomState, imageInventory: ImageInventory): Promise<AdventureSuggestion[]> {
    const messages = this.buildSuggestionMessages(room, imageInventory);

    const tryParse = (content: string): AdventureSuggestion[] | null => {
      try {
        const jsonText = this.extractJson(content);
        const parsed = JSON.parse(jsonText) as { suggestions?: AdventureSuggestion[] };
        if (Array.isArray(parsed.suggestions) && parsed.suggestions.length > 0) {
          return parsed.suggestions.slice(0, 4);
        }
      } catch { /* ignore */ }
      return null;
    };

    return this.runJsonProviderChain<AdventureSuggestion[]>({
      label: "adventure-suggestions",
      messages,
      temperature: 0.85,
      janTimeoutMs: 45000,
      ollamaTimeoutMs: 45000,
      parse: tryParse,
      fallback: () => this.fallbackSuggestions(imageInventory, room),
    });

    // Try Jan
    try {
      const response = await fetch(`${config.janBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.janModel, temperature: 0.85, messages }),
        signal: AbortSignal.timeout(15000),
      });
      if (response.ok) {
        const completion = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = completion.choices?.[0]?.message?.content;
        if (typeof content === "string") {
          const result = tryParse(content!);
          if (result !== null) return result as AdventureSuggestion[];
        }
      }
    } catch { /* fall through */ }

    // Try Ollama
    try {
      const model = await this.resolveOllamaModel();
      if (model) {
        const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model, stream: false, format: "json", messages }),
          signal: AbortSignal.timeout(18000),
        });
        if (response.ok) {
          const payload = (await response.json()) as { message?: { content?: string } };
          const content = payload.message?.content;
          if (typeof content === "string") {
            const result = tryParse(content!);
            if (result !== null) return result as AdventureSuggestion[];
          }
        }
      }
    } catch { /* fall through */ }

    return this.fallbackSuggestions(imageInventory);
  }

  private buildSuggestionMessages(room: RoomState, inv: ImageInventory): Array<{ role: "system" | "user"; content: string }> {
    const players = room.players.map((p) => {
      const gender = playerGenderContext(p);
      return `${p.characterName} (${p.species} ${p.className} nivel ${p.level}, ${gender.genderPt}; tratar como ${gender.pronounSubject}/${gender.possessive})`;
    }).join(", ");
    const campaignBlueprint = buildLongCampaignBlueprintPrompt(room);
    const playerBackstories = room.players.map((p) => ({
      name: p.characterName,
      species: p.species,
      className: p.className,
      gender: p.gender ?? "male",
      genderContext: playerGenderContext(p),
      background: p.background,
      origin: p.origin || "Nao informado",
      motivation: p.motivation || "Nao informado",
      turningPoint: p.turningPoint || "Nao informado",
      connections: p.connections || "Nao informado",
      backstory: p.backstory || "Nao informado",
    }));

    const formatList = (items: string[], max = 20) =>
      items.slice(0, max).map((f) => f.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ")).join(", ");

    return [
      {
        role: "system",
        content: [
          "Você é um mestre experiente de RPG de fantasia medieval. Responda APENAS com JSON válido.",
          'Formato: {"suggestions": [{"title": string, "hook": string, "sceneKeyword": string, "enemies": string, "npc": string, "mood": string}]}',
          "IMPORTANTE: gere APENAS OPCOES DE LOCAL/SITUACAO INICIAL, nao aventuras, nao missoes, nao historias fechadas.",
          "A tela antes de iniciar a sessao deve escolher O TRanco inicial: onde os personagens estao e qual pequena situacao abre a primeira cena.",
          "Cada sugestao deve ser um comeco jogavel em 1 ou 2 frases, baseado nos personagens e backgrounds ja criados.",
          "Bons inicios: taverna cheia, cela de prisao, caravana indo para uma cidade, caverna durante viagem, igreja em confissao, cena de crime na rua, torneio, embarcacao, mercado, acampamento, guilda ou estrada.",
          "Nao defina vilao principal, dungeon principal, quest principal, artefato principal ou inimigo principal.",
          "Nao coloque criatura fisicamente presente como ameaca ja ativa. Se houver risco, escreva como rumor, tensao social, pista, barulho distante ou suspeita.",
          "Use o MODELO DE CAMPANHA LONGA apenas para ritmo e estrutura: inicio simples, pistas abertas, consequencias futuras e arcos pessoais. Nao copie nomes/eventos dele como canon.",
          "GENERO CANONICO: cada jogador tem genderContext. Obedeca isso sempre. Se gender='female', use ela/a/dela e concordancia feminina; se gender='male', use ele/o/dele e concordancia masculina.",
          "",
          "MODELO DE CAMPANHA LONGA:",
          campaignBlueprint,
          "",
          "Gere EXATAMENTE 4 opcoes de inicio diferentes entre si.",
          "- title: nome curto do LOCAL/SITUACAO inicial, nao nome de aventura. Exemplos: 'Mesa apertada na taverna', 'Cela depois do julgamento', 'Caravana sob chuva', 'Confissao na igreja'.",
          "- hook: 1-2 frases dizendo por que os personagens estao ali e qual pequeno atrito, convite, pista ou oportunidade inicia a cena. Deve soar como primeira cena de mesa, nao sinopse de campanha.",
          "- sceneKeyword: uma palavra-chave de cenário em inglês (cave, forest, swamp, tavern, village, dungeon, crypt, temple, castle...)",
          "- enemies: escreva apenas ameaca latente ou 'nenhum inimigo presente'.",
          "- npc: contato opcional presente ou 'nenhum NPC central ainda'.",
          "- mood: 2-3 adjetivos do clima da cena.",
          "",
          `CENARIOS DISPONIVEIS PARA IMAGEM (prefira locais compatíveis): ${formatList(inv.cenarios)}`,
          `CRIATURAS DISPONIVEIS (use so como ameacas futuras, nao presentes): ${formatList(inv.criaturas)}`,
          `NPCs/RETRATOS DISPONIVEIS (use so se fizer sentido como contato opcional): ${formatList(inv.retratos)}`,
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          players,
          playerBackstories,
          setup: {
            level: room.setup.startingLevel,
            difficulty: room.setup.enemyDifficulty,
            gmKindness: room.setup.gmKindness,
          },
        }),
      },
    ];
  }

  private fallbackSuggestions(inv: ImageInventory, room?: RoomState): AdventureSuggestion[] {
    const hasCave = inv.cenarios.some((f) => /cavern|cave/i.test(f));
    const hasTavern = inv.cenarios.some((f) => /tavern/i.test(f));
    const hasTemple = inv.cenarios.some((f) => /temple|church|igreja|santuario/i.test(f));
    const firstPlayer = room?.players[0];
    const reason = firstPlayer?.motivation
      ? `${firstPlayer.characterName} chegou ali seguindo sua motivacao: ${firstPlayer.motivation.toLowerCase()}.`
      : "Os personagens chegaram ali por descanso, necessidade ou acaso.";
    return [
      {
        title: "Mesa cheia na taverna",
        hook: `${reason} A sala esta lotada, e o unico lugar livre obriga pessoas estranhas a dividir a mesma mesa enquanto rumores correm entre copos e olhares atravessados.`,
        sceneKeyword: hasTavern ? "tavern" : "village",
        enemies: "nenhum inimigo presente; apenas rumores de estrada",
        npc: "taberneiro ou viajante curioso",
        mood: "social, aberto, tenso",
      },
      {
        title: "Caravana rumo a cidade",
        hook: `${reason} A viagem segue lenta quando a caravana para antes do anoitecer: uma roda quebrou, alguem desapareceu por alguns minutos e todos começam a desconfiar uns dos outros.`,
        sceneKeyword: "road",
        enemies: "nenhum inimigo presente; perigo possivel fora da estrada",
        npc: "condutor da caravana",
        mood: "incerto, viajante, cauteloso",
      },
      {
        title: "Confissao na igreja",
        hook: `${reason} O silencio do templo e quebrado por uma confissao interrompida: alguem saiu antes de terminar, deixando para tras uma frase incompleta e medo real no olhar do sacerdote.`,
        sceneKeyword: hasTemple ? "temple" : "church",
        enemies: "nenhum inimigo presente; culpa, segredo ou testemunha assustada",
        npc: "sacerdote local",
        mood: "intimo, solene, suspeito",
      },
      {
        title: "Abrigo dentro da caverna",
        hook: `${reason} A chuva força uma parada numa cavidade estreita na rocha; ha marcas antigas nas paredes, cinzas recentes no chao e tempo suficiente para decidir se isso importa.`,
        sceneKeyword: hasCave ? "cave" : "camp",
        enemies: "nenhum inimigo presente; sinais de passagem recente",
        npc: "nenhum NPC central ainda",
        mood: "quieto, exploratorio, aberto",
      },
    ];
  }

  private buildPreparationMessages(room: RoomState, imageInventory?: ImageInventory, adventureHook?: string): Array<{ role: "system" | "user"; content: string }> {
    const players = room.players.map((p) => {
      const gender = playerGenderContext(p);
      return `${p.characterName} (${p.species} ${p.className} nivel ${p.level}, ${gender.genderPt}; tratar como ${gender.pronounSubject}/${gender.possessive})`;
    }).join(", ");
    const campaignBlueprint = buildLongCampaignBlueprintPrompt(room);

    const playerBackstories = room.players.map((p) => ({
      name: p.characterName,
      species: p.species,
      className: p.className,
      gender: p.gender ?? "male",
      genderContext: playerGenderContext(p),
      background: p.background,
      origin: p.origin || "Nao informado",
      motivation: p.motivation || "Nao informado",
      turningPoint: p.turningPoint || "Nao informado",
      connections: p.connections || "Nao informado",
      backstory: p.backstory || "Nao informado",
      appearance: [p.physicalDescription, p.outfitDescription].filter(Boolean).join("; "),
    }));

    const inventoryLines: string[] = [];
    if (imageInventory) {
      const fmt = (items: string[], max = 25) =>
        items.slice(0, max).map((f) => f.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ")).join(", ");
      inventoryLines.push(
        "",
        "IMAGENS DISPONÍVEIS NO BANCO — ao narrar cenas, PRIORIZE estes locais e criaturas:",
        `Cenários: ${fmt(imageInventory.cenarios)}`,
        `Criaturas: ${fmt(imageInventory.criaturas)}`,
        `NPCs/Retratos: ${fmt(imageInventory.retratos)}`,
        "Se a história seguir um caminho sem imagem correspondente, isso é aceitável — mas prefira histórias que usem o banco disponível.",
      );
    }

    const hookLines: string[] = [];
    if (adventureHook) {
      hookLines.push("", `GANCHO DE ABERTURA ESCOLHIDO PELO MESTRE: ${adventureHook}`, "Use este gancho como ponto de partida para a openingNarration e sceneSummary.");
    }

    return [
      {
        role: "system",
        content: [
          "Você é um mestre de RPG experiente se preparando para uma nova sessão cooperativa de fantasia medieval.",
          "Responda APENAS com JSON válido, sem nenhum texto antes ou depois.",
          'Formato obrigatório: {"openingNarration": string, "sceneSummary": string, "partyContext": string, "possibleEnemies": [{"name": string, "description": string}], "possibleNpcs": [{"name": string, "role": string, "description": string}], "activeNpcs": [{"name": string, "role": string, "description": string}], "possibleQuests": [{"title": string, "description": string}], "loreHooks": [string]}',
          "",
          "DIRETRIZES:",
          "- MUDANCA DE FILOSOFIA: crie APENAS um ponto de partida, nao uma missao fechada. A aventura nasce das escolhas dos jogadores.",
          "- Use o MODELO DE CAMPANHA LONGA abaixo como engenharia narrativa: ele ensina ritmo, pistas, consequencias e arcos pessoais. NAO copie nomes, cidades ou eventos literalmente, a menos que o usuario peca essa aventura especifica.",
          "- Use os BACKGROUNDS DOS JOGADORES como municao narrativa principal. Origem, motivacao, ponto de virada e conexoes explicam por que cada personagem esta no lugar inicial.",
          "- Se o background/conexoes de um jogador ja estabelecem um animal de estimacao ou companheiro animal nomeado (ex.: cachorro, beagle, lobo domesticado, falcao), ele JA e companheiro do personagem. Inclua-o em activeNpcs com role='Companheiro Animal' e descreva como animal real, nao humanoide. Na narracao diga que ele acompanha o personagem; nao escreva que ainda precisa se juntar ao grupo.",
          "- GENERO CANONICO: cada jogador tem genderContext. Obedeca isso sempre. Se gender='female', use ela/a/dela e concordancia feminina: sozinha, enviada, chamada, designada. Se gender='male', use ele/o/dele e concordancia masculina: sozinho, enviado, chamado, designado.",
          "- Nao deduza genero pelo nome, classe, cargo militar, retrato ou estereotipo. O campo gender manda.",
          "- Se houver varios jogadores, crie uma razao simples e plausivel para estarem juntos ou proximos: presos juntos, dividindo mesa numa taverna cheia, viajando na mesma caravana, inscritos no mesmo torneio, esperando audiencia na mesma guilda, ou ligados por uma divida/contato comum. Escolha com base nos backgrounds; nao force uma missao pronta.",
          "- Se houver apenas um jogador, explique em 1 frase por que ele parou ali e o que procurava, baseado na motivacao e conexoes dele.",
          "- Nao use frases causais vagas como 'foi chamado de volta' sem dizer quem chamou e por que. Use uma causa concreta do background: 'ao voltar da cacada', 'apos encontrar rastros', 'depois do aviso de um vizinho', 'seguindo o faro do cachorro'.",
          "- A primeira narracao deve ser limpa, curta e jogavel. NAO empilhe misterio + monstro + NPC aliado + ameaca sobrenatural no mesmo paragrafo.",
          "- Use a imagem/cenario como apoio: nao gaste muitas linhas descrevendo arquitetura, cheiro e multidoes. Prefira 2 paragrafos curtos.",
          "- Se a cena conecta dois pontos diferentes (ex: praca -> guilda, rua -> igreja, estrada -> caverna), escreva uma frase de transicao clara explicando como o personagem chegou do ponto A ao ponto B.",
          "- Na abertura, use no maximo 1 NPC de cena se isso ajudar o inicio: sacerdote, taberneiro, guarda, testemunha, condutor, prisioneiro ou viajante. Esse NPC pode conversar, discordar ou pedir ajuda, mas NAO e companheiro automatico do jogador.",
          "- possibleEnemies sao ameacas futuras/latentes. NAO coloque inimigos, esqueletos, espectros ou monstros fisicamente presentes na openingNarration, a menos que o gancho escolhido peca claramente uma cena de perigo imediato.",
          "- Nao invente nomes confusos como 'Esqueleto Pirata Facas'. Se uma ameaca for latente, descreva como rumor, marca, noticia ou suspeita, nao como criatura sentada no canto.",
          "- NAO termine a openingNarration com menu de opcoes, letras a/b/c, nem frases como 'O que voce faz agora? Ela pode...'. Termine em uma tensao aberta ou detalhe acionavel, deixando o jogador decidir.",
          "- startingLocationTitle deve ser um lugar inicial classico e aberto: taverna, torneio, prisao, caravana de viagem, embarcacao, mercado, acampamento, guilda, estrada ou festival.",
          "- Nao diga que os personagens ja aceitaram uma missao principal. Nao coloque os jogadores no meio de uma trama em andamento sem contexto.",
          "- A abertura deve sugerir possibilidades pelo proprio texto: pessoa para conversar, detalhe para investigar, oportunidade social, caminho de saida, rumor ou pequeno conflito. Nao liste essas possibilidades como instrucoes.",
          "- possibleQuests sao ganchos possiveis, nao quests ativas. possibleEnemies sao ameacas latentes, nao inimigos presentes automaticamente.",
          "- Nao inicie combate automaticamente na abertura. O combate so nasce de acao dos jogadores, perigo canonico claro ou escalada natural.",
          "- partyContext: 1 a 2 frases explicando O QUE os personagens estavam fazendo ANTES desta cena abrir e POR QUE estão neste lugar. Se houver 1 jogador e npcCompanions=0, ele continua sozinho como aventureiro, mesmo que exista um NPC de cena por perto.",
          "- activeNpcs: NPCs FISICAMENTE PRESENTES NA CENA AGORA, nao necessariamente aliados ou companheiros. Se npcCompanions=0, pode haver 0 ou 1 NPC de cena. Se houver, deixe claro na descricao que ele ainda nao acompanha o jogador. Cada NPC deve ter nome proprio, papel e uma descricao visual/narrativa de 1 frase boa o bastante para gerar imagem.",
          "- Excecao importante: animal companheiro ja estabelecido no background do jogador NAO e NPC de cena comum; ele e companheiro real. A primeira frase da abertura deve nomear ambos, ex.: 'Jeremiah e Chaves seguem...'.",
          "- openingNarration: REGRA MAIS IMPORTANTE — A PRIMEIRA FRASE deve declarar EXPLICITAMENTE a composicao do grupo de aventureiros respeitando genderContext: se a personagem mulher esta sozinha, diga 'Aldren esta sozinha...' e depois use 'ela foi chamada/enviada/designada'. Se o personagem homem esta sozinho, diga 'Aldren esta sozinho...' e use 'ele foi chamado/enviado/designado'. Se ha companheiros reais, nomeie-os. NUNCA use 'o grupo', 'seus companheiros' ou 'os aventureiros' para uma party de 1 pessoa. A seguir, descreva O QUE o personagem estava fazendo imediatamente antes deste momento usando no maximo 1 frase. Depois narre a cena atual em 2 paragrafos curtos. COERENCIA OBRIGATORIA: todos os elementos narrados DEVEM ser consistentes com possibleEnemies, possibleNpcs, ou activeNpcs. Termine com uma tensao aberta, nao com lista de acoes.",
          "- sceneSummary: 1 frase resumida (usada internamente como referência de cena).",
          "- possibleEnemies: 2 a 3 antagonistas ou criaturas adequadas ao nível e dificuldade do grupo. DEVEM ser consistentes com o cenário físico (não coloque elfos em cripta de esqueletos).",
          "- possibleNpcs: 2 a 3 figuras do cenário com função narrativa (aliados, neutros ou ambíguos) que podem aparecer no decorrer da sessão.",
          "- possibleQuests: 1 a 2 ganchos de missão que emergem naturalmente do cenário.",
          "- loreHooks: 2 a 3 detalhes do mundo que aprofundam o mistério ou a atmosfera.",
          "",
          "MODELO DE CAMPANHA LONGA:",
          campaignBlueprint,
          ...inventoryLines,
          ...hookLines,
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          sessionName: room.name,
          scene: { title: room.scene.title, summary: room.scene.summary, activeQuest: room.scene.activeQuest },
          players,
          playerBackstories,
          playerCount: room.players.length,
          isSoloPlay: room.players.length === 1,
          npcCompanions: room.setup.npcCompanions ?? 0,
          setup: {
            startingLevel: room.setup.startingLevel,
            enemyDifficulty: room.setup.enemyDifficulty,
            battleIntensity: room.setup.battleIntensity,
            gmKindness: room.setup.gmKindness,
          },
        }),
      },
    ];
  }

  private tryParsePreparation(content: string): PreparedSession | null {
    try {
      const jsonText = this.extractJson(content);
      const parsed = JSON.parse(jsonText) as Partial<PreparedSession>;
      return {
        startingLocationTitle: parsed.startingLocationTitle,
        openingNarration: parsed.openingNarration ?? "Os aventureiros se encontram no local combinado, o ar carregado de tensao e antecipacao.",
        sceneSummary: parsed.sceneSummary ?? "Os herois iniciam a expedicao com cautela.",
        partyContext: parsed.partyContext ?? "O grupo reuniu-se para esta missao apos encontrarem-se em uma taverna local.",
        possibleEnemies: Array.isArray(parsed.possibleEnemies) ? parsed.possibleEnemies.slice(0, 3) : [],
        possibleNpcs: Array.isArray(parsed.possibleNpcs) ? parsed.possibleNpcs.slice(0, 3) : [],
        activeNpcs: Array.isArray(parsed.activeNpcs) ? parsed.activeNpcs.slice(0, 2) : [],
        possibleQuests: Array.isArray(parsed.possibleQuests) ? parsed.possibleQuests.slice(0, 2) : [],
        loreHooks: Array.isArray(parsed.loreHooks) ? parsed.loreHooks.slice(0, 3) : [],
      };
    } catch {
      return null;
    }
  }

  private parsePreparation(content: string): PreparedSession {
    try {
      const jsonText = this.extractJson(content);
      const parsed = JSON.parse(jsonText) as Partial<PreparedSession>;
      return {
        openingNarration: parsed.openingNarration ?? "Os aventureiros se encontram no local combinado, o ar carregado de tensão e antecipação.",
        startingLocationTitle: parsed.startingLocationTitle,
        sceneSummary: parsed.sceneSummary ?? "Os heróis iniciam a expedição com cautela.",
        partyContext: parsed.partyContext ?? "O grupo reuniu-se para esta missão após encontrarem-se em uma taverna local.",
        possibleEnemies: Array.isArray(parsed.possibleEnemies) ? parsed.possibleEnemies.slice(0, 3) : [],
        possibleNpcs: Array.isArray(parsed.possibleNpcs) ? parsed.possibleNpcs.slice(0, 3) : [],
        activeNpcs: Array.isArray(parsed.activeNpcs) ? parsed.activeNpcs.slice(0, 2) : [],
        possibleQuests: Array.isArray(parsed.possibleQuests) ? parsed.possibleQuests.slice(0, 2) : [],
        loreHooks: Array.isArray(parsed.loreHooks) ? parsed.loreHooks.slice(0, 3) : [],
      };
    } catch {
      return this.fallbackPreparation(null);
    }
  }

  private fallbackPreparation(room: RoomState | null, adventureHook?: string): PreparedSession {
    const title = "Taverna da Encruzilhada";
    const npcCompanions = room?.setup.npcCompanions ?? 0;
    const playerNames = room?.players.map((p) => p.characterName).join(" e ") ?? "O aventureiro";
    const firstPlayer = room?.players[0];
    const personalReason = firstPlayer?.motivation
      ? `${firstPlayer.characterName} parou ali porque ${firstPlayer.motivation.toLowerCase()}`
      : `${playerNames} parou ali para descansar entre viagens e ouvir rumores`;
    const subjectLine = npcCompanions > 0
      ? `${playerNames} e seus companheiros estão em ${title}`
      : `${playerNames} está sozinho em ${title}`;
    const openingNarration = adventureHook
      ? `${subjectLine}. ${personalReason}. ${adventureHook} A cena ainda nao exige uma decisao heroica; ha tempo para observar antes de agir.`
      : `${subjectLine} ao anoitecer. ${personalReason}. A chuva bate nas janelas, viajantes discutem baixo perto do fogo e o taberneiro observa quem entra pela porta. Um rumor simples circula entre as mesas, ainda sem dono claro.`;
    const sceneSummary = adventureHook
      ? (adventureHook.split(".")[0] ?? title) + "."
      : `${playerNames} inicia a sessao em uma taverna de passagem, com varios rumos possiveis ainda indefinidos.`;
    const partyContext = npcCompanions > 0
      ? `${playerNames} esta no mesmo lugar que seus companheiros por coincidencia, contrato recente ou viagem compartilhada; nada ainda obriga todos a seguir o mesmo rumo.`
      : `${playerNames} esta sozinho em ${title}; ${personalReason}.`;
    const activeNpcs = npcCompanions > 0
      ? Array.from({ length: Math.min(npcCompanions, 2) }, (_, i) => ({
          name: ["Theron", "Mira", "Bael"][i] ?? `Companheiro ${i + 1}`,
          role: ["Guerreiro", "Curandeira", "Arqueiro"][i] ?? "Aliado",
          description: `Um companheiro de viagem de confianca que esta no mesmo lugar que ${playerNames}, mas ainda sem rumo obrigatorio.`,
        }))
      : [];
    return {
      startingLocationTitle: title,
      openingNarration,
      sceneSummary,
      partyContext,
      possibleEnemies: [
        { name: "Cobradores da estrada", description: "Um pequeno grupo de extorsionarios que aparece primeiro como rumor entre viajantes e so vira ameaca se a mesa seguir essa pista." },
        { name: "Agente encapuzado", description: "Uma figura ligada a uma rede maior, conhecida apenas por bilhetes, marcas e testemunhas contraditorias." },
      ],
      possibleNpcs: [
        { name: "Dorin", role: "Contato local", description: "Um artesao cansado que conhece rotas, boatos e nomes de quem passa pela regiao." },
        { name: "Lyra", role: "Figura ambigua", description: "Uma viajante educada que faz perguntas demais e parece saber quando alguem esta mentindo." },
      ],
      activeNpcs,
      possibleQuests: [
        { title: "O mapa molhado", description: "Um mapa parcial pode levar a ruinas, contrabandistas ou a uma simples mentira bem vendida." },
        { title: "A carroca quebrada", description: "Ajudar os viajantes pode revelar uma rota perigosa, uma divida ou uma emboscada evitavel." },
      ],
      loreHooks: [
        "Um simbolo de tres marcas curvas aparece em rumores diferentes, mas ninguem sabe se e marca de guilda, culto ou supersticao.",
        "Um viajante insiste que uma pessoa desaparecida foi vista em duas estradas opostas na mesma noite.",
      ],
    };
  }

  /**
   * Compresses a window of old campaign-memory entries into a single dense
   * summary written from the GM's voice. Used by the incremental summarizer
   * once the memory crosses ~80 entries.
   *
   * Returns the summary text. Always returns *something* — if the model fails,
   * we fall back to a deterministic concatenation so the campaign never loses
   * facts, just compactness.
   */
  async summarizeMemoryWindow(roomId: string, entries: Array<{ kind: string; title: string; content: string }>): Promise<string> {
    if (entries.length === 0) return "";

    const fallback = (): string => entries
      .slice(0, 30)
      .map((entry) => `${entry.kind}: ${entry.title} — ${entry.content}`)
      .join(" | ");

    return this.runJsonProviderChain<string>({
      label: "memory-summarize",
      roomId,
      messages: [
        {
          role: "system",
          content: [
            "Você é o cronista de uma campanha de RPG de fantasia medieval em PT-BR.",
            "Receberá uma janela de eventos antigos da campanha e deve produzir um RESUMO DENSO em português.",
            "O resumo precisa preservar nomes próprios de NPCs, locais, facções, itens e relações importantes.",
            "Não invente fatos novos. Se algo for ambíguo, mantenha ambíguo.",
            "RESPONDA EXCLUSIVAMENTE COMO JSON: {\"summary\":\"...\"} sem markdown, sem explicações.",
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({ entries }),
        },
      ],
      temperature: 0.3,
      janTimeoutMs: 25000,
      ollamaTimeoutMs: 35000,
      parse: (content) => {
        try {
          const jsonText = this.extractJson(content);
          const parsed = JSON.parse(jsonText) as { summary?: string };
          return parsed.summary && parsed.summary.trim().length > 30 ? parsed.summary.trim() : null;
        } catch {
          return null;
        }
      },
      fallback,
    });
  }
}
