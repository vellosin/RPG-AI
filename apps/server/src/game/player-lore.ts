import { nanoid } from "nanoid";
import type { GmResponse, MoralProfile, Player, PlayerAction, PlayerLoreCategory, PlayerLoreEvent, PlayerLoreImportance, RoomState } from "./types.js";

type MoralAxis = Exclude<keyof MoralProfile, "label">;

const moralAxes: MoralAxis[] = ["compassion", "cruelty", "honesty", "deceit", "lawfulness", "chaos", "courage", "selfishness"];

const clamp = (value: number): number => Math.max(-10, Math.min(10, Math.round(value)));

export const deriveMoralLabel = (profile: Omit<MoralProfile, "label">): string => {
  const good = profile.compassion + profile.honesty + profile.courage;
  const dark = profile.cruelty + profile.deceit + profile.selfishness;
  const order = profile.lawfulness - profile.chaos;

  if (good >= dark + 5 && profile.courage >= 3) return "protetor corajoso";
  if (good >= dark + 4) return "alma compassiva";
  if (dark >= good + 5 && profile.cruelty >= 3) return "ameaca cruel";
  if (dark >= good + 4) return "oportunista sombrio";
  if (order >= 4) return "disciplinado pela ordem";
  if (order <= -4) return "espirito rebelde";
  if (profile.deceit >= 4) return "manipulador cuidadoso";
  if (profile.selfishness >= 4) return "sobrevivente egoista";
  return "em formacao";
};

export const defaultMoralProfile = (): MoralProfile => ({
  compassion: 0,
  cruelty: 0,
  honesty: 0,
  deceit: 0,
  lawfulness: 0,
  chaos: 0,
  courage: 0,
  selfishness: 0,
  label: "em formacao",
});

const normalizeMoralProfile = (profile?: Partial<MoralProfile>): MoralProfile => {
  const base = defaultMoralProfile();
  const merged = { ...base, ...profile };
  const withoutLabel = Object.fromEntries(moralAxes.map((axis) => [axis, clamp(Number(merged[axis] ?? 0))])) as Omit<MoralProfile, "label">;
  return { ...withoutLabel, label: profile?.label || deriveMoralLabel(withoutLabel) };
};

const eventId = (playerName: string, category: string, value: string): string =>
  `lore-${playerName.toLowerCase().replace(/[^a-z0-9]+/gi, "-")}-${category}-${Math.abs(hashText(value)).toString(36)}`;

const hashText = (value: string): number => {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
};

const compact = (value?: string): string => (value ?? "").replace(/\s+/g, " ").trim();

const makeInitialEvent = (player: Pick<Player, "characterName">, category: PlayerLoreCategory, title: string, summary: string): PlayerLoreEvent => ({
  id: eventId(player.characterName, category, summary),
  category,
  title,
  summary,
  importance: "notable",
  createdAt: new Date().toISOString(),
});

export const buildInitialPlayerLore = (player: Pick<Player, "characterName" | "origin" | "motivation" | "turningPoint" | "connections" | "backstory">): PlayerLoreEvent[] => {
  const events: PlayerLoreEvent[] = [];
  const origin = compact(player.origin);
  const motivation = compact(player.motivation);
  const turningPoint = compact(player.turningPoint);
  const connections = compact(player.connections);
  const backstory = compact(player.backstory);

  if (origin) events.push(makeInitialEvent(player, "origin", "Origem", origin));
  if (motivation) events.push(makeInitialEvent(player, "motivation", "Motivacao", motivation));
  if (turningPoint) events.push(makeInitialEvent(player, "turning_point", "Ponto de virada", turningPoint));
  if (connections) events.push(makeInitialEvent(player, "connection", "Conexoes", connections));
  if (backstory && !events.some((entry) => entry.summary === backstory)) {
    events.push(makeInitialEvent(player, "origin", "Historia de fundo", backstory));
  }

  return events.slice(0, 6);
};

