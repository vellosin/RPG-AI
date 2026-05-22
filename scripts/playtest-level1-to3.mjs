import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.PLAYTEST_BASE_URL ?? "http://127.0.0.1:8787";
const rootDir = path.resolve("playtest-logs");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = path.join(rootDir, `level1-to3-${stamp}`);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requestJson = async (url, options = {}, label = url, timeoutMs = 180000) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!response.ok) {
      throw new Error(`${label} failed with HTTP ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    }
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
    controller: player.controller,
    className: player.className,
    species: player.species,
    gender: player.gender,
    level: player.level,
    hp: `${player.hitPoints}/${player.maxHitPoints}`,
    ac: player.armorClass,
    features: player.features,
    spells: player.spells,
    loreEvents: player.loreEvents,
    moralProfile: player.moralProfile,
  })),
  combat: room.combat,
  imageJobs: room.imageJobs,
  memory: room.memory,
  messageCount: room.messages.length,
});

const rollValueFor = (pending, preference = "success") => {
  const sides = Number(String(pending.die).replace("d", ""));
  if (pending.kind === "combat_damage") return Math.min(sides, Math.max(1, sides - 1));
  if (preference === "fail") return 2;
  const needed = Number(pending.difficulty ?? 10) - Number(pending.modifier ?? 0);
  return Math.min(sides, Math.max(1, needed + 2));
};

const resolvePendingRolls = async (room, playerId, transcript, maxRolls = 5) => {
  let current = room;
  for (let i = 0; i < maxRolls; i += 1) {
    const pending = current.scene?.pendingRollRequest;
    if (!pending) return current;
    const sides = Number(String(pending.die).replace("d", ""));
    const value = rollValueFor(pending, "success");
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
      transcript.push({
        type: "session-active",
        room: summarizeRoom(last),
        newMessages: last.messages,
      });
      return last;
    }
    await wait(3000);
  }
  throw new Error(`Room did not become active. Last status: ${last?.status ?? "unknown"}`);
};

const action = async (room, playerId, content, transcript) => {
  const before = room;
  const afterAction = await postJson(`${baseUrl}/api/rooms/${room.id}/actions`, {
    playerId,
    content,
  }, `action ${content.slice(0, 50)}`);
  transcript.push({
    type: "action",
    content,
    newMessages: latestMessages(before, afterAction),
    room: summarizeRoom(afterAction),
  });
  return resolvePendingRolls(afterAction, playerId, transcript);
};

const analyse = (room, transcript, integrations, llmStats) => {
  const text = room.messages.map((message) => message.content).join("\n");
  const gmText = room.messages.filter((message) => message.role === "gm").map((message) => message.content).join("\n");
  const principal = room.players[0];
  const companions = room.scene.activeNpcs?.filter((npc) => npc.relation === "companion") ?? [];
  const sceneNpcs = room.scene.activeNpcs?.filter((npc) => npc.relation !== "companion") ?? [];
  const englishLeaks = gmText.match(/\b(the|attack|damage|miss|hit|roll|enemy|turn|rule)\b/gi) ?? [];
  const pronounSuspicion = principal?.gender === "female"
    ? (gmText.match(/\b(ele|dele|sozinho|chamado|designado|enviado)\b/gi) ?? [])
    : (gmText.match(/\b(ela|dela|sozinha|chamada|designada|enviada)\b/gi) ?? []);
  const fallbackCalls = (llmStats.recent ?? []).filter((call) => call.mode === "fallback" || !call.ok);

  return {
    roomId: room.id,
    roomCode: room.code,
    finalStatus: room.status,
    totalMessages: room.messages.length,
    totalActions: transcript.filter((entry) => entry.type === "action").length,
    totalRolls: transcript.filter((entry) => entry.type === "roll").length,
    principal: principal ? {
      name: principal.characterName,
      gender: principal.gender,
      className: principal.className,
      species: principal.species,
      level: principal.level,
      hp: `${principal.hitPoints}/${principal.maxHitPoints}`,
      loreEvents: principal.loreEvents?.length ?? 0,
      moralLabel: principal.moralProfile?.label ?? null,
    } : null,
    companions: companions.map((npc) => ({ name: npc.name, role: npc.role, className: npc.className, race: npc.race, level: npc.level })),
    sceneNpcs: sceneNpcs.map((npc) => ({ name: npc.name, role: npc.role, relation: npc.relation })),
    memoryEntries: room.memory.entries.length,
    imageJobs: {
      total: room.imageJobs.length,
      done: room.imageJobs.filter((job) => job.status === "done").length,
      queued: room.imageJobs.filter((job) => job.status === "queued").length,
      byProfile: room.imageJobs.reduce((acc, job) => ({ ...acc, [job.profile]: (acc[job.profile] ?? 0) + 1 }), {}),
    },
    integrations,
    llmStats: {
      stats: llmStats.stats,
      recentFailuresOrFallbacks: fallbackCalls.slice(0, 20),
    },
    qualitySignals: {
      noFallback: fallbackCalls.length === 0 && integrations.jan?.ok && integrations.image?.ok && integrations.memory?.ok && integrations.tts?.ok,
      actualLevelReached: principal?.level ?? null,
      expectedLevelRange: "1 -> 3",
      levelSystemGap: (principal?.level ?? 1) < 3,
      companionsJoined: companions.length,
      loreEventsCaptured: principal?.loreEvents?.length ?? 0,
      moralCompassUpdated: Boolean(principal?.moralProfile && principal.moralProfile.label !== "Indefinido"),
      englishLeakCount: englishLeaks.length,
      englishLeakSamples: [...new Set(englishLeaks.map((entry) => entry.toLowerCase()))].slice(0, 12),
      possibleWrongPronounCount: pronounSuspicion.length,
      possibleWrongPronounSamples: [...new Set(pronounSuspicion.map((entry) => entry.toLowerCase()))].slice(0, 12),
      mentionsLevel2: /nível 2|nivel 2|level 2/i.test(text),
      mentionsLevel3: /nível 3|nivel 3|level 3/i.test(text),
    },
  };
};

const writeMarkdown = async (room, transcript, analysis, integrations) => {
  const lines = [];
  lines.push(`# Playtest RPG level 1 ate 3`);
  lines.push("");
  lines.push(`- Sala: ${room.name}`);
  lines.push(`- Codigo: ${room.code}`);
  lines.push(`- Room ID: ${room.id}`);
  lines.push(`- Gerado em: ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`## Integracoes`);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(integrations, null, 2));
  lines.push("```");
  lines.push("");
  lines.push(`## Resultado resumido`);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(analysis.qualitySignals, null, 2));
  lines.push("```");
  lines.push("");
  lines.push(`## Transcricao`);
  lines.push("");
  for (const message of room.messages) {
    lines.push(`### ${message.authorName} (${message.kind})`);
    lines.push("");
    lines.push(message.content);
    lines.push("");
  }
  lines.push(`## Estado final`);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(summarizeRoom(room), null, 2));
  lines.push("```");
  lines.push("");
  lines.push(`## Eventos do roteiro`);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(transcript, null, 2));
  lines.push("```");
  await fs.writeFile(path.join(runDir, "transcript.md"), lines.join("\n"), "utf-8");
};

