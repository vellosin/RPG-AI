import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.PLAYTEST_BASE_URL ?? "http://127.0.0.1:8787";
const rootDir = path.resolve("playtest-logs");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(rootDir, `story-combat-level1-to3-${stamp}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rollCycle = [12, 16, 9, 14, 7, 18, 11, 15, 6, 13, 17, 10];
let rollIndex = 0;

const requestJson = async (url, options = {}, label = url, timeoutMs = 180000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}: ${JSON.stringify(body)}`);
    return body;
  } finally {
    clearTimeout(timeout);
  }
};

const postJson = (url, payload, label) => requestJson(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
}, label);

const latestMessages = (before, after) => {
  const known = new Set((before?.messages ?? []).map((message) => message.id));
  return (after?.messages ?? []).filter((message) => !known.has(message.id));
};

const summarizeRoom = (room) => ({
  id: room.id,
  code: room.code,
  name: room.name,
  status: room.status,
  scene: room.scene,
  players: room.players.map((player) => ({
    id: player.id,
    characterName: player.characterName,
    className: player.className,
    gender: player.gender,
    level: player.level,
    classLevels: player.classLevels,
    experiencePoints: player.experiencePoints,
    nextLevelExperience: player.nextLevelExperience,
    pendingLevelUps: player.pendingLevelUps,
    hp: `${player.hitPoints}/${player.maxHitPoints}`,
    ac: player.armorClass,
    loreEvents: player.loreEvents,
    moralProfile: player.moralProfile,
  })),
  combat: room.combat,
  messageCount: room.messages.length,
});

const rollValueFor = (pending) => {
  const sides = Number(String(pending.die).replace("d", ""));
  if (pending.kind === "combat_damage") return Math.max(1, Math.ceil(sides * 0.65));
  const value = rollCycle[rollIndex % rollCycle.length];
  rollIndex += 1;
  return Math.min(sides, Math.max(1, value));
};

const resolvePendingRolls = async (room, playerId, transcript, maxRolls = 8) => {
  let current = room;
  for (let i = 0; i < maxRolls; i += 1) {
    const pending = current.scene?.pendingRollRequest;
    if (!pending) return current;
    const sides = Number(String(pending.die).replace("d", ""));
    const value = rollValueFor(pending);
    const before = current;
    current = await postJson(`${baseUrl}/api/rooms/${current.id}/rolls`, {
      playerId,
      count: 1,
      sides,
      modifier: pending.modifier ?? 0,
      results: [value],
    }, `roll ${pending.description}`);
    transcript.push({ type: "roll", pending, result: [value], newMessages: latestMessages(before, current), room: summarizeRoom(current) });
    await wait(250);
  }
  return current;
};

const waitForActiveRoom = async (roomId, transcript) => {
  const deadline = Date.now() + 240000;
  let last;
  while (Date.now() < deadline) {
    last = await requestJson(`${baseUrl}/api/rooms/${roomId}`, {}, "poll room");
    if (last.status === "active" && last.messages.some((message) => message.role === "gm")) {
      transcript.push({ type: "session-active", room: summarizeRoom(last) });
      return last;
    }
    await wait(3000);
  }
  throw new Error(`Room did not become active. Last status: ${last?.status ?? "unknown"}`);
};

const action = async (room, playerId, content, transcript) => {
  const before = room;
  const afterAction = await postJson(`${baseUrl}/api/rooms/${room.id}/actions`, { playerId, content }, `action ${content.slice(0, 40)}`);
  transcript.push({ type: "action", content, newMessages: latestMessages(before, afterAction), room: summarizeRoom(afterAction) });
  return resolvePendingRolls(afterAction, playerId, transcript);
};

const applyLevelUps = async (room, playerId, transcript) => {
  let current = room;
  let player = current.players.find((entry) => entry.id === playerId);
  while ((player?.pendingLevelUps ?? 0) > 0) {
    const before = current;
    current = await postJson(`${baseUrl}/api/rooms/${current.id}/players/${playerId}/level-up`, {
      className: "Ranger",
      newSkillProficiencies: [],
      newSpells: ["Hunter's Mark", "Cure Wounds"],
    }, "apply level up");
    transcript.push({ type: "level-up", newMessages: latestMessages(before, current), room: summarizeRoom(current) });
    player = current.players.find((entry) => entry.id === playerId);
  }
  return current;
};

