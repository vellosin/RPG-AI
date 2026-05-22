import { nanoid } from "nanoid";
import type { CampaignMemoryEntry, CampaignMemoryKind, CampaignMemoryState, GmResponse, Player, PlayerAction, RoomState } from "./types.js";

const stopWords = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "into", "about", "after", "before", "through",
  "para", "com", "uma", "umas", "uns", "dos", "das", "que", "como", "pela", "pelo", "entre", "sobre", "depois",
  "antes", "ainda", "mais", "menos", "seus", "suas", "their", "them", "room", "scene", "party", "mestre",
]);

const normalizeText = (value: string): string => value
  .normalize("NFD")
  .replace(/\p{Diacritic}/gu, "")
  .toLowerCase();

const tokenize = (value: string): string[] => {
  const normalized = normalizeText(value);
  const parts = normalized.split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !stopWords.has(token));
  return [...new Set(parts)];
};

const titleFromKind = (kind: CampaignMemoryKind, fallback: string): string => `${kind.toUpperCase()}: ${fallback}`;

export const defaultCampaignMemory = (): CampaignMemoryState => ({
  entries: [],
  summary: "No campaign memories recorded yet.",
  updatedAt: undefined,
});

const buildTags = (...values: Array<string | undefined>): string[] => {
  const tags = values.flatMap((value) => value ? tokenize(value) : []);
  return [...new Set(tags)].slice(0, 18);
};

export const buildMemorySearchTerms = (room: RoomState, action: PlayerAction): string[] => {
  const enemyNames = room.combat.enemies?.map((enemy) => enemy.name).join(" ") ?? "";
  return buildTags(action.content, room.scene.title, room.scene.summary, room.scene.activeQuest, enemyNames);
};

const pruneMemories = (entries: CampaignMemoryEntry[]): CampaignMemoryEntry[] => {
  return entries
    .sort((left, right) => {
      const importanceScore = right.importance - left.importance;
      if (importanceScore !== 0) {
        return importanceScore;
      }
      return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    })
    .slice(0, 80)
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
};

const mergeEntry = (entries: CampaignMemoryEntry[], nextEntry: Omit<CampaignMemoryEntry, "id" | "createdAt" | "updatedAt">, key: (entry: CampaignMemoryEntry) => boolean): CampaignMemoryEntry[] => {
  const timestamp = new Date().toISOString();
  const existing = entries.find(key);
  if (existing) {
    existing.content = nextEntry.content;
    existing.title = nextEntry.title;
    existing.tags = [...new Set([...existing.tags, ...nextEntry.tags])].slice(0, 20);
    existing.importance = Math.max(existing.importance, nextEntry.importance);
    existing.updatedAt = timestamp;
    return entries;
  }

  entries.push({
    id: nanoid(),
    createdAt: timestamp,
    updatedAt: timestamp,
    ...nextEntry,
  });
  return entries;
};

export const retrieveRelevantMemories = (room: RoomState, action: PlayerAction, limit = 5): CampaignMemoryEntry[] => {
  const queryTokens = buildMemorySearchTerms(room, action);
  const now = Date.now();
  return [...room.memory.entries]
    .map((entry) => {
      const entryTokens = new Set(buildTags(entry.title, entry.content, entry.tags.join(" ")));
      const overlap = queryTokens.filter((token) => entryTokens.has(token)).length;
      const recencyDays = Math.max(1, (now - new Date(entry.updatedAt).getTime()) / (1000 * 60 * 60 * 24));
      const score = overlap * 4 + entry.importance * 2 + 2 / recencyDays;
      return { entry, score };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ entry }) => ({
      ...entry,
      lastReferencedAt: new Date().toISOString(),
    }));
};

export const buildMemorySummary = (entries: CampaignMemoryEntry[]): string => {
  if (entries.length === 0) {
    return "No campaign memories recorded yet.";
  }

  return entries
    .slice(-6)
    .map((entry) => `${entry.kind}: ${entry.title.replace(/^[A-Z]+:\s*/, "")} -> ${entry.content}`)
    .join(" | ");
};

export const applyRetrievedMemoryTouches = (memory: CampaignMemoryState, retrieved: CampaignMemoryEntry[]): CampaignMemoryState => {
  if (retrieved.length === 0) {
    return memory;
  }

  const touchedIds = new Map(retrieved.map((entry) => [entry.id, entry.lastReferencedAt]));
  return {
    ...memory,
    entries: memory.entries.map((entry) => touchedIds.has(entry.id)
      ? { ...entry, lastReferencedAt: touchedIds.get(entry.id) }
      : entry),
    updatedAt: new Date().toISOString(),
  };
};

