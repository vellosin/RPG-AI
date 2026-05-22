import type { ActionPlan } from "./action-orchestrator.js";
import type { GmResponse, Player, PlayerAction, RoomState } from "./types.js";
import { formatResourceSummary, resourceKeyForFeature } from "./player-resources.js";
import { describeEquipment, equipmentAliases, formatInventoryForPrompt, getEquipmentInfo } from "./equipment-catalog.js";

export type MechanicalRuling = {
  status: "allowed" | "denied" | "resolved";
  reason: string;
  requestedCapability?: string;
  resourceUse?: {
    key: string;
    label: string;
    heal?: number;
  };
  resourceRecovery?: "short_rest" | "long_rest";
  response?: GmResponse;
};

const normalize = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

const rollRequiredTerms = [
  "depende de um teste",
  "exige um teste",
  "precisa de um teste",
  "teste de ",
  "rolagem",
  "role 1d20",
  "role um d20",
  "faca um teste",
  "faça um teste",
];

const stealthTerms = ["furtiv", "silencio", "silencioso", "silenciosamente", "sem ser percebido", "me escondo", "escondido"];
const perceptionTerms = ["percepcao", "percepção", "observo", "escuto", "procuro", "noto", "percebo"];
const investigationTerms = ["investigo", "examino", "vasculho", "analiso", "pista", "documento"];
const athleticsTerms = ["escalo", "salto", "empurro", "arrombo", "forco", "forço", "levanto"];
const acrobaticsTerms = ["equilibro", "desvio", "acrobacia", "rolamento", "escorrego"];
const survivalTerms = ["rastro", "trilha", "farejo", "sobrevivencia", "sobrevivência", "caco", "caço"];
const socialDeceptionTerms = ["minto", "engano", "blefo", "disfarco"];
const socialIntimidationTerms = ["ameaco", "ameaço", "intimido", "pressiono", "assusto"];

const mentionsRequiredRoll = (value: string): boolean => {
  const text = normalize(value);
  return rollRequiredTerms.some((term) => text.includes(normalize(term)));
};

const hasAny = (value: string, terms: string[]): boolean =>
  terms.some((term) => value.includes(normalize(term)));

const inferRollSkill = (text: string, actionPlan: ActionPlan): { label: string; key: string } => {
  if (hasAny(text, stealthTerms)) return { label: "Furtividade", key: "stealth" };
  if (hasAny(text, survivalTerms)) return { label: "Sobrevivencia", key: "survival" };
  if (hasAny(text, perceptionTerms)) return { label: "Percepcao", key: "perception" };
  if (hasAny(text, investigationTerms)) return { label: "Investigacao", key: "investigation" };
  if (hasAny(text, athleticsTerms)) return { label: "Atletismo", key: "athletics" };
  if (hasAny(text, acrobaticsTerms)) return { label: "Acrobacia", key: "acrobatics" };
  if (hasAny(text, socialIntimidationTerms)) return { label: "Intimidacao", key: "intimidation" };
  if (hasAny(text, socialDeceptionTerms)) return { label: "Enganacao", key: "deception" };

  switch (actionPlan.skillHint) {
    case "stealth": return { label: "Furtividade", key: "stealth" };
    case "survival": return { label: "Sobrevivencia", key: "survival" };
    case "perception": return { label: "Percepcao", key: "perception" };
    case "investigation": return { label: "Investigacao", key: "investigation" };
    case "athletics": return { label: "Atletismo", key: "athletics" };
    case "acrobatics": return { label: "Acrobacia", key: "acrobatics" };
    case "arcana": return { label: "Arcanismo", key: "arcana" };
    case "persuasion": return { label: "Persuasao", key: "persuasion" };
    case "intimidation": return { label: "Intimidacao", key: "intimidation" };
    case "deception": return { label: "Enganacao", key: "deception" };
    default: return { label: "Teste de atributo", key: "investigation" };
  }
};