const milestone = async (room, playerId, payload, transcript) => {
  const before = room;
  let current = await postJson(`${baseUrl}/api/rooms/${room.id}/milestones`, { playerId, ...payload }, `milestone ${payload.title}`);
  transcript.push({ type: "milestone", payload, newMessages: latestMessages(before, current), room: summarizeRoom(current) });
  current = await applyLevelUps(current, playerId, transcript);
  return current;
};

const fightEncounter = async (room, playerId, transcript, label) => {
  let current = room;
  const before = current;
  current = await postJson(`${baseUrl}/api/rooms/${current.id}/encounters/start`, { triggeringPlayerId: playerId }, `start encounter ${label}`);
  transcript.push({ type: "encounter-start", label, newMessages: latestMessages(before, current), room: summarizeRoom(current) });

  let guard = 0;
  while (current.combat.active && guard < 60) {
    guard += 1;
    const player = current.players.find((entry) => entry.id === playerId);
    if (!player || player.hitPoints <= 0) break;
    current = await resolvePendingRolls(current, playerId, transcript);
    if (!current.combat.active) break;
    const actor = current.combat.order[current.combat.currentTurnIndex];
    if (actor?.side !== "player") {
      await wait(150);
      continue;
    }
    const target = current.combat.enemies.find((enemy) => enemy.hitPoints > 0);
    if (!target) break;
    current = await action(current, playerId, `*ataco ${target.name} com meu arco longo, mantendo cobertura e protegendo inocentes próximos.`, transcript);
  }
  return current;
};

const analyse = (room, transcript, integrations, llmStats) => {
  const text = room.messages.map((message) => message.content).join("\n");
  const principal = room.players[0];
  const combatsStarted = transcript.filter((entry) => entry.type === "encounter-start").length;
  const milestones = transcript.filter((entry) => entry.type === "milestone").length;
  const longRests = transcript.filter((entry) => entry.type === "action" && /descanso longo|dormir|pernoitar/i.test(entry.content)).length;
  return {
    runDir,
    roomId: room.id,
    roomCode: room.code,
    principal: principal ? {
      name: principal.characterName,
      level: principal.level,
      xp: principal.experiencePoints,
      pendingLevelUps: principal.pendingLevelUps,
      hp: `${principal.hitPoints}/${principal.maxHitPoints}`,
      loreEvents: principal.loreEvents?.length ?? 0,
      moralLabel: principal.moralProfile?.label,
    } : null,
    storyArc: room.scene.storyArc,
    sceneNpcs: room.scene.activeNpcs ?? [],
    counters: {
      totalMessages: room.messages.length,
      actions: transcript.filter((entry) => entry.type === "action").length,
      rolls: transcript.filter((entry) => entry.type === "roll").length,
      combatsStarted,
      milestones,
      longRests,
    },
    qualitySignals: {
      mixedStoryAndCombat: combatsStarted >= 2 && milestones >= 2 && /rumor|boato|prova|chefe de segurança|taberna|cidade/i.test(text),
      maxThreeCombatsBeforeLongRest: (room.scene.storyArc?.recentCombatsSinceLongRest ?? 0) <= 3,
      reachedLevel3Mechanically: (principal?.level ?? 1) >= 3,
      hasStoryArcClues: (room.scene.storyArc?.knownClues?.length ?? 0) > 0,
      hasNextSessionHook: Boolean(room.scene.storyArc?.nextSessionHook) || /mandante|chefe|superior|por tras|por trás/i.test(text),
      noVictorySkipDenied: text.includes("Continuidade protegida"),
    },
    integrations,
    llmStats: llmStats.stats,
  };
};