export const recordCampaignTurn = (
  room: RoomState,
  player: Player,
  action: PlayerAction,
  gmResponse: Pick<GmResponse, "narration" | "sceneSummary" | "ruleOutcome">,
): CampaignMemoryState => {
  const entries = [...room.memory.entries];
  const locationTitle = room.scene.title || "Current location";
  const questTitle = room.scene.activeQuest || "Current objective";
  const actionText = action.content.trim();
  const eventTitle = `${player.characterName} at ${locationTitle}`;
  const eventContent = `Action: ${actionText}. Outcome: ${gmResponse.ruleOutcome}. Consequence: ${gmResponse.sceneSummary}`;

  mergeEntry(entries, {
    kind: "location",
    title: titleFromKind("location", locationTitle),
    content: room.scene.summary,
    tags: buildTags(locationTitle, room.scene.summary),
    importance: 3,
  }, (entry) => entry.kind === "location" && normalizeText(entry.title) === normalizeText(titleFromKind("location", locationTitle)));

  if (room.scene.activeQuest) {
    mergeEntry(entries, {
      kind: "quest",
      title: titleFromKind("quest", questTitle),
      content: `Current quest pressure: ${room.scene.activeQuest}. Latest change: ${gmResponse.sceneSummary}`,
      tags: buildTags(questTitle, gmResponse.sceneSummary),
      importance: 4,
    }, (entry) => entry.kind === "quest" && normalizeText(entry.title) === normalizeText(titleFromKind("quest", questTitle)));
  }

  mergeEntry(entries, {
    kind: "event",
    title: titleFromKind("event", eventTitle),
    content: eventContent,
    tags: buildTags(player.characterName, actionText, room.scene.title, room.scene.activeQuest, gmResponse.ruleOutcome, gmResponse.sceneSummary),
    importance: actionText.includes("attack") || actionText.includes("ataco") ? 5 : 3,
  }, (entry) => entry.kind === "event" && normalizeText(entry.content) === normalizeText(eventContent));

  return {
    entries: pruneMemories(entries),
    summary: buildMemorySummary(entries),
    updatedAt: new Date().toISOString(),
  };
};

/**
 * Decides whether the campaign memory has grown beyond its comfort window and
 * needs compression. We keep ~60 entries hot; once we cross 80, we compress the
 * oldest event entries down into a single rolling summary.
 *
 * Returns null when no compression is needed yet, otherwise returns the slice of
 * old entries to compress (callers feed these into the LLM and replace them with
 * a single summary entry).
 */
export const findCompressionWindow = (memory: CampaignMemoryState, threshold = 80, keepRecent = 40): CampaignMemoryEntry[] | null => {
  const events = memory.entries.filter((entry) => entry.kind === "event");
  if (events.length < threshold) return null;

  // Sort oldest first so the compression window targets the stale tail of the campaign.
  const sortedOld = [...events].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const compressCount = events.length - keepRecent;
  return sortedOld.slice(0, Math.max(20, compressCount));
};

/**
 * Replaces a window of compressed entries with a single rolling summary entry.
 * Idempotent: if the same window is passed twice, the older summary is updated
 * rather than duplicated.
 */
export const applySummarizedMemory = (
  memory: CampaignMemoryState,
  compressedIds: Set<string>,
  summary: string,
): CampaignMemoryState => {
  const remaining = memory.entries.filter((entry) => !compressedIds.has(entry.id));
  const timestamp = new Date().toISOString();

  const existingRolling = remaining.find((entry) => entry.kind === "summary" && entry.tags.includes("rolling"));
  if (existingRolling) {
    existingRolling.content = `${existingRolling.content}\n---\n${summary}`;
    existingRolling.updatedAt = timestamp;
    existingRolling.importance = Math.min(10, existingRolling.importance + 1);
    return {
      entries: remaining,
      summary: buildMemorySummary(remaining),
      updatedAt: timestamp,
    };
  }

  remaining.push({
    id: nanoid(),
    kind: "summary",
    title: "SUMMARY: Campanha (compactado)",
    content: summary,
    tags: ["rolling", "summary", "campanha"],
    importance: 6,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  return {
    entries: remaining,
    summary: buildMemorySummary(remaining),
    updatedAt: timestamp,
  };
};

export const recordPlayerCharacters = (room: RoomState): CampaignMemoryState => {
  const entries = [...room.memory.entries];
  for (const player of room.players) {
    mergeEntry(entries, {
      kind: "npc",
      title: titleFromKind("npc", player.characterName),
      content: [
        `Personagem jogador: ${player.characterName} (${player.species} ${player.className} nível ${player.level}).`,
        `Aparência: ${player.physicalDescription}. Equipamento: ${player.weaponDescription}, ${player.outfitDescription}.`,
        player.origin ? `Origem: ${player.origin}.` : "",
        player.motivation ? `Motivação: ${player.motivation}.` : "",
        player.turningPoint ? `Ponto de virada: ${player.turningPoint}.` : "",
        player.connections ? `Conexões: ${player.connections}.` : "",
        player.backstory ? `História de fundo: ${player.backstory}.` : "",
        player.portraitAssetUrl ? `Retrato: ${player.portraitAssetUrl}` : "",
      ].filter(Boolean).join(" "),
      tags: buildTags(player.characterName, player.className, player.species, player.name),
      importance: 5,
    }, (entry) => entry.kind === "npc" && normalizeText(entry.title) === normalizeText(titleFromKind("npc", player.characterName)));
  }
  return { ...room.memory, entries: pruneMemories(entries), summary: buildMemorySummary(entries), updatedAt: new Date().toISOString() };
};