const inferDifficulty = (text: string, actionPlan: ActionPlan): number => {
  if (actionPlan.risk === "dangerous") return 15;
  if (hasAny(text, ["monstro", "criatura", "inimigo", "hostil", "alerta", "sem ser percebido"])) return 14;
  if (hasAny(text, ["muito dificil", "quase impossivel", "sob pressao", "sob pressão"])) return 16;
  return 12;
};

export const enforceRollRequestConsistency = (
  room: RoomState,
  player: Player,
  action: PlayerAction,
  actionPlan: ActionPlan,
  response: GmResponse,
): GmResponse => {
  if (response.rollRequest) return response;
  if (actionPlan.kind === "question" || actionPlan.intent === "question" || actionPlan.intent === "ruling") return response;
  if (!actionPlan.needsRoll) {
    if (!mentionsRequiredRoll(`${response.narration}\n${response.ruleOutcome}`)) return response;
    return {
      ...response,
      narration: `${player.characterName} observa com calma e recebe apenas o que a cena mostra de forma clara. Nada exige rolagem neste instante; o ambiente permanece coerente com o que ja foi estabelecido.`,
      sceneSummary: room.scene.summary,
      ruleOutcome: "Sem teste: a acao nao tinha segredo, oposicao, pressao ou consequencia de fracasso suficiente para pedir dado.",
      rollRequest: null,
    };
  }

  const combined = `${action.content}\n${actionPlan.content}\n${response.narration}\n${response.ruleOutcome}\n${room.scene.summary}`;
  const normalized = normalize(combined);
  const shouldForcePendingRoll =
    mentionsRequiredRoll(combined) ||
    (hasAny(normalized, stealthTerms) && hasAny(normalized, ["monstro", "criatura", "inimigo", "perigo", "sem ser percebido"]));

  if (!shouldForcePendingRoll) return response;

  const skill = inferRollSkill(normalized, actionPlan);
  const modifier = Number(player.skills[skill.key] ?? 0);
  const difficulty = inferDifficulty(normalized, actionPlan);
  const modifierText = modifier >= 0 ? `+${modifier}` : `${modifier}`;
  const description = `Teste de ${skill.label} para resolver: ${actionPlan.content}`;

  return {
    ...response,
    narration: `${player.characterName} prepara a acao com cuidado, mas o resultado ainda nao esta decidido. Antes de narrar sucesso ou falha, a mesa precisa da rolagem. Role 1d20 ${modifierText} de ${skill.label} contra CD ${difficulty}.`,
    sceneSummary: room.scene.summary,
    ruleOutcome: `Teste pendente: nenhum resultado foi aplicado ainda. ${description}.`,
    rollRequest: {
      skill: skill.label,
      die: "d20",
      modifier,
      difficulty,
      description,
    },
    npcActions: [],
    npcHealthUpdates: [],
  };
};

const spellAliases: Array<{ canonical: string; terms: string[] }> = [
  { canonical: "Meteor Swarm", terms: ["meteoro", "meteoros", "chuva de meteoros", "enxame de meteoros", "meteor swarm"] },
  { canonical: "Fireball", terms: ["fireball", "bola de fogo"] },
  { canonical: "Magic Missile", terms: ["magic missile", "misseis magicos", "missil magico"] },
  { canonical: "Shield", terms: ["shield", "escudo arcano", "escudo magico"] },
  { canonical: "Mage Armor", terms: ["mage armor", "armadura arcana", "armadura magica"] },
  { canonical: "Fire Bolt", terms: ["fire bolt", "raio de fogo", "rajada de fogo"] },
  { canonical: "Guiding Bolt", terms: ["guiding bolt", "raio guia", "raio guiador"] },
  { canonical: "Healing Word", terms: ["healing word", "palavra curativa"] },
  { canonical: "Sacred Flame", terms: ["sacred flame", "chama sagrada"] },
  { canonical: "Bless", terms: ["bless", "bencao", "benção"] },
  { canonical: "Hunter's Mark", terms: ["hunter's mark", "hunters mark", "marca do cacador", "marca do caçador"] },
  { canonical: "Cure Wounds", terms: ["cure wounds", "curar ferimentos", "cura ferimentos"] },
  { canonical: "Vicious Mockery", terms: ["vicious mockery", "zombaria viciosa"] },
  { canonical: "Charm Person", terms: ["charm person", "enfeiticar pessoa", "encantar pessoa"] },
  { canonical: "Thunderwave", terms: ["thunderwave", "onda trovejante", "onda de trovao", "onda de trovão"] },
  { canonical: "Divine Smite", terms: ["divine smite", "destruir divino", "golpe divino"] },
  { canonical: "Shield of Faith", terms: ["shield of faith", "escudo da fe"] },
  { canonical: "Shillelagh", terms: ["shillelagh"] },
  { canonical: "Entangle", terms: ["entangle", "emaranhar", "enredar"] },
  { canonical: "Thunderstrike", terms: ["thunderstrike", "golpe trovejante"] },
];

