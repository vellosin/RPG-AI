const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:8787";

const expectOk = async (response, label) => {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${label} failed with HTTP ${response.status}: ${body}`);
  }
  return response.json();
};

const main = async () => {
  const status = await expectOk(await fetch(`${baseUrl}/api/status`), "status");

  const room = await expectOk(
    await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Smoke Test Campaign" }),
    }),
    "create room",
  );

  const join = await expectOk(
    await fetch(`${baseUrl}/api/rooms/${room.id}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Tester",
        characterName: "Seren",
        physicalDescription: "Guerreira humana de porte firme, rosto marcado por estrada e cabelo preso para combate.",
        weaponDescription: "espada longa de campanha e escudo gasto",
        outfitDescription: "armadura pesada de estrada, capa gasta e botas reforçadas",
        appearanceDescription: "expressão determinada e postura de veterana",
        className: "Fighter",
        species: "Human",
        background: "Soldier",
      }),
    }),
    "join room",
  );

  const secondJoin = await expectOk(
    await fetch(`${baseUrl}/api/rooms/${room.id}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Tester2",
        characterName: "Lyra",
        physicalDescription: "Clériga élfica de traços nobres, cabelos claros e olhar sereno.",
        weaponDescription: "bastão cerimonial e símbolo sagrado protegido no peito",
        outfitDescription: "vestes sagradas ornamentadas com camadas de tecido ritual",
        appearanceDescription: "aura calma e presença luminosa",
        className: "Cleric",
        species: "Elf",
        background: "Acolyte",
      }),
    }),
    "join room second player",
  );

  await expectOk(
    await fetch(`${baseUrl}/api/rooms/${room.id}/players/${join.player.id}/ready`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ready: true }),
    }),
    "ready first player",
  );

  await expectOk(
    await fetch(`${baseUrl}/api/rooms/${room.id}/players/${secondJoin.player.id}/ready`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ready: true }),
    }),
    "ready second player",
  );

  const started = await expectOk(
    await fetch(`${baseUrl}/api/rooms/${room.id}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostPlayerId: join.player.id }),
    }),
    "start session",
  );

  const firstAction = await expectOk(
    await fetch(`${baseUrl}/api/rooms/${room.id}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: join.player.id,
        content: "*Ataco o guardião com minha espada.",
      }),
    }),
    "send action",
  );

  const secondAction = await expectOk(
    await fetch(`${baseUrl}/api/rooms/${room.id}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: secondJoin.player.id,
        content: "*Acompanho Seren e pressiono o inimigo pelo flanco.",
      }),
    }),
    "send second player action",
  );

  const rolled = await expectOk(
    await fetch(`${baseUrl}/api/rooms/${room.id}/rolls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: join.player.id,
        count: 2,
        sides: 20,
        modifier: 3,
        results: [17, 9],
      }),
    }),
    "shared dice roll",
  );

  const integrations = await expectOk(await fetch(`${baseUrl}/api/integrations`), "integrations");

  const summary = {
    initialRooms: status.rooms,
    roomId: room.id,
    roomCode: room.code,
    sessionStatus: started.status,
    finalMessages: rolled.messages.length,
    finalPlayers: rolled.players.length,
    playerNames: rolled.players.map((player) => player.characterName),
    imageJobs: rolled.imageJobs.length,
    combatActive: rolled.combat.active,
    combatRound: rolled.combat.round,
    currentTurn: rolled.combat.order[rolled.combat.currentTurnIndex]?.actorName ?? null,
    enemy: rolled.combat.enemy?.name ?? null,
    enemyHp: rolled.combat.enemy?.hitPoints ?? null,
    memoryEntries: rolled.memory.entries.length,
    memorySummary: rolled.memory.summary,
    rollMessage: rolled.messages.at(-1)?.content ?? null,
    janMode: integrations.jan.mode,
    imageMode: integrations.image.mode,
  };

  console.log(JSON.stringify(summary, null, 2));
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});