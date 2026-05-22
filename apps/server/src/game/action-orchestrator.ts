import type { ChatKind, Player, PlayerAction, RoomState } from "./types.js";

export type ActionIntent =
  | "attack"
  | "cast_spell"
  | "social"
  | "exploration"
  | "movement"
  | "inventory"
  | "rest"
  | "ruling"
  | "question"
  | "unknown";

export type ActionRisk = "safe" | "uncertain" | "dangerous";

export type NarrativePolicy = {
  mode: "dialogue" | "exploration" | "travel" | "rules_check" | "combat" | "downtime" | "inventory" | "ooc";
  responseFocus: string;
  requiredBeats: string[];
  forbiddenMoves: string[];
  rollGuidance: string;
  npcGuidance: string;
  continuityGuidance: string;
};

export type ActionPlan = {
  kind: ChatKind;
  content: string;
  intent: ActionIntent;
  risk: ActionRisk;
  shouldStartCombat: boolean;
  needsRoll: boolean;
  skillHint?: string;
  turnSteps: string[];
  narrativePolicy?: NarrativePolicy;
  orchestrationNotes: string[];
};

const normalize = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

const includesAny = (value: string, terms: string[]): boolean =>
  terms.some((term) => value.includes(term));

const passiveObservationTerms = [
  "observo o ambiente",
  "olho ao redor",
  "olho em volta",
  "olho os arredores",
  "observo os arredores",
  "dou uma olhada",
  "vejo o que tem",
  "presto atencao",
  "presto atencao aos arredores",
].map(normalize);

const hiddenSearchTerms = [
  "escondido",
  "oculto",
  "secreto",
  "armadilha",
  "emboscada",
  "passagem secreta",
  "porta secreta",
  "rastro escondido",
  "pista oculta",
  "sem ser percebido",
  "furtiva",
  "furtivo",
].map(normalize);

const hasImmediatePressure = (room: RoomState): boolean =>
  room.combat.active ||
  (room.combat.enemies?.some((enemy) => enemy.hitPoints > 0) ?? false) ||
  ["confrontation", "complication"].includes(room.scene.storyArc?.phase ?? "");

const hasEstablishedAttackTarget = (room: RoomState): boolean => {
  if (room.combat.active || (room.combat.enemies?.some((enemy) => enemy.hitPoints > 0) ?? false)) return true;
  const sceneText = normalize([
    room.scene.title,
    room.scene.summary,
    ...(room.scene.storyArc?.activeThreats ?? []),
    ...room.messages.slice(-8).map((message) => message.content),
  ].join(" "));
  return ["monstro", "criatura", "inimigo", "alvo", "ser corrompido", "fera"].some((term) => sceneText.includes(normalize(term)));
};

const parsePlayerInput = (raw: string): { kind: ChatKind; content: string } => {
  const trimmed = raw.trim();
  if (trimmed.startsWith("*")) {
    return { kind: "action", content: trimmed.slice(1).trim() };
  }
  if (trimmed.startsWith("-")) {
    return { kind: "speech", content: trimmed.slice(1).trim() };
  }
  if (trimmed.startsWith('"')) {
    return { kind: "whisper", content: trimmed.slice(1).trim() };
  }
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    return { kind: "question", content: trimmed.slice(1, -1).trim() };
  }
  return { kind: "action", content: trimmed };
};

const actionVerbHints = [
  "ataco", "golpeio", "corro", "pulo", "escalo", "entro", "saio", "falo", "pergunto",
  "intimido", "conjuro", "invoco", "uso", "pego", "procuro", "investigo", "me escondo",
];

const splitMicroActions = (content: string): string[] => {
  const normalized = content
    .replace(/\s+\|\s+/g, ". ")
    .replace(/\s*;\s*/g, ". ")
    .replace(/\s+depois\s+/gi, ". ")
    .replace(/\s+entao\s+/gi, ". ")
    .replace(/\s+então\s+/gi, ". ");
  const pieces = normalized.split(/\.\s+/).map((piece) => piece.trim()).filter(Boolean);
  if (pieces.length > 1) return pieces;

  const lower = normalize(content);
  const hintedVerbs = actionVerbHints.filter((verb) => lower.includes(normalize(verb))).length;
  if (hintedVerbs < 2) return [content.trim()];

  return content
    .split(/\s+e\s+(?=(?:ataco|golpeio|corro|pulo|escalo|entro|saio|falo|pergunto|intimido|conjuro|invoco|uso|pego|procuro|investigo|me escondo)\b)/i)
    .map((piece) => piece.trim())
    .filter(Boolean);
};