const magicIntentTerms = [
  "conjuro",
  "conjurar",
  "lanco magia",
  "lanço magia",
  "uso magia",
  "preparo magia",
  "invoco",
  "invocar",
  "evoco",
  "evocar",
  "feitico",
  "feitiço",
  "magia",
];

const capabilityAliases: Array<{ canonical: string; terms: string[] }> = [
  { canonical: "Invisibility", terms: ["invisibilidade", "invisivel", "invisível", "desaparecer", "sumir"] },
  { canonical: "Stealth", terms: ["furtividade", "esconder", "me esconder", "escondo", "silenciosamente"] },
  { canonical: "Second Wind", terms: ["second wind", "retomar folego", "retomar fôlego", "segundo folego", "segundo fôlego"] },
  { canonical: "Action Surge", terms: ["action surge", "surto de acao", "surto de ação"] },
  { canonical: "Sneak Attack", terms: ["sneak attack", "ataque furtivo"] },
  { canonical: "Cunning Action", terms: ["cunning action", "acao astuta", "ação astuta"] },
  { canonical: "Wild Shape", terms: ["wild shape", "forma selvagem", "transformo em animal"] },
  { canonical: "Channel Divinity", terms: ["channel divinity", "canalizar divindade"] },
  { canonical: "Bardic Inspiration", terms: ["bardic inspiration", "inspiracao bardica", "inspiração bárdica"] },
  { canonical: "Lay on Hands", terms: ["lay on hands", "imposicao de maos", "imposição de mãos"] },
];

const explicitCapabilityTerms = [
  "uso minha habilidade",
  "uso a habilidade",
  "ativo minha habilidade",
  "ativo a habilidade",
  "minha habilidade de",
  "habilidade de",
  "poder de",
  "uso meu poder",
  "fico invisivel",
  "fico invisível",
  "desapareco",
  "desapareço",
];

const sheetQuestionTerms = [
  "quais as habilidades",
  "quais habilidades",
  "minhas habilidades",
  "minha habilidade",
  "essa habilidade",
  "habilidade tem",
  "limite de uso",
  "limite",
  "quantas vezes",
  "como funciona",
  "dura quanto",
  "duracao",
  "duração",
  "o que ele e",
  "o que ele é",
  "o que sou",
  "minha ficha",
  "ficha do meu personagem",
  "que classe",
  "qual minha classe",
  "o que meu personagem pode fazer",
];

const itemUseTerms = [
  "uso",
  "equipo",
  "empunho",
  "disparo",
  "ataco com",
  "pego minha",
  "pego meu",
  "saco minha",
  "saco meu",
];

const anachronisticItems = [
  "pistola",
  "rifle",
  "revolver",
  "revólver",
  "metralhadora",
  "granada",
  "bomba nuclear",
  "laser",
];

const itemAliases: Array<{ canonical: string; terms: string[] }> = equipmentAliases;

const findRequestedSpell = (text: string): string | null => {
  for (const alias of spellAliases) {
    if (alias.terms.some((term) => text.includes(normalize(term)))) {
      return alias.canonical;
    }
  }
  return null;
};