const writeMarkdown = async (room, transcript, analysis) => {
  const lines = [
    "# Playtest de aventura mista level 1 ate 3",
    "",
    `- Sala: ${room.name}`,
    `- Codigo: ${room.code}`,
    `- Room ID: ${room.id}`,
    `- Gerado em: ${new Date().toISOString()}`,
    "",
    "## Analise",
    "",
    "```json",
    JSON.stringify(analysis, null, 2),
    "```",
    "",
    "## Transcricao",
    "",
  ];
  for (const message of room.messages) {
    lines.push(`### ${message.authorName} (${message.kind})`, "", message.content, "");
  }
  lines.push("## Eventos", "", "```json", JSON.stringify(transcript, null, 2), "```");
  await fs.writeFile(path.join(runDir, "transcript.md"), lines.join("\n"), "utf-8");
};

const main = async () => {
  await fs.mkdir(runDir, { recursive: true });
  const transcript = [];
  const integrationsBefore = await requestJson(`${baseUrl}/api/integrations`, {}, "integrations");

  const room = await postJson(`${baseUrl}/api/rooms`, {
    name: `Playtest Vinganca L1-L3 ${stamp.slice(0, 16)}`,
    setup: {
      systemId: "dnd5e-srd",
      startingLevel: 1,
      npcCompanions: 0,
      enemyDifficulty: "story",
      battleIntensity: "low",
      gmKindness: "balanced",
    },
  }, "create room");

  const joined = await postJson(`${baseUrl}/api/rooms/${room.id}/join`, {
    name: "Playtester",
    characterName: "Kael",
    className: "Ranger",
    species: "Human",
    gender: "male",
    background: "Outlander",
    physicalDescription: "homem jovem de rosto cansado, olhos castanhos atentos, cabelo preto preso para tras, uma cicatriz pequena no queixo",
    outfitDescription: "capa escura de viagem, couro gasto de patrulheiro e roupas simples de estrada",
    origin: "Kael cresceu numa pequena fazenda de fronteira destruida por homens armados quando ele era adolescente.",
    motivation: "Ele busca vinganca contra o homem de cicatriz no pescoço que matou sua familia e desapareceu levando um anel de sinete.",
    turningPoint: "Depois de anos rastreando boatos, Kael aprendeu que o assassino talvez tenha assumido uma identidade respeitavel em outra cidade.",
    connections: "Um velho taverneiro chamado Orlan conheceu seu pai e pode reconhecer o sinete roubado.",
    backstory: "Kael tenta agir com justiça, mas sua sede de vinganca o empurra para decisões perigosas. Ele quer provar a culpa do assassino antes de mata-lo.",
    skillProficiencies: ["survival", "perception", "stealth"],
    equipmentChoice: 0,
  }, "join principal");
  transcript.push({ type: "created-room", room: summarizeRoom(room) });
  transcript.push({ type: "joined-player", player: joined.player, room: summarizeRoom(joined.room) });

  let current = await postJson(`${baseUrl}/api/rooms/${room.id}/players/${joined.player.id}/ready`, { ready: true }, "ready");
  current = await postJson(`${baseUrl}/api/rooms/${room.id}/start`, {
    hostPlayerId: joined.player.id,
    sceneKeyword: "tavern",
    adventureTitle: "O Sinete do Carrasco",
    adventureHook: "Kael esta bebendo sozinho numa taberna quando ouve homens falando do homem que matou sua familia. Comece apenas com esse rumor e a tensao da taberna. Nao revele a aventura inteira.",
  }, "start session");
  current = await waitForActiveRoom(room.id, transcript);

  current = await action(current, joined.player.id, '*fico quieto na mesa e tento ouvir melhor a conversa dos homens sem chamar atencao.', transcript);
  current = await action(current, joined.player.id, '-pergunto ao taverneiro Orlan, em voz baixa, se ele reconhece o nome ou o sinete mencionado pelos homens.', transcript);
  current = await action(current, joined.player.id, '*quando os homens saem, sigo a distancia pela estrada, tentando descobrir para qual cidade eles levam a pista.', transcript);
  current = await fightEncounter(current, joined.player.id, transcript, "batedores na estrada");
  current = await action(current, joined.player.id, '*examino os pertences dos atacantes em busca de um simbolo, carta ou rota ligada ao homem da cicatriz no pescoco.', transcript);
  current = await milestone(current, joined.player.id, {
    title: "Pista do sinete recuperada",
    description: "Kael sobreviveu a uma emboscada e encontrou uma rota que liga os capangas a uma cidade onde o assassino pode estar protegido.",
    xp: 300,
  }, transcript);

  current = await action(current, joined.player.id, '*viajo ate a cidade indicada e entro apenas ao anoitecer, procurando uma estalagem discreta para descansar.', transcript);
  current = await action(current, joined.player.id, '*faco um descanso longo na estalagem antes de investigar a cidade.', transcript);
  current = await action(current, joined.player.id, '-converso com o senhor bondoso da estalagem sobre a cidade, deixando que ele fale das mudancas na seguranca local.', transcript);
  current = await action(current, joined.player.id, '*investigo discretamente o novo chefe de seguranca, procurando registros antigos, testemunhas e sinais do sinete roubado.', transcript);
  current = await action(current, joined.player.id, '*aceito ajudar um comerciante ameaçado por guardas corruptos se isso me aproximar de uma prova contra o chefe de seguranca.', transcript);
  current = await fightEncounter(current, joined.player.id, transcript, "capangas corruptos na viela");
  current = await action(current, joined.player.id, '*recolho a prova da extorsao e procuro ligar os capangas ao chefe de seguranca sem me expor.', transcript);
  current = await milestone(current, joined.player.id, {
    title: "Corrupcao local comprovada",
    description: "Kael ligou os capangas da cidade ao chefe de seguranca e ganhou uma prova concreta para continuar a investigacao.",
    xp: 350,
  }, transcript);

  current = await action(current, joined.player.id, '*uso furtividade para entrar no escritorio do chefe de seguranca enquanto ele esta fora, procurando o anel de sinete da minha familia.', transcript);
  current = await action(current, joined.player.id, '-mostro a prova ao estalajadeiro Orlan e pergunto quem na cidade teria coragem de testemunhar publicamente.', transcript);
  current = await action(current, joined.player.id, '*preparo a exposicao publica da prova, mas sem atacar o chefe ainda; quero que todos vejam quem ele realmente e.', transcript);
  current = await milestone(current, joined.player.id, {
    title: "Identidade do assassino exposta",
    description: "Kael reuniu prova suficiente para expor que o chefe de seguranca e o homem que matou sua familia, descobrindo tambem que ele responde a um mandante maior.",
    xp: 300,
  }, transcript);

  const finalRoom = await requestJson(`${baseUrl}/api/rooms/${room.id}`, {}, "final room");
  const integrationsAfter = await requestJson(`${baseUrl}/api/integrations`, {}, "integrations after");
  const llmStats = await requestJson(`${baseUrl}/api/llm-stats?limit=200`, {}, "llm stats");
  const analysis = analyse(finalRoom, transcript, integrationsAfter, llmStats);
  await fs.writeFile(path.join(runDir, "room-final.json"), JSON.stringify(finalRoom, null, 2), "utf-8");
  await fs.writeFile(path.join(runDir, "events.json"), JSON.stringify(transcript, null, 2), "utf-8");
  await fs.writeFile(path.join(runDir, "integrations-before.json"), JSON.stringify(integrationsBefore, null, 2), "utf-8");
  await fs.writeFile(path.join(runDir, "integrations-after.json"), JSON.stringify(integrationsAfter, null, 2), "utf-8");
  await fs.writeFile(path.join(runDir, "llm-stats.json"), JSON.stringify(llmStats, null, 2), "utf-8");
  await fs.writeFile(path.join(runDir, "analysis.json"), JSON.stringify(analysis, null, 2), "utf-8");
  await writeMarkdown(finalRoom, transcript, analysis);
  console.log(JSON.stringify(analysis, null, 2));
};

main().catch(async (error) => {
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "error.log"), `${error.stack ?? error.message}\n`, "utf-8");
  console.error(error.stack ?? error.message);
  process.exit(1);
});