export const normalizePlayerLore = (player: Player): Player => {
  const existing = Array.isArray(player.loreEvents) ? player.loreEvents : [];
  const initial = buildInitialPlayerLore(player);
  const ids = new Set(existing.map((entry) => entry.id));
  const merged = [
    ...existing,
    ...initial.filter((entry) => !ids.has(entry.id)),
  ];
  return {
    ...player,
    loreEvents: merged.slice(-40),
    moralProfile: normalizeMoralProfile(player.moralProfile),
  };
};

const includesAny = (text: string, terms: string[]): boolean => terms.some((term) => text.includes(term));

const determineImportance = (text: string): PlayerLoreImportance => {
  if (includesAny(text, ["cidade", "reino", "templo", "guilda", "nobre", "senhor", "capitao", "lider", "crianca", "familia", "multidao", "testemunha"])) {
    return "major";
  }
  if (includesAny(text, ["artefato", "reliquia", "lenda", "mitica", "ancestral", "rei", "rainha", "deus", "demonio"])) {
    return "legendary";
  }
  return "notable";
};

const classifyCategory = (text: string): PlayerLoreCategory | null => {
  if (includesAny(text, ["salv", "resgat", "protege", "curou", "cura ", "poup", "defendeu"])) return "achievement";
  if (includesAny(text, ["promet", "jurou", "juramento", "voto"])) return "promise";
  if (includesAny(text, ["favor", "divida", "deve a", "devedor"])) return "favor";
  if (includesAny(text, ["amizade", "aliado", "confianca", "vinculo", "companheiro"])) return "bond";
  if (includesAny(text, ["rival", "inimigo", "vinganca", "cacador", "perseguindo"])) return "enemy";
  if (includesAny(text, ["roub", "furt", "assassin", "matou inocente", "crime", "incendi", "tortur", "chantag", "traiu"])) return "crime";
  if (includesAny(text, ["conhecido como", "fama", "reputacao", "boato", "titulo", "apelido"])) return "reputation";
  if (includesAny(text, ["consequencia", "banido", "procurado", "marcado", "punido", "acusado"])) return "consequence";
  return null;
};

const moralDeltaFor = (text: string): Partial<Omit<MoralProfile, "label">> => {
  const delta: Partial<Omit<MoralProfile, "label">> = {};
  const add = (axis: MoralAxis, value: number) => { delta[axis] = (delta[axis] ?? 0) + value; };

  if (includesAny(text, ["salv", "resgat", "protege", "curou", "ajud", "poup", "defendeu inocente"])) add("compassion", 2);
  if (includesAny(text, ["tortur", "execut", "massacr", "matou inocente", "cruel", "humilhou"])) add("cruelty", 2);
  if (includesAny(text, ["confess", "cumpriu", "honrou", "verdade", "devolveu"])) add("honesty", 1);
  if (includesAny(text, ["ment", "engan", "traiu", "disfarc", "fingiu", "chantag"])) add("deceit", 1);
  if (includesAny(text, ["guarda", "autoridade", "lei", "tribunal", "entregou-se", "prendeu"])) add("lawfulness", 1);
  if (includesAny(text, ["roub", "furt", "incendi", "invadiu", "fugiu da guarda", "quebrou a lei"])) add("chaos", 1);
  if (includesAny(text, ["arris", "enfrent", "protegeu sob perigo", "ficou para lutar", "sacrificou"])) add("courage", 2);
  if (includesAny(text, ["recompensa", "lucro", "abandonou", "deixou para tras", "egoista", "vendeu aliado"])) add("selfishness", 1);

  return delta;
};

const shouldIgnoreRoutine = (text: string): boolean => {
  if (includesAny(text, ["rolou ", "role ", "ataque pendente", "nenhum dano foi aplicado"])) return true;
  const routineCombat = includesAny(text, ["causando", "dano", "acerta", "erra", "desvia"]) && !includesAny(text, ["inocente", "nobre", "cidade", "lider", "testemunha", "promessa", "favor"]);
  return routineCombat;
};