const findRequestedCapability = (text: string): string | null => {
  const spell = findRequestedSpell(text);
  if (spell) return spell;

  for (const alias of capabilityAliases) {
    if (alias.terms.some((term) => text.includes(normalize(term)))) {
      return alias.canonical;
    }
  }

  const abilityMatch = text.match(/habilidade de ([a-z0-9 ]{3,40})/);
  if (abilityMatch?.[1]) {
    return abilityMatch[1].trim();
  }

  return null;
};

const findRequestedItem = (text: string, player?: Player): string | null => {
  for (const item of anachronisticItems) {
    if (text.includes(normalize(item))) return item;
  }

  if (player) {
    const inventoryItems = [...player.inventory.equipped, ...player.inventory.backpack];
    for (const itemName of inventoryItems) {
      const info = getEquipmentInfo(itemName);
      const terms = info ? [info.name, ...info.aliases] : [itemName];
      if (terms.some((term) => text.includes(normalize(term)))) {
        return itemName;
      }
    }
  }

  for (const alias of itemAliases) {
    if (alias.terms.some((term) => text.includes(normalize(term)))) {
      return alias.canonical;
    }
  }

  return null;
};

const hasKnownSpell = (player: Player, requestedSpell: string): boolean => {
  const requested = normalize(requestedSpell);
  return player.spells.some((spell) => normalize(spell) === requested);
};

const hasKnownFeature = (player: Player, requestedFeature: string): boolean => {
  const requested = normalize(requestedFeature);
  return player.features.some((feature) => {
    const normalizedFeature = normalize(feature);
    return normalizedFeature === requested || normalizedFeature.includes(requested) || requested.includes(normalizedFeature);
  });
};

const hasInventoryItem = (player: Player, requestedItem: string): boolean => {
  const requested = normalize(requestedItem);
  return [...player.inventory.equipped, ...player.inventory.backpack].some((item) => {
    const normalizedItem = normalize(item);
    return normalizedItem === requested || normalizedItem.includes(requested) || requested.includes(normalizedItem);
  });
};

const isMagicAttempt = (text: string, actionPlan: ActionPlan): boolean =>
  actionPlan.intent === "cast_spell" ||
  magicIntentTerms.some((term) => text.includes(normalize(term))) ||
  Boolean(findRequestedSpell(text));

const isExplicitCapabilityAttempt = (text: string): boolean =>
  explicitCapabilityTerms.some((term) => text.includes(normalize(term)));

const isSheetQuestion = (text: string, actionPlan: ActionPlan): boolean =>
  (actionPlan.kind === "question" || actionPlan.intent === "question" || actionPlan.intent === "ruling") &&
  sheetQuestionTerms.some((term) => text.includes(normalize(term)));

const restType = (text: string, actionPlan: ActionPlan): "short_rest" | "long_rest" | null => {
  if (actionPlan.intent !== "rest") return null;
  if (text.includes("descanso longo") || text.includes("durmo") || text.includes("dormir")) return "long_rest";
  return "short_rest";
};

const unsupportedVictorySkip = (text: string): boolean =>
  [
    "apos o confronto",
    "apos a luta",
    "apos o combate",
    "depois da vitoria",
    "depois da vitória",
    "depois do confronto",
    "depois da luta",
    "depois do combate",
    "apos a vitoria",
    "após a vitória",
  ].some((term) => text.includes(normalize(term)));

const hasRecentResolvedConflict = (room: RoomState): boolean => {
  const lastOutcome = normalize(room.combat.lastOutcome ?? "");
  if (["encerrou", "sobrevive", "derrot", "combate encerrado"].some((term) => lastOutcome.includes(term))) return true;
  return room.messages.slice(-10).some((message) => {
    const content = normalize(`${message.content} ${message.rawContent ?? ""}`);
    return content.includes("combate encerrado") || content.includes("foi derrotado") || content.includes("sobrevive ao confronto");
  });
};

const knownCapabilities = (player: Player): string =>
  [
    player.spells.length > 0 ? `magias: ${player.spells.join(", ")}` : "magias: nenhuma",
    player.features.length > 0 ? `habilidades: ${player.features.join(", ")}` : "habilidades: nenhuma",
    formatResourceSummary(player.resources),
  ].join("; ");