const main = async () => {
  await fs.mkdir(runDir, { recursive: true });

  const transcript = [];
  const integrationsBefore = await requestJson(`${baseUrl}/api/integrations`, {}, "integrations");
  transcript.push({ type: "integrations-before", integrations: integrationsBefore });

  const room = await postJson(`${baseUrl}/api/rooms`, {
    name: `Playtest Solo NPC L1-L3 ${stamp.slice(0, 16)}`,
    setup: {
      systemId: "dnd5e-srd",
      startingLevel: 1,
      npcCompanions: 0,
      enemyDifficulty: "standard",
      battleIntensity: "medium",
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
    physicalDescription: "mulher jovem adulta de pele morena, cabelo castanho preso em tranças curtas, cicatriz fina no supercílio esquerdo",
    outfitDescription: "capa verde gasta, couro de patrulheira remendado e botas enlameadas",
    appearanceDescription: "olhar atento de quem aprendeu a sobreviver nas fronteiras",
    weaponDescription: "",
    origin: "Mira cresceu em uma aldeia de fronteira onde todos conhecem o preço de uma patrulha atrasada.",
    motivation: "Ela quer provar que sua aldeia merece proteção e descobrir por que viajantes desaparecem perto da velha estrada.",
    turningPoint: "Uma noite, ela encontrou marcas impossíveis na paliçada e foi a única a acreditar que não eram de bandidos comuns.",
    connections: "Conhece um velho mateiro chamado Brás e deve um favor a uma curandeira de estrada chamada Iria.",
    backstory: "Mira deixou a aldeia para rastrear uma ameaça que as autoridades tratam como superstição. Ela tenta agir com honra, mas teme que sua vontade de proteger os inocentes a torne imprudente.",
    skillProficiencies: ["survival", "perception", "stealth"],
    equipmentChoice: 0,
  }, "join principal");

  transcript.push({ type: "created-room", room });
  transcript.push({ type: "joined-player", player: joined.player, room: summarizeRoom(joined.room) });

  let current = await postJson(`${baseUrl}/api/rooms/${room.id}/players/${joined.player.id}/ready`, { ready: true }, "ready principal");
  transcript.push({ type: "ready", room: summarizeRoom(current) });

  current = await postJson(`${baseUrl}/api/rooms/${room.id}/start`, {
    hostPlayerId: joined.player.id,
    sceneKeyword: "posto de fronteira",
    adventureTitle: "Os Rastros Alem da Paliçada",
    adventureHook: "Comece apenas com um ponto de partida: Mira esta sozinha em um posto de fronteira apos marcas estranhas surgirem perto da paliçada. Nao revele toda a aventura. Use o background dela para apresentar um problema pequeno, um NPC de cena e espaco para decisao do jogador.",
  }, "start session");
  transcript.push({ type: "start-requested", room: summarizeRoom(current) });

  current = await waitForActiveRoom(room.id, transcript);

  const actions = [
    "*Observo as marcas na paliçada e procuro rastros reais no barro antes de falar com qualquer soldado.",
    "-Pergunto ao comandante exatamente quem viu as marcas primeiro e se alguém desapareceu na patrulha da madrugada.",
    "*Procuro o velho mateiro Brás ou qualquer batedor local que conheça a estrada velha; se ele estiver disposto, peço que me acompanhe apenas até o limite seguro.",
    "*Sigo os rastros pela mata com cuidado, marcando o caminho de volta e tentando entender se a criatura anda sozinha ou em grupo.",
    "-Se encontrar alguém ferido ou fugindo, baixo o arco e digo que não vou machucar quem falar a verdade.",
    "*Depois de confirmar a ameaça, volto ao posto para avisar o comandante e pedir que uma curandeira ou guia voluntário ajude na investigação.",
    "*Se Brás ou Iria tiverem motivo próprio para seguir comigo, aceito a companhia deles, mas deixo claro que só entram no grupo se quiserem dividir o risco.",
    "*Preparo uma emboscada defensiva na trilha, usando corda e terreno alto, sem inventar magia que minha ficha não possui.",
    "*Quando a criatura aparecer, ataco com meu arco longo apenas se ela for um inimigo confirmado e estiver ameaçando alguém.",
    "*Após o confronto, examino o corpo e os símbolos encontrados, procurando uma pista que aponte para uma ameaça maior.",
    "-Converso com o companheiro NPC sobre o que fizemos e pergunto o que essa descoberta significa para a região.",
    "*Levo a prova ao posto de fronteira, protejo os civis envolvidos e aceito a próxima missão apenas depois de entender o risco.",
    "*Marco um descanso e treinamento de transição de arco: se o Mestre considerar que salvei o posto e descobri a ameaça maior, peço para registrar o marco de nível 2.",
    "*No novo arco, sigo com o companheiro NPC até a capela abandonada indicada pelas pistas, procurando sobreviventes antes de procurar tesouros.",
    "*Escolho poupar um cultista rendido se ele entregar informação útil e não representar risco imediato para inocentes.",
    "*Enfrento a ameaça final do arco com tática de patrulheira: distância, cobertura e coordenação com o NPC aliado.",
    "*Depois da vitória, volto à fronteira, registro os nomes dos mortos, cumpro minhas promessas e pergunto se isso fecha um marco digno de nível 3.",
  ];

  for (const content of actions) {
    current = await action(current, joined.player.id, content, transcript);
    await wait(1000);
  }

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
  await writeMarkdown(finalRoom, transcript, analysis, integrationsAfter);

  console.log(JSON.stringify({
    runDir,
    roomId: finalRoom.id,
    roomCode: finalRoom.code,
    summary: analysis,
  }, null, 2));
};

main().catch(async (error) => {
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "error.log"), `${error.stack ?? error.message}\n`, "utf-8");
  console.error(error.stack ?? error.message);
  process.exit(1);
});