const buildTurnEvent = (room: RoomState, player: Player, action: PlayerAction, gmResponse: GmResponse): PlayerLoreEvent | null => {
  const actionText = compact(action.content).toLowerCase();
  const narrationText = compact(`${gmResponse.narration} ${gmResponse.ruleOutcome ?? ""}`).toLowerCase();
  const combined = `${actionText} ${narrationText}`;
  if (shouldIgnoreRoutine(combined)) return null;

  const category = classifyCategory(combined);
  if (!category) return null;

  const importance = determineImportance(combined);
  if (importance === "notable" && !includesAny(combined, ["salv", "crime", "promet", "favor", "inimigo", "aliado", "procurado", "poup"])) {
    return null;
  }

  const moralDelta = moralDeltaFor(combined);
  const titleByCategory: Record<PlayerLoreCategory, string> = {
    origin: "Origem",
    motivation: "Motivacao",
    turning_point: "Ponto de virada",
    connection: "Conexao",
    reputation: "Reputacao alterada",
    favor: "Favor ou divida",
    crime: "Crime marcante",
    bond: "Vinculo importante",
    title: "Titulo recebido",
    achievement: "Feito lembrado",
    enemy: "Inimizade criada",
    promise: "Promessa feita",
    consequence: "Consequencia duradoura",
  };

  const narration = compact(gmResponse.narration).slice(0, 260);
  const summary = narration || compact(action.content).slice(0, 220);

  return {
    id: eventId(player.characterName, category, `${room.scene.title}:${summary}`),
    category,
    title: titleByCategory[category],
    summary,
    importance,
    location: room.scene.title,
    peopleInvolved: (room.scene.activeNpcs ?? [])
      .filter((npc) => combined.includes(npc.name.toLowerCase()))
      .map((npc) => npc.name)
      .slice(0, 4),
    moralDelta,
    createdAt: new Date().toISOString(),
  };
};

const applyMoralDelta = (profile: MoralProfile, delta: Partial<Omit<MoralProfile, "label">>): MoralProfile => {
  const next = { ...profile };
  for (const axis of moralAxes) {
    next[axis] = clamp((next[axis] ?? 0) + (delta[axis] ?? 0));
  }
  next.label = deriveMoralLabel(next);
  return next;
};

const isDuplicate = (events: PlayerLoreEvent[], event: PlayerLoreEvent): boolean => {
  const recent = events.slice(-10);
  const normalizedSummary = event.summary.toLowerCase().replace(/[^a-z0-9]+/g, " ").slice(0, 90);
  return recent.some((entry) => (
    entry.id === event.id ||
    (entry.category === event.category && entry.summary.toLowerCase().replace(/[^a-z0-9]+/g, " ").slice(0, 90) === normalizedSummary)
  ));
};

export const recordLoreFromTurn = (room: RoomState, player: Player, action: PlayerAction, gmResponse: GmResponse): Player | null => {
  const normalized = normalizePlayerLore(player);
  const event = buildTurnEvent(room, normalized, action, gmResponse);
  if (!event || isDuplicate(normalized.loreEvents, event)) return null;

  const loreEvents = [...normalized.loreEvents, event]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-40);

  return {
    ...normalized,
    loreEvents,
    moralProfile: applyMoralDelta(normalized.moralProfile, event.moralDelta ?? {}),
  };
};

export const formatPlayerLoreForPrompt = (players: Player[]): Array<Record<string, unknown>> => players.map((player) => {
  const normalized = normalizePlayerLore(player);
  const events = [...normalized.loreEvents]
    .sort((a, b) => {
      const importanceScore = { legendary: 3, major: 2, notable: 1 };
      return importanceScore[b.importance] - importanceScore[a.importance] || b.createdAt.localeCompare(a.createdAt);
    })
    .slice(0, 8)
    .map((entry) => ({
      category: entry.category,
      title: entry.title,
      summary: entry.summary,
      importance: entry.importance,
      location: entry.location,
      peopleInvolved: entry.peopleInvolved,
      consequence: entry.consequence,
    }));

  return {
    characterName: normalized.characterName,
    moralLabel: normalized.moralProfile.label,
    moralProfile: normalized.moralProfile,
    importantLore: events,
  };
});