const inventoryDetails = (player: Player): string => {
  const lines = formatInventoryForPrompt(player.inventory.equipped, player.inventory.backpack);
  return lines.length > 0 ? lines.join(" | ") : "Inventario vazio.";
};

const sheetResponse = (room: RoomState, player: Player): GmResponse => ({
  narration: [
    `${player.characterName} é ${player.species} ${player.className} nível ${player.level}, antecedente ${player.background}.`,
    `Habilidades de classe: ${player.features.length > 0 ? player.features.join(", ") : "nenhuma"}.`,
    `Magias conhecidas/preparadas: ${player.spells.length > 0 ? player.spells.join(", ") : "nenhuma"}.`,
    `Itens equipados: ${player.inventory.equipped.length > 0 ? player.inventory.equipped.join(", ") : "nenhum"}.`,
    `Detalhes dos itens: ${inventoryDetails(player)}.`,
    `Recursos e condições: ${formatResourceSummary(player.resources)}.`,
  ].join(" "),
  sceneSummary: room.scene.summary,
  ruleOutcome: `Consulta de ficha respondida a partir do estado salvo do jogador. ${knownCapabilities(player)}.`,
  imageJobs: [],
  npcActions: [],
  joiningNpcs: [],
  rollRequest: null,
  npcHealthUpdates: [],
});

const spellRules: Record<string, string> = {
  "hunter's mark": "Marca do Caçador é uma magia de 1º círculo. Pela regra de D&D 5e, ela consome 1 espaço de magia ao ser conjurada, exige concentração, dura até 1 hora e adiciona 1d6 de dano sempre que você acerta o alvo marcado com um ataque de arma. Se o alvo cair antes da magia acabar, você pode mover a marca para outra criatura em um turno posterior.",
  "speak with animals": "Falar com Animais é uma magia de 1º círculo. Pela regra de D&D 5e, ela consome 1 espaço de magia ao ser conjurada e dura 10 minutos, permitindo comunicação verbal simples com bestas.",
};

const featureOrSpellQuestionResponse = (
  room: RoomState,
  player: Player,
  requestedName: string,
  kind: "spell" | "feature",
): GmResponse => {
  const normalized = normalize(requestedName);
  const resourceKey = kind === "feature" ? resourceKeyForFeature(requestedName) : null;
  const resource = resourceKey ? player.resources.limited[resourceKey] : undefined;
  const savedName = kind === "spell"
    ? player.spells.find((spell) => normalize(spell) === normalized) ?? requestedName
    : player.features.find((feature) => hasKnownFeature({ ...player, features: [feature] }, requestedName)) ?? requestedName;
  const knownRule = kind === "spell" ? spellRules[normalized] : undefined;
  const resourceText = resource
    ? `Uso limitado registrado: ${resource.label} ${Math.max(0, resource.max - resource.used)}/${resource.max}; recupera em ${resource.recovery === "long_rest" ? "descanso longo" : "descanso curto"}.`
    : kind === "spell"
      ? "Limite de uso: depende dos espaços de magia disponíveis da ficha; esta aplicação ainda não possui contador detalhado de espaços de magia por círculo, então o Mestre deve tratar como recurso mágico limitado e registrar o gasto quando conjurada."
      : "Limite de uso: não há contador limitado registrado para esta habilidade na ficha atual; use a descrição da classe e o julgamento do Mestre.";

  return {
    narration: `${savedName}: ${knownRule ?? "Esta capacidade está registrada na ficha, mas ainda não possui descrição detalhada no compêndio local."} ${resourceText}`,
    sceneSummary: room.scene.summary,
    ruleOutcome: `Consulta OOC de ficha respondida. Não é ação ficcional, não pede rolagem e não avança turno. ${knownCapabilities(player)}.`,
    imageJobs: [],
    npcActions: [],
    joiningNpcs: [],
    rollRequest: null,
    npcHealthUpdates: [],
  };
};

