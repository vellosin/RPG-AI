import type { RoomState } from "./types.js";

export type CampaignBlueprint = {
  name: string;
  source: string;
  principles: string[];
  openingCadence: string[];
  escalationCadence: string[];
  reusableThreads: string[];
  playerArcPatterns: string[];
  avoid: string[];
};

export const longCampaignBlueprint: CampaignBlueprint = {
  name: "Modelo de campanha longa: pistas abertas, conspiracao lenta e arcos pessoais",
  source: "Derivado das aventuras antigas do usuario em AventurasRPG; usar como estrutura, nao como canon obrigatorio.",
  principles: [
    "Comece pequeno e humano: um contato, uma necessidade, uma viagem, uma taverna, uma prisao, um torneio ou uma cidade viva.",
    "A primeira sessao deve oferecer escolhas praticas, nao despejar a missao principal.",
    "Cada pista pode apontar para mais de uma possibilidade: boato falso, pista incompleta, testemunha, mapa, simbolo, desaparecimento ou objeto estranho.",
    "O vilao ou faccao maior deve aparecer primeiro por consequencias, marcas, rumores e pessoas afetadas, nao como explicacao direta.",
    "NPCs recorrentes devem mudar com as escolhas dos jogadores: aliados feridos, contatos desconfiados, rivais promovidos, vitimas salvas ou perdidas.",
    "A campanha ganha vida quando cada personagem tem um gancho pessoal que volta em sonhos, objetos, parentes, dividas, exilio, linhagem ou promessas antigas.",
    "Grandes revelacoes devem mudar o tipo de aventura: investigacao local, viagem perigosa, sobrevivencia, resistencia politica, cidade nova, ritual, guerra ou julgamento publico.",
  ],
  openingCadence: [
    "Declare onde os personagens estao e por que chegaram ali.",
    "Use no maximo um NPC presente e um detalhe estranho no primeiro paragrafo.",
    "Mostre 2 a 4 acoes naturais: conversar, observar, ajudar alguem, investigar um objeto, sair pela estrada, aceitar ou recusar um convite.",
    "Deixe inimigos como ameacas latentes na abertura, a menos que os jogadores escolham entrar em perigo.",
    "Se houver varios jogadores, conecte-os por uma situacao simples: mesa compartilhada, caravana, cela, torneio, guilda, audiencia, divida ou contato comum.",
    "Se houver um jogador, use sua motivacao e conexoes para explicar por que ele parou naquele lugar.",
  ],
  escalationCadence: [
    "Sessao inicial: problema local e 2 ou 3 pistas abertas.",
    "Depois: uma pista contradiz o primeiro boato e revela que alguem esta manipulando a situacao.",
    "Meio de arco: viagem ou infiltracao cobra custo, tempo, recursos e escolhas morais.",
    "Virada: perda, ritual, deslocamento, morte de NPC, cidade corrompida ou traicao muda o mapa da campanha.",
    "Arco seguinte: a consequencia do arco anterior vira reputacao, perseguicao, nova alianca ou resistencia politica.",
    "Final de arco: os jogadores podem vencer o problema imediato, mas uma pergunta maior permanece.",
  ],
  reusableThreads: [
    "Um amigo de infancia, parente, mentor ou devedor une o grupo sem obrigar uma missao pronta.",
    "Um desaparecimento revela pistas domesticas: diario, circulo incompleto, lingua antiga, mapa rasgado, cheiro, residuo ou simbolo.",
    "Um boato popular esta errado, mas protege uma verdade mais perigosa.",
    "Uma cidade calma pode esconder uma rede que consome instituicoes por dentro.",
    "Um objeto pessoal pode escolher ou rejeitar o personagem, cobrando postura, promessa ou sacrificio.",
    "Viagens devem ter textura: clima, fome, exaustao, montarias, rotas, patrulhas, preconceito, fronteiras e escolhas de risco.",
    "Enigmas, festivais, julgamentos, desafios publicos e duelos politicos quebram a rotina de combate.",
  ],
  playerArcPatterns: [
    "Linhagem perigosa: poder herdado, impulso sombrio, custo real para usar dons.",
    "Exilio ou rejeicao: personagem tenta provar valor a um povo, familia ou tribo que o recusou.",
    "Sonhos e treinamento oculto: mensagens noturnas revelam controle, medo ou memoria familiar.",
    "Artefato herdado: item antigo tem vontade, historia e criterio para liberar poder.",
    "Sangue nobre ou proibido: origem politica pode abrir portas, ameacas e responsabilidades.",
    "Divida com NPC salvo: uma escolha pequena vira reconhecimento, abrigo, informacao ou pedido futuro.",
  ],
  avoid: [
    "Nao comece com monstro, aliado, misterio sobrenatural e faccao secreta todos ao mesmo tempo.",
    "Nao trate possiveis inimigos como presentes fisicamente na cena sem decisao dos jogadores.",
    "Nao invente nomes caoticos ou incoerentes so para preencher lista.",
    "Nao transforme background em trilho obrigatorio; use como municao para convites, dilemas e consequencias.",
    "Nao explique a conspiracao cedo demais; deixe os jogadores descobrirem por acoes.",
  ],
};

export function buildLongCampaignBlueprintPrompt(room?: RoomState | null): string {
  const playerArcHints = room?.players.length
    ? room.players.map((player) => {
        const hooks = [
          player.origin ? `origem: ${player.origin}` : null,
          player.motivation ? `motivacao: ${player.motivation}` : null,
          player.turningPoint ? `virada: ${player.turningPoint}` : null,
          player.connections ? `conexoes: ${player.connections}` : null,
          player.backstory ? `historia: ${player.backstory}` : null,
        ].filter(Boolean).join("; ");
        return `${player.characterName}: ${hooks || "sem background detalhado; criar ganchos leves sem forcar passado."}`;
      })
    : [];

  return [
    `${longCampaignBlueprint.name}.`,
    longCampaignBlueprint.source,
    "",
    "PRINCIPIOS:",
    ...longCampaignBlueprint.principles.map((line) => `- ${line}`),
    "",
    "RITMO DE ABERTURA:",
    ...longCampaignBlueprint.openingCadence.map((line) => `- ${line}`),
    "",
    "ESCALADA DE CAMPANHA:",
    ...longCampaignBlueprint.escalationCadence.map((line) => `- ${line}`),
    "",
    "FIOS REAPROVEITAVEIS:",
    ...longCampaignBlueprint.reusableThreads.map((line) => `- ${line}`),
    "",
    "PADROES DE ARCO PESSOAL:",
    ...longCampaignBlueprint.playerArcPatterns.map((line) => `- ${line}`),
    ...(playerArcHints.length ? ["", "GANCHOS DOS PERSONAGENS DESTA MESA:", ...playerArcHints.map((line) => `- ${line}`)] : []),
    "",
    "EVITAR:",
    ...longCampaignBlueprint.avoid.map((line) => `- ${line}`),
  ].join("\n");
}
