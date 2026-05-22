import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.PLAYTEST_BASE_URL ?? "http://127.0.0.1:8787";
const rootDir = path.resolve("playtest-logs");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(rootDir, `combat-level1-to3-${stamp}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let rngState = 0x5eed1234;
const random = () => {
  rngState = (1664525 * rngState + 1013904223) >>> 0;
  return rngState / 0x100000000;
};

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
    classLevels: player.classLevels,
    level: player.level,
    experiencePoints: player.experiencePoints,
    nextLevelExperience: player.nextLevelExperience,
    pendingLevelUps: player.pendingLevelUps,
    hp: `${player.hitPoints}/${player.maxHitPoints}`,
    ac: player.armorClass,
    features: player.features,
    spells: player.spells,
    loreEvents: player.loreEvents,
    moralProfile: player.moralProfile,
  })),
  combat: room.combat,
  messageCount: room.messages.length,
});

const latestMessages = (before, after) => {
  const known = new Set((before?.messages ?? []).map((message) => message.id));
  return (after?.messages ?? []).filter((message) => !known.has(message.id));
};

const livingPlayer = (room, playerId) => {
  const player = room.players.find((entry) => entry.id === playerId);
  return player && player.hitPoints > 0 ? player : null;
};

const rollValueFor = (pending) => {
  const sides = Number(String(pending.die).replace("d", ""));
  return 1 + Math.floor(random() * sides);
};

const resolvePendingRolls = async (room, playerId, transcript, maxRolls = 20) => {
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
    transcript.push({
      type: "roll",
      pending,
      result: [value],
      newMessages: latestMessages(before, current),
      room: summarizeRoom(current),
    });
    await wait(100);
  }
  return current;
};

const waitForActiveRoom = async (roomId, transcript) => {
  const deadline = Date.now() + 180000;
  let last;
  while (Date.now() < deadline) {
    last = await requestJson(`${baseUrl}/api/rooms/${roomId}`, {}, "poll room");
    if (last.status === "active" && last.messages.some((message) => message.role === "gm")) {
      transcript.push({ type: "session-active", room: summarizeRoom(last) });
      return last;
    }
    await wait(2500);
  }
  throw new Error(`Room did not become active. Last status: ${last?.status ?? "unknown"}`);
};

const applyLevelUps = async (room, playerId, transcript) => {
  let current = room;
  let player = current.players.find((entry) => entry.id === playerId);
  while ((player?.pendingLevelUps ?? 0) > 0) {
    const before = current;
    current = await postJson(`${baseUrl}/api/rooms/${current.id}/players/${playerId}/level-up`, {
      className: "Ranger",
      newSkillProficiencies: [],
      newSpells: [],
    }, "apply level up");
    transcript.push({
      type: "level-up",
      newMessages: latestMessages(before, current),
      room: summarizeRoom(current),
    });
    player = current.players.find((entry) => entry.id === playerId);
  }
  return current;
};

const fightEncounter = async (room, playerId, transcript, encounterNumber) => {
  let current = room;
  if (!livingPlayer(current, playerId)) {
    transcript.push({
      type: "encounter-skipped",
      encounterNumber,
      reason: "O personagem principal esta com 0 HP antes do encontro.",
      room: summarizeRoom(current),
    });
    return current;
  }

  if (!current.combat.active) {
    const before = current;
    current = await postJson(`${baseUrl}/api/rooms/${current.id}/encounters/start`, {
      triggeringPlayerId: playerId,
    }, `start encounter ${encounterNumber}`);
    transcript.push({
      type: "encounter-start",
      encounterNumber,
      newMessages: latestMessages(before, current),
      room: summarizeRoom(current),
    });
  }

  let guard = 0;
  while (current.combat.active && guard < 80) {
    guard += 1;
    if (!livingPlayer(current, playerId)) {
      transcript.push({
        type: "defeat-detected",
        encounterNumber,
        reason: "O personagem principal chegou a 0 HP durante o combate.",
        room: summarizeRoom(current),
      });
      break;
    }

    current = await resolvePendingRolls(current, playerId, transcript);
    if (!livingPlayer(current, playerId)) {
      transcript.push({
        type: "defeat-detected",
        encounterNumber,
        reason: "O personagem principal caiu apos uma rolagem/resolucao.",
        room: summarizeRoom(current),
      });
      break;
    }
    if (!current.combat.active) break;

    const actor = current.combat.order[current.combat.currentTurnIndex];
    if (actor?.side !== "player") {
      current = await resolvePendingRolls(current, playerId, transcript);
      await wait(100);
      continue;
    }

    const target = current.combat.enemies.find((enemy) => enemy.hitPoints > 0);
    if (!target) break;
    const before = current;
    current = await postJson(`${baseUrl}/api/rooms/${current.id}/actions`, {
      playerId,
      content: `*ataco ${target.name} com meu arco longo mantendo distancia e cobertura`,
    }, `attack ${target.name}`);
    transcript.push({
      type: "attack-action",
      target: target.name,
      newMessages: latestMessages(before, current),
      room: summarizeRoom(current),
    });
    current = await resolvePendingRolls(current, playerId, transcript);
  }

  current = await applyLevelUps(current, playerId, transcript);
  return current;
};

const writeMarkdown = async (room, transcript, analysis) => {
  const lines = [
    "# Playtest de combate level 1 ate 3",
    "",
    `- Sala: ${room.name}`,
    `- Codigo: ${room.code}`,
    `- Room ID: ${room.id}`,
    `- Gerado em: ${new Date().toISOString()}`,
    "",
    "## Resultado",
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

  lines.push("## Eventos mecanicos", "", "```json", JSON.stringify(transcript, null, 2), "```");
  await fs.writeFile(path.join(runDir, "transcript.md"), lines.join("\n"), "utf-8");
};

const main = async () => {
  await fs.mkdir(runDir, { recursive: true });
  const transcript = [];
  const integrationsBefore = await requestJson(`${baseUrl}/api/integrations`, {}, "integrations");
  const monsterCatalog = await requestJson(`${baseUrl}/api/monster-catalog`, {}, "monster catalog");

  const room = await postJson(`${baseUrl}/api/rooms`, {
    name: `Playtest Combate L1-L3 ${stamp.slice(0, 16)}`,
    setup: {
      systemId: "dnd5e-srd",
      startingLevel: 1,
      npcCompanions: 0,
      enemyDifficulty: "deadly",
      battleIntensity: "high",
      gmKindness: "balanced",
    },
  }, "create room");

  const joined = await postJson(`${baseUrl}/api/rooms/${room.id}/join`, {
    name: "Playtester",
    characterName: "Mira Valen",
    className: "Ranger",
    species: "Human",
    gender: "female",
    background: "Outlander",
    physicalDescription: "mulher jovem adulta de pele morena, cabelo castanho preso em trancas curtas, cicatriz fina no supercilio esquerdo",
    outfitDescription: "capa verde gasta, couro de patrulheira remendado e botas enlameadas",
    origin: "Mira cresceu em uma aldeia de fronteira onde todos conhecem o preco de uma patrulha atrasada.",
    motivation: "Ela quer proteger viajantes e provar que a ameaca da estrada e real.",
    turningPoint: "Encontrou marcas impossiveis na palicada e decidiu rastrear a origem.",
    connections: "Conhece guardas de fronteira e deve um favor a uma curandeira chamada Iria.",
    backstory: "Mira saiu da aldeia para investigar desaparecimentos e prefere poupar rendidos, mas luta com firmeza contra monstros que ameacam inocentes.",
    skillProficiencies: ["survival", "perception", "stealth"],
    spellSelection: ["Hunter's Mark", "Cure Wounds"],
    equipmentChoice: 0,
  }, "join principal");

  transcript.push({ type: "created-room", room: summarizeRoom(room) });
  transcript.push({ type: "joined-player", player: joined.player, room: summarizeRoom(joined.room) });

  let current = await postJson(`${baseUrl}/api/rooms/${room.id}/players/${joined.player.id}/ready`, { ready: true }, "ready principal");
  current = await postJson(`${baseUrl}/api/rooms/${room.id}/start`, {
    hostPlayerId: joined.player.id,
    sceneKeyword: "forest road",
    adventureTitle: "Rastros na Estrada Velha",
    adventureHook: "Comece em uma estrada de fronteira simples. Mira rastreia desaparecimentos perto da floresta. Nao feche a aventura: apresente apenas o local, uma pista e espaco para acao.",
  }, "start session");
  current = await waitForActiveRoom(room.id, transcript);

  let encounter = 0;
  while ((current.players.find((entry) => entry.id === joined.player.id)?.level ?? 1) < 3 && encounter < 12) {
    const principalNow = current.players.find((entry) => entry.id === joined.player.id);
    if (!principalNow || principalNow.hitPoints <= 0) {
      transcript.push({
        type: "playtest-stopped",
        reason: "Personagem principal derrotado. O teste nao inicia novos encontros com HP 0.",
        encounter,
        room: summarizeRoom(current),
      });
      break;
    }
    encounter += 1;
    current = await fightEncounter(current, joined.player.id, transcript, encounter);
    await wait(150);
  }

  const finalRoom = await requestJson(`${baseUrl}/api/rooms/${room.id}`, {}, "final room");
  const integrationsAfter = await requestJson(`${baseUrl}/api/integrations`, {}, "integrations after");
  const llmStats = await requestJson(`${baseUrl}/api/llm-stats?limit=200`, {}, "llm stats");
  const principal = finalRoom.players.find((entry) => entry.id === joined.player.id);
  const analysis = {
    runDir,
    roomId: finalRoom.id,
    roomCode: finalRoom.code,
    encounters: encounter,
    finalLevel: principal?.level,
    defeated: principal ? principal.hitPoints <= 0 : null,
    stopReason: principal && principal.hitPoints <= 0
      ? "Personagem principal derrotado antes de atingir o nivel 3."
      : (principal?.level ?? 1) >= 3
        ? "Nivel 3 atingido."
        : "Limite de encontros atingido.",
    classLevels: principal?.classLevels,
    experiencePoints: principal?.experiencePoints,
    pendingLevelUps: principal?.pendingLevelUps,
    hp: principal ? `${principal.hitPoints}/${principal.maxHitPoints}` : null,
    features: principal?.features,
    spells: principal?.spells,
    loreEvents: principal?.loreEvents?.length ?? 0,
    combatEnded: !finalRoom.combat.active,
    integrations: integrationsAfter,
    llmStats: llmStats.stats,
    monsterCatalogCount: monsterCatalog.monsters?.length ?? 0,
  };

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