const deniedSpellResponse = (
  room: RoomState,
  player: Player,
  requestedSpell: string,
  reason: string,
  isQuestion: boolean,
): GmResponse => {
  const capabilities = knownCapabilities(player);
  const narration = isQuestion
    ? `${player.characterName}, pela sua ficha atual, não: você não pode conjurar ${requestedSpell}. ${reason} Use apenas as magias e habilidades registradas no personagem.`
    : `${player.characterName} tenta puxar poder arcano para conjurar ${requestedSpell}, mas a magia simplesmente não existe em seu repertório. O gesto não produz efeito algum, e a cena continua sob a mesma ameaça.`;

  return {
    narration,
    sceneSummary: room.scene.summary,
    ruleOutcome: `Ação negada pela ficha: ${player.characterName} não conhece ${requestedSpell}. ${capabilities}. A regra correta é que uma magia só pode ser conjurada se estiver na lista de magias conhecidas/preparadas ou como habilidade explícita da classe.`,
    imageJobs: [],
    npcActions: [],
    joiningNpcs: [],
    rollRequest: null,
    npcHealthUpdates: [],
  };
};

const deniedCapabilityResponse = (
  room: RoomState,
  player: Player,
  requestedCapability: string,
  reason: string,
  isQuestion: boolean,
): GmResponse => {
  const capabilities = knownCapabilities(player);
  const narration = isQuestion
    ? `${player.characterName}, pela sua ficha atual, não possui ${requestedCapability}. ${reason} As capacidades disponíveis são: ${capabilities}.`
    : `${player.characterName} tenta usar ${requestedCapability}, mas essa habilidade não existe em sua ficha. Nada na técnica ou no treinamento dele produz esse efeito, e a cena continua sem essa vantagem.`;

  return {
    narration,
    sceneSummary: room.scene.summary,
    ruleOutcome: `Ação negada pela ficha: ${player.characterName} não possui ${requestedCapability}. ${capabilities}. O Mestre não deve inventar habilidades, magias, vantagens ou poderes ausentes da ficha.`,
    imageJobs: [],
    npcActions: [],
    joiningNpcs: [],
    rollRequest: null,
    npcHealthUpdates: [],
  };
};

const deniedItemResponse = (
  room: RoomState,
  player: Player,
  requestedItem: string,
): GmResponse => ({
  narration: `${player.characterName} tenta usar ${requestedItem}, mas esse item não está na ficha dele. Ele confere rapidamente o próprio equipamento e precisa agir com o que realmente carrega.`,
  sceneSummary: room.scene.summary,
  ruleOutcome: `Ação negada pelo inventário: ${player.characterName} não possui ${requestedItem}. Equipado: ${player.inventory.equipped.join(", ") || "nada"}. Mochila: ${player.inventory.backpack.join(", ") || "vazia"}.`,
  imageJobs: [],
  npcActions: [],
  joiningNpcs: [],
  rollRequest: null,
  npcHealthUpdates: [],
});