const inferSkillHint = (content: string, intent: ActionIntent): string | undefined => {
  const text = normalize(content);
  if (intent === "social") {
    if (includesAny(text, ["ameaco", "intimido", "assusto", "pressiono"])) return "intimidation";
    if (includesAny(text, ["minto", "engano", "blefo", "disfarco"])) return "deception";
    return "persuasion";
  }
  if (intent === "exploration") {
    if (includesAny(text, ["rastro", "trilha", "pegada", "sobrevivencia"])) return "survival";
    if (includesAny(text, ["magia", "runa", "arcano", "feitico", "encantamento"])) return "arcana";
    return "investigation";
  }
  if (intent === "movement") {
    if (includesAny(text, ["escond", "furtiv", "silenc"])) return "stealth";
    if (includesAny(text, ["salto", "equilib", "desvio"])) return "acrobatics";
    return "athletics";
  }
  if (intent === "cast_spell") return "arcana";
  if (intent === "attack") return "melee";
  return undefined;
};

export const planPlayerAction = (room: RoomState, player: Player, action: PlayerAction): ActionPlan => {
  const parsedRaw = parsePlayerInput(action.content);
  const microActions = parsedRaw.kind === "action" ? splitMicroActions(parsedRaw.content) : [parsedRaw.content];
  const parsed = {
    ...parsedRaw,
    content: microActions[0] ?? parsedRaw.content,
  };
  const text = normalize(parsed.content);
  const notes: string[] = [];

  if (microActions.length > 1) {
    notes.push(`Ação composta detectada (${microActions.length} partes). Resolva apenas a primeira microação agora: "${parsed.content}". As demais aguardam próximos turnos.`);
  }

  if (parsed.kind === "question") {
    const isRulingQuestion = includesAny(text, [
      "regra", "sistema", "decisao", "decisão", "discordo", "nao concordo", "não concordo",
      "injusto", "pode isso", "posso fazer", "deveria", "mas eu", "argumento", "explica",
      "por que", "porque", "cd", "classe de dificuldade", "vantagem", "desvantagem",
    ]);
    return {
      ...parsed,
      intent: isRulingQuestion ? "ruling" : "question",
      risk: "safe",
      shouldStartCombat: false,
      needsRoll: false,
      turnSteps: isRulingQuestion
        ? ["Ouvir o argumento", "Consultar sistema e estado canônico", "Dar decisão final do Mestre", "Encerrar a discussão e manter a mesa andando"]
        : ["Responder pergunta OOC", "Manter estado da cena", "Não avançar ameaça nem tempo ficcional"],
      orchestrationNotes: isRulingQuestion
        ? ["Conflito ou dúvida de mesa: o Mestre considera argumentos, mas a palavra final é definitiva."]
        : ["Pergunta fora de personagem: responda como Mestre, sem avançar a ficção."],
    };
  }

  if (parsed.kind === "speech" || parsed.kind === "whisper") {
    return {
      ...parsed,
      intent: "social",
      risk: "safe",
      shouldStartCombat: false,
      needsRoll: false,
      skillHint: "persuasion",
      turnSteps: ["Identificar destinatário", "Responder com voz/emoção do NPC ou ambiente", "Atualizar tensão social sem combate"],
      orchestrationNotes: ["Diálogo não inicia combate por si só. NPCs devem responder como pessoas com objetivos e emoções."],
    };
  }

  const hostileVerbs = [
    "ataco", "atacar", "golpeio", "corto", "esfaqueio", "disparo", "atiro", "flecha", "acertar o monstro", "acertar a criatura",
    "lanço fireball em", "lanco fireball em", "lanço bola de fogo em", "lanco bola de fogo em",
    "mato", "tento matar", "esmago", "quebro o cranio",
  ];
  const clearHostileTarget = includesAny(text, hostileVerbs);
  const hasExistingEnemy = hasEstablishedAttackTarget(room);

  let intent: ActionIntent = "unknown";
  if (clearHostileTarget) {
    intent = "attack";
  } else if (includesAny(text, ["conjuro", "lanco magia", "lanço magia", "uso magia", "preparo magia"])) {
    intent = "cast_spell";
  } else if (includesAny(text, ["falo", "pergunto", "converso", "negocio", "convenço", "convenco", "peço", "peco", "explico"])) {
    intent = "social";
  } else if (includesAny(text, ["examino", "investigo", "procuro", "observo", "escuto", "vasculho", "leio", "analiso"])) {
    intent = "exploration";
  } else if (includesAny(text, ["ando", "vou", "entro", "saio", "subo", "desço", "desco", "corro", "me escondo", "aproximo"])) {
    intent = "movement";
  } else if (includesAny(text, ["pego", "guardo", "equipo", "uso item", "mochila", "inventario", "inventário"])) {
    intent = "inventory";
  } else if (includesAny(text, ["descanso", "durmo", "acampo", "recupero"])) {
    intent = "rest";
  }

  let risk: ActionRisk = "safe";
  if (intent === "attack") risk = "dangerous";
  if (["cast_spell", "exploration", "movement", "inventory"].includes(intent)) risk = "uncertain";
  if (intent === "social" || intent === "rest") risk = "safe";

  const passiveObservation = intent === "exploration" && includesAny(text, passiveObservationTerms) && !includesAny(text, hiddenSearchTerms);
  const simpleReading = intent === "exploration" && includesAny(text, ["leio", "ler", "examino o livro", "lingua comum", "texto comum"]);
  if ((passiveObservation || simpleReading) && !hasImmediatePressure(room)) {
    risk = "safe";
    notes.push("Observacao ou leitura simples: descreva apenas o que esta visivel e ja estabelecido. Nao invente segredo, pista ou inimigo para justificar rolagem.");
  }

  const shouldStartCombat = parsed.kind === "action" && intent === "attack" && hasExistingEnemy;
  const needsRoll = !shouldStartCombat && risk !== "safe" && ["cast_spell", "exploration", "movement"].includes(intent);

  if (intent === "attack" && !hasExistingEnemy) {
    notes.push("Nao inicie combate apenas porque o jogador declarou ataque. Primeiro confirme que o alvo ja existe no estado canonico da cena.");
  }
  if (intent !== "attack") {
    notes.push("Não transforme esta ação em luta. Resolva com exploração, diálogo, descoberta, custo narrativo ou pedido de rolagem.");
  }
  if (needsRoll) {
    notes.push("Antes de pedir dado, confirme que existe segredo, oposicao, pressao, risco ou consequencia concreta. Caso contrario, resolva sem rolagem.");
  }
  if (risk === "safe") {
    notes.push("Ação segura: avance a ficção com resposta natural, sem pedir dado salvo se houver oposição real.");
  }

  return {
    ...parsed,
    intent,
    risk,
    shouldStartCombat,
    needsRoll,
    skillHint: inferSkillHint(parsed.content, intent),
    turnSteps: buildTurnSteps(intent, risk, shouldStartCombat, needsRoll),
    orchestrationNotes: notes,
  };
};

const buildTurnSteps = (intent: ActionIntent, risk: ActionRisk, shouldStartCombat: boolean, needsRoll: boolean): string[] => {
  if (shouldStartCombat) {
    return ["Confirmar alvo presente", "Iniciar ou continuar combate", "Resolver regra mecânica", "Narrar consequência imediata"];
  }

  if (needsRoll) {
    return ["Entender objetivo concreto", "Confirmar risco real", "Pedir exatamente uma rolagem", "Aguardar resultado antes de narrar sucesso/falha"];
  }

  if (intent === "social") {
    return ["Entender intenção social", "Responder pelo NPC ou pela cena", "Atualizar relação/tensão", "Deixar próxima decisão aberta"];
  }

  if (intent === "ruling") {
    return ["Ouvir argumento", "Comparar com regras e estado", "Decidir como Mestre", "Registrar que a decisão é final"];
  }

  if (risk === "safe") {
    return ["Aplicar ação simples", "Mostrar detalhe sensorial", "Atualizar cena se necessário", "Convidar próxima decisão"];
  }

  return ["Interpretar ação", "Checar estado atual", "Resolver menor consequência possível", "Narrar sem escalar para luta"];
};
