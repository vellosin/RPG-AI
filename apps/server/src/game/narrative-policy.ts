import type { ActionPlan, NarrativePolicy } from "./action-orchestrator.js";
import type { CampaignMemoryEntry, Player, RoomState } from "./types.js";

const activeNpcNames = (room: RoomState): string[] =>
  (room.scene.activeNpcs ?? [])
    .filter((npc) => npc.status !== "dead" && npc.status !== "unconscious")
    .map((npc) => npc.name);

const memoryAnchors = (memories: CampaignMemoryEntry[]): string[] =>
  memories
    .filter((memory) => memory.importance >= 3)
    .slice(0, 4)
    .map((memory) => `${memory.kind}: ${memory.title}`);

export const buildNarrativePolicy = (
  room: RoomState,
  player: Player,
  actionPlan: ActionPlan,
  memories: CampaignMemoryEntry[],
): NarrativePolicy => {
  const npcs = activeNpcNames(room);
  const anchors = memoryAnchors(memories);
  const solo = room.players.length === 1 && npcs.length === 0;

  const baseForbidden = [
    "Não assuma decisões, pensamentos ou emoções internas do personagem jogador.",
    "Não pule para uma luta, emboscada ou perseguição sem causa já estabelecida.",
    "Não contradiga o local atual, NPCs ativos, HP, inventário ou memórias canônicas.",
    "Não encerre a cena oferecendo uma lista de opções; deixe uma situação aberta.",
  ];

  const baseBeats = [
    `Use ${player.characterName} como sujeito principal da resposta.`,
    `Ancore a resposta em ${room.scene.title}.`,
    solo ? "Trate a cena como solo; não diga grupo, companheiros ou aventureiros." : "Reconheça quem está presente sem inventar novos companheiros.",
  ];

  if (anchors.length > 0) {
    baseBeats.push(`Use como cânone quando relevante: ${anchors.join(" | ")}.`);
  }

  if (room.scene.storyArc) {
    const arc = room.scene.storyArc;
    baseBeats.push(`Arco atual: ${arc.title} (${arc.phase}); premissa: ${arc.premise}.`);
    if (arc.knownClues.length > 0) baseBeats.push(`Pistas conhecidas: ${arc.knownClues.slice(-3).join(" | ")}.`);
    if (arc.openQuestions.length > 0) baseBeats.push(`Perguntas abertas: ${arc.openQuestions.slice(-2).join(" | ")}.`);
    if (arc.restRecommendation) baseBeats.push(`Ritmo de aventura: ${arc.restRecommendation}`);
  }

  switch (actionPlan.intent) {
    case "ruling":
      return {
        mode: "ooc",
        responseFocus: "Resolver conflito de mesa, dúvida de regra ou contestação como autoridade final do Mestre.",
        requiredBeats: [
          "Reconheça o argumento do jogador em uma frase curta.",
          "Compare com o sistema, o estado canônico da cena e a coerência narrativa.",
          "Dê uma decisão clara e definitiva.",
          "Explique como a mesa continua a partir da decisão, sem abrir votação.",
        ],
        forbiddenMoves: [
          "Não ceder autoridade ao jogador.",
          "Não transformar decisão de regra em negociação infinita.",
          "Não alterar estado canônico só porque o jogador insistiu.",
          "Não narrar evento novo além do ajuste necessário para aplicar a decisão.",
        ],
        rollGuidance: "O Mestre pode pedir uma rolagem se essa for a decisão final; caso contrário, declare que não há rolagem.",
        npcGuidance: "NPCs não decidem regras de mesa; quem decide é o Mestre.",
        continuityGuidance: "A palavra do Mestre é definitiva: preserve sistema, estado canônico e ritmo da mesa.",
      };
    case "question":
      return {
        mode: "ooc",
        responseFocus: "Responder diretamente ao jogador fora do personagem, sem avançar tempo ficcional.",
        requiredBeats: ["Seja claro, curto e útil.", "Mantenha sceneSummary igual ao resumo atual."],
        forbiddenMoves: ["Não narrar eventos novos.", "Não pedir rolagem.", "Não gerar ações de NPC."],
        rollGuidance: "Nunca peça rolagem para pergunta OOC.",
        npcGuidance: "NPCs não agem em resposta OOC.",
        continuityGuidance: "Preserve integralmente o estado atual.",
      };
    case "social":
      return {
        mode: "dialogue",
        responseFocus: "Resolver uma interação social como conversa, reação emocional ou troca de informação.",
        requiredBeats: [
          ...baseBeats,
          npcs.length > 0 ? `Se fizer sentido, responda por um NPC ativo: ${npcs.join(", ")}.` : "Se não houver NPC presente, responda pelo ambiente ou pela ausência de resposta.",
          "Mostre subtexto por gestos, tom, silêncio ou mudança de atitude.",
        ],
        forbiddenMoves: [...baseForbidden, "Não iniciar combate por causa de uma fala comum.", "Não pedir Persuasão para aliado ou conversa simples."],
        rollGuidance: "Só peça rolagem social contra NPC hostil, cético ou quando houver consequência clara.",
        npcGuidance: "NPCs ativos podem falar ou reagir; caídos ou mortos nunca agem.",
        continuityGuidance: "Atualize relação/tensão, não o mundo inteiro.",
      };
    case "exploration":
      return {
        mode: "exploration",
        responseFocus: "Transformar investigação em pista, detalhe sensorial, descoberta parcial ou nova pergunta da cena.",
        requiredBeats: [
          ...baseBeats,
          "Entregue pelo menos um detalhe observável concreto.",
          "Se o jogador observar intenção, padrão ou ligação com o arco, mostre comportamento concreto; adicione pista parcial apenas quando isso ajudar o ritmo ou fizer sentido na cena.",
          "Separe comportamento da criatura/NPC e pistas percebidas pelo jogador com sujeitos claros.",
          "Se houver risco oculto, sinalize antes de punir.",
        ],
        forbiddenMoves: [...baseForbidden, "Não transformar observação em ataque inimigo imediato.", "Não esconder tudo atrás de rolagem."],
        rollGuidance: "Peça rolagem apenas para pistas ocultas, pressão de tempo, perigo ou consequência real.",
        npcGuidance: "NPCs podem comentar pistas, mas não devem resolver o mistério pelo jogador.",
        continuityGuidance: "Conecte descobertas às memórias relevantes sem contradizê-las.",
      };
    case "movement":
      return {
        mode: "travel",
        responseFocus: "Resolver deslocamento, aproximação, entrada/saída ou posicionamento com clareza espacial.",
        requiredBeats: [
          ...baseBeats,
          "Diga onde o personagem termina posicionado.",
          "Mostre o que muda na percepção da cena.",
          "Se o deslocamento for seguir ou vigiar alguém, revele um comportamento observável; conecte ao arco atual quando houver oportunidade natural.",
          "Evite pronomes ambíguos quando houver criatura, jogador e companheiro na mesma cena.",
        ],
        forbiddenMoves: [...baseForbidden, "Não spawnar inimigo só porque o personagem se moveu."],
        rollGuidance: "Peça rolagem apenas para escalada difícil, furtividade real, terreno perigoso ou fuga sob pressão.",
        npcGuidance: "NPCs presentes acompanham, reagem ou ficam para trás conforme o estado deles.",
        continuityGuidance: "Mantenha o mapa mental da cena simples e consistente.",
      };
    case "cast_spell":
      return {
        mode: "rules_check",
        responseFocus: "Checar magia/habilidade e resolver efeito narrativo sem exagerar o poder.",
        requiredBeats: [...baseBeats, "Confirme o efeito visível da magia.", "Aplique custo, limite ou incerteza se a cena exigir."],
        forbiddenMoves: [...baseForbidden, "Não tratar toda magia como ataque.", "Não conceder efeito absoluto sem regra ou custo."],
        rollGuidance: "Peça rolagem se a magia for feita sob pressão ou com efeito incerto fora de combate.",
        npcGuidance: "NPCs podem reagir ao efeito mágico de forma plausível.",
        continuityGuidance: "Respeite classe, spells e estado atual do personagem.",
      };
    case "attack":
      return {
        mode: "combat",
        responseFocus: room.combat.active ? "Resolver ação dentro do combate ativo." : "Confirmar agressão clara e consequência imediata.",
        requiredBeats: [...baseBeats, "Use consequência mecânica apenas quando o sistema de combate estiver ativo."],
        forbiddenMoves: ["Não inventar vantagem automática.", "Não matar personagem ou NPC importante sem resolução mecânica clara."],
        rollGuidance: "Em combate ativo, o engine resolve; fora dele, a agressão pode iniciar combate.",
        npcGuidance: "NPCs ativos podem reagir; caídos ou mortos não agem.",
        continuityGuidance: "Use HP, turno, inimigo e ordem de iniciativa como fonte da verdade.",
      };
    case "inventory":
      return {
        mode: "inventory",
        responseFocus: "Resolver uso, procura ou troca de item com base no inventário real.",
        requiredBeats: [...baseBeats, "Verifique se o item existe no equipped ou backpack.", "Se não existir, narre a ausência sem humilhar o jogador."],
        forbiddenMoves: [...baseForbidden, "Não conceder item inexistente.", "Não transformar item comum em arma decisiva sem setup."],
        rollGuidance: "Normalmente não peça rolagem para pegar ou guardar item.",
        npcGuidance: "NPCs podem notar, oferecer ajuda ou questionar se presentes.",
        continuityGuidance: "Inventário é canônico.",
      };
    case "rest":
      return {
        mode: "downtime",
        responseFocus: "Resolver pausa, descanso, recuperação ou reorganização com ritmo calmo.",
        requiredBeats: [...baseBeats, "Mostre passagem de tempo ou condição para descansar.", "Indique se há segurança suficiente."],
        forbiddenMoves: [...baseForbidden, "Não interromper descanso com ataque automático."],
        rollGuidance: "Só peça rolagem se houver perigo já estabelecido ou vigília incerta.",
        npcGuidance: "NPCs podem descansar, vigiar ou conversar se ativos.",
        continuityGuidance: "Não recupere recursos sem regra clara.",
      };
    default:
      return {
        mode: "exploration",
        responseFocus: "Resolver ação ambígua de forma conservadora e pedir esclarecimento ficcional se necessário.",
        requiredBeats: [...baseBeats, "Interprete a intenção mais plausível.", "Avance pouco, mas com detalhe útil."],
        forbiddenMoves: baseForbidden,
        rollGuidance: "Se a intenção estiver ambígua, prefira narrar percepção ou pedir clareza dentro da cena.",
        npcGuidance: "NPCs só reagem se diretamente envolvidos.",
        continuityGuidance: "Mantenha mudanças pequenas até a intenção ficar clara.",
      };
  }
};