const resolveKnownFeatureUse = (
  room: RoomState,
  player: Player,
  requestedCapability: string,
): MechanicalRuling | null => {
  const feature = player.features.find((entry) => hasKnownFeature({ ...player, features: [entry] }, requestedCapability));
  if (!feature) return null;
  const key = resourceKeyForFeature(feature);
  if (!key) return null;

  const resource = player.resources.limited[key];
  if (!resource) return null;

  if (resource.used >= resource.max) {
    const capabilities = knownCapabilities(player);
    return {
      status: "denied",
      requestedCapability,
      reason: `${resource.label} já foi usado e só recupera após ${resource.recovery === "short_rest" ? "descanso curto" : "descanso longo"}.`,
      response: {
        narration: `${player.characterName} tenta recorrer a ${resource.label} de novo, mas esse recurso já foi gasto. Ele precisa de ${resource.recovery === "short_rest" ? "um descanso curto" : "um descanso longo"} antes de usá-lo novamente.`,
        sceneSummary: room.scene.summary,
        ruleOutcome: `Recurso indisponível: ${resource.label} está em ${resource.used}/${resource.max} uso(s). ${capabilities}.`,
        imageJobs: [],
        npcActions: [],
        joiningNpcs: [],
        rollRequest: null,
        npcHealthUpdates: [],
      },
    };
  }

  const heal = key === "second_wind"
    ? Math.max(1, Math.min(player.maxHitPoints - player.hitPoints, Math.floor(Math.random() * 10) + 1 + player.level))
    : undefined;
  const resourceText = `${resource.label} ${resource.max - resource.used - 1}/${resource.max}`;
  const narration = key === "second_wind"
    ? `${player.characterName} respira fundo, firma os pés e recupera o fôlego em meio ao perigo. A disciplina de combate devolve ${heal} ponto${heal === 1 ? "" : "s"} de vida, e ele volta a encarar a cena com presença renovada.`
    : `${player.characterName} aciona ${resource.label}, usando uma reserva curta de treinamento marcial para ganhar uma abertura tática imediata. O recurso fica gasto até o próximo descanso apropriado.`;

  return {
    status: "resolved",
    requestedCapability,
    reason: `${resource.label} é uma habilidade válida da ficha e foi consumida.`,
    resourceUse: { key, label: resource.label, heal },
    response: {
      narration,
      sceneSummary: room.scene.summary,
      ruleOutcome: `${resource.label} usado. Recursos restantes: ${resourceText}.`,
      imageJobs: [],
      npcActions: [],
      joiningNpcs: [],
      rollRequest: null,
      npcHealthUpdates: [],
    },
  };
};

