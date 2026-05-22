import type { GmResponse, Player, PlayerAction, RoomState, StoryArcState } from "./types.js";

const normalize = (value: string): string =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const uniqPush = (items: string[], value: string, limit: number): string[] => {
  const clean = value.trim().replace(/\s+/g, " ");
  if (clean.length < 8) return items;
  const exists = items.some((item) => normalize(item) === normalize(clean));
  return exists ? items : [...items, clean].slice(-limit);
};

const firstSentence = (value: string, fallback: string): string => {
  const sentence = value.split(/[.!?]\s+/)[0]?.trim();
  return sentence && sentence.length > 8 ? sentence : fallback;
};

export const createInitialStoryArc = (room: RoomState, adventureHook?: string): StoryArcState => {
  const playerHooks = room.players
    .map((player) => [player.motivation, player.turningPoint, player.backstory].filter(Boolean).join(" "))
    .filter(Boolean);
  const premiseSource = adventureHook || playerHooks.join(" ") || room.scene.summary;
  return {
    title: room.scene.title,
    premise: firstSentence(premiseSource, room.scene.summary),
    phase: "opening",
    openQuestions: [
      "Que problema imediato trouxe os personagens a esta cena?",
      "Quem se beneficia se a ameaça continuar escondida?",
    ],
    knownClues: [],
    activeThreats: [],
    npcAgendas: [],
    completedBeats: [],
    tensionLevel: 1,
    recentCombatsSinceLongRest: 0,
  };
};

export const updateStoryArcFromTurn = (
  room: RoomState,
  player: Player,
  action: PlayerAction,
  response: GmResponse,
): StoryArcState => {
  const current = room.scene.storyArc ?? createInitialStoryArc(room);
  const text = `${action.content}\n${response.narration}\n${response.sceneSummary}\n${response.ruleOutcome}`;
  const normalized = normalize(text);
  const hasPendingRoll =
    Boolean(response.rollRequest) ||
    /\b(teste pendente|rolagem pendente|depende de um teste|exige um teste|precisa de um teste)\b/.test(normalized);
  let phase = current.phase;
  let tensionLevel = current.tensionLevel;
  let knownClues = [...current.knownClues];
  let openQuestions = [...current.openQuestions];
  let activeThreats = [...current.activeThreats];
  let completedBeats = [...current.completedBeats];
  let npcAgendas = [...current.npcAgendas];
  let recentCombatsSinceLongRest = current.recentCombatsSinceLongRest;
  let restRecommendation = current.restRecommendation;
  let nextSessionHook = current.nextSessionHook;

  if (/\b(rumor|boato|ouviu|ouvir|taberna|pista)\b/.test(normalized)) {
    phase = "investigation";
    knownClues = uniqPush(knownClues, firstSentence(response.sceneSummary, "Um rumor importante foi confirmado."), 12);
  }
  if (/\b(estrada|viagem|viaja|caminho|cidade|portao|chega|chegada)\b/.test(normalized)) {
    phase = phase === "opening" ? "travel" : phase;
  }
  if (/\b(prova|evidencia|documento|selo|testemunha|confissao|confissao)\b/.test(normalized)) {
    phase = "complication";
    knownClues = uniqPush(knownClues, firstSentence(response.ruleOutcome || response.sceneSummary, "Uma prova nova apareceu."), 14);
    openQuestions = uniqPush(openQuestions, "Como essa prova pode ser exposta sem colocar inocentes em risco?", 8);
  }
  if (/\b(culto|assassino|chefe|seguranca|capitao|amea[cç]a|inimigo|conspiracao|conspira[cç][aã]o)\b/.test(normalized)) {
    activeThreats = uniqPush(activeThreats, firstSentence(response.sceneSummary, "Uma ameaça organizada está ativa."), 8);
    tensionLevel = Math.min(5, tensionLevel + 1);
  }
  if (!hasPendingRoll && /\b(vitoria|vit[oó]ria|derrotad|combate encerrado|sobrevive ao confronto|miss[aã]o conclu[ií]da|marco)\b/.test(normalized)) {
    phase = "aftermath";
    completedBeats = uniqPush(completedBeats, firstSentence(response.ruleOutcome || response.narration, "Um marco da aventura foi concluído."), 12);
  }
  if (/\b(chefe|mestre|mandante|superior|proxima sessao|pr[oó]xima sess[aã]o)\b/.test(normalized)) {
    nextSessionHook = firstSentence(response.sceneSummary || response.narration, "Existe um mandante por trás da ameaça atual.");
  }
  if (/\b(descanso longo|dormir|pernoitar|estalagem|quarto)\b/.test(normalized)) {
    recentCombatsSinceLongRest = 0;
    restRecommendation = undefined;
    tensionLevel = Math.max(1, tensionLevel - 1);
    completedBeats = uniqPush(completedBeats, `${player.characterName} conseguiu uma pausa segura para se recuperar.`, 12);
  }
  for (const npc of room.scene.activeNpcs ?? []) {
    if (normalized.includes(normalize(npc.name))) {
      npcAgendas = uniqPush(npcAgendas, `${npc.name}: ${npc.relation === "companion" ? "companheiro de grupo" : "NPC de cena"}; ${npc.description}`, 8);
    }
  }

  return {
    ...current,
    phase,
    openQuestions,
    knownClues,
    activeThreats,
    npcAgendas,
    completedBeats,
    tensionLevel,
    recentCombatsSinceLongRest,
    restRecommendation,
    nextSessionHook,
  };
};

export const recordCombatInStoryArc = (room: RoomState, summary: string): StoryArcState => {
  const current = room.scene.storyArc ?? createInitialStoryArc(room);
  const recentCombatsSinceLongRest = current.recentCombatsSinceLongRest + 1;
  return {
    ...current,
    phase: "aftermath",
    completedBeats: uniqPush(current.completedBeats, summary, 12),
    tensionLevel: Math.min(5, current.tensionLevel + 1),
    recentCombatsSinceLongRest,
    restRecommendation: recentCombatsSinceLongRest >= 2
      ? "Depois de 2 combates sem descanso longo, o Mestre deve oferecer uma chance plausível de repouso antes de escalar novas lutas."
      : current.restRecommendation,
  };
};