export const evaluateMechanicalRuling = (
  room: RoomState,
  player: Player,
  action: PlayerAction,
  actionPlan: ActionPlan,
): MechanicalRuling => {
  const text = normalize(`${action.content} ${actionPlan.content}`);
  const requestedSpell = findRequestedSpell(text);
  const requestedCapability = findRequestedCapability(text);
  const requestedItem = findRequestedItem(text, player);
  const magicAttempt = isMagicAttempt(text, actionPlan);
  const capabilityAttempt = isExplicitCapabilityAttempt(text);
  const itemAttempt = itemUseTerms.some((term) => text.includes(normalize(term))) && Boolean(requestedItem);
  const isQuestion = actionPlan.kind === "question" || actionPlan.intent === "question" || actionPlan.intent === "ruling";
  const requestedRest = restType(text, actionPlan);

  if (isQuestion && requestedSpell && hasKnownSpell(player, requestedSpell)) {
    return {
      status: "resolved",
      requestedCapability: requestedSpell,
      reason: "Question asks about a known spell on the character sheet.",
      response: featureOrSpellQuestionResponse(room, player, requestedSpell, "spell"),
    };
  }

  if (isQuestion && requestedCapability && hasKnownFeature(player, requestedCapability)) {
    return {
      status: "resolved",
      requestedCapability,
      reason: "Question asks about a known feature on the character sheet.",
      response: featureOrSpellQuestionResponse(room, player, requestedCapability, "feature"),
    };
  }

  if (unsupportedVictorySkip(text) && !hasRecentResolvedConflict(room)) {
    return {
      status: "denied",
      reason: "O jogador tentou avançar para depois de uma vitória/confronto que ainda não aconteceu no estado canônico.",
      response: {
        narration: `${player.characterName} ainda não viveu essa vitória na mesa. A cena permanece no momento atual: primeiro é preciso descobrir, confrontar ou resolver a ameaça antes de narrar consequências posteriores.`,
        sceneSummary: room.scene.summary,
        ruleOutcome: "Continuidade protegida: não é permitido pular para 'depois da vitória' sem confronto, prova ou resolução canônica anterior.",
        imageJobs: [],
        npcActions: [],
        joiningNpcs: [],
        rollRequest: null,
        npcHealthUpdates: [],
      },
    };
  }

  if (requestedRest) {
    const recovered = Object.values(player.resources.limited)
      .filter((resource) => requestedRest === "long_rest" || resource.recovery === "short_rest")
      .map((resource) => resource.label);
    return {
      status: "resolved",
      reason: `Player takes a ${requestedRest}.`,
      resourceRecovery: requestedRest,
      response: {
        narration: `${player.characterName} faz uma pausa cuidadosa, baixa a guarda apenas o suficiente para recuperar o fôlego e reorganizar o equipamento. ${recovered.length > 0 ? `Recursos recuperados: ${recovered.join(", ")}.` : "Não havia recursos limitados para recuperar."}`,
        sceneSummary: room.scene.summary,
        ruleOutcome: `${requestedRest === "long_rest" ? "Descanso longo" : "Descanso curto"} concluído. Recursos apropriados foram restaurados.`,
        imageJobs: [],
        npcActions: [],
        joiningNpcs: [],
        rollRequest: null,
        npcHealthUpdates: [],
      },
    };
  }

  if (isSheetQuestion(text, actionPlan)) {
    return {
      status: "resolved",
      reason: "Question asks for the saved character sheet.",
      response: sheetResponse(room, player),
    };
  }

  if (itemAttempt && requestedItem && !hasInventoryItem(player, requestedItem)) {
    return {
      status: "denied",
      requestedCapability: requestedItem,
      reason: `${requestedItem} não está no inventário de ${player.characterName}.`,
      response: deniedItemResponse(room, player, requestedItem),
    };
  }
  if (itemAttempt && requestedItem && hasInventoryItem(player, requestedItem) && !magicIntentTerms.some((term) => text.includes(normalize(term)))) {
    return { status: "allowed", reason: `${requestedItem} exists in the character inventory. ${describeEquipment(requestedItem)}`, requestedCapability: requestedItem };
  }

  if (!magicAttempt && !capabilityAttempt) {
    return { status: "allowed", reason: "No explicit spellcasting or unsupported named capability was requested." };
  }

  if (capabilityAttempt && requestedCapability && !requestedSpell && !hasKnownFeature(player, requestedCapability)) {
    return {
      status: "denied",
      requestedCapability,
      reason: `${requestedCapability} não está nas habilidades da ficha de ${player.characterName}.`,
      response: deniedCapabilityResponse(room, player, requestedCapability, `${requestedCapability} não está nas habilidades da ficha de ${player.characterName}.`, isQuestion),
    };
  }

  if (capabilityAttempt && requestedCapability && !requestedSpell) {
    const featureUse = resolveKnownFeatureUse(room, player, requestedCapability);
    if (featureUse) return featureUse;
  }

  if (!player.features.some((feature) => normalize(feature) === "spellcasting") && player.spells.length === 0) {
    const capability = requestedSpell ?? "magia";
    return {
      status: "denied",
      requestedCapability: capability,
      reason: `${player.characterName} não possui Spellcasting nem magias conhecidas.`,
      response: deniedSpellResponse(room, player, capability, `${player.characterName} não possui Spellcasting nem magias conhecidas.`, isQuestion),
    };
  }

  if (requestedSpell && !hasKnownSpell(player, requestedSpell)) {
    return {
      status: "denied",
      requestedCapability: requestedSpell,
      reason: `${requestedSpell} não está na lista de magias conhecidas/preparadas de ${player.characterName}.`,
      response: deniedSpellResponse(room, player, requestedSpell, `${requestedSpell} não está na lista de magias conhecidas/preparadas de ${player.characterName}.`, isQuestion),
    };
  }

  if (!requestedSpell && actionPlan.intent === "cast_spell") {
    return {
      status: "denied",
      requestedCapability: "magia não identificada",
      reason: `A ação declara conjuração, mas não cita nenhuma magia conhecida da ficha de ${player.characterName}.`,
      response: deniedSpellResponse(room, player, "uma magia não especificada", `A ação precisa citar uma magia disponível na ficha. ${knownCapabilities(player)}.`, isQuestion),
    };
  }

  return { status: "allowed", reason: "Requested spell appears on the character sheet.", requestedCapability: requestedSpell ?? undefined };
};
