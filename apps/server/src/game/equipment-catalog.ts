export type EquipmentInfo = {
  name: string;
  aliases: string[];
  category: "weapon" | "armor" | "shield" | "tool" | "adventuring_gear" | "consumable" | "focus" | "instrument" | "document";
  summary: string;
  details: string;
};

export const equipmentCatalog: Record<string, EquipmentInfo> = {
  Longsword: {
    name: "Longsword",
    aliases: ["longsword", "espada longa", "espada"],
    category: "weapon",
    summary: "Arma marcial, 1d8 cortante, versatil 1d10.",
    details: "Espada longa: arma marcial corpo a corpo. Dano 1d8 cortante em uma mao, ou 1d10 cortante se usada com duas maos. Peso aprox. 1,5 kg. Boa para duelos, golpes controlados, aparar e ameacar em corredores.",
  },
  Greataxe: {
    name: "Greataxe",
    aliases: ["greataxe", "machadao", "machado grande", "machado"],
    category: "weapon",
    summary: "Arma marcial pesada, duas maos, 1d12 cortante.",
    details: "Machadao: arma marcial corpo a corpo pesada e de duas maos. Dano 1d12 cortante. Peso aprox. 3,5 kg. Excelente para golpes fortes, quebrar madeira e ameacar alvos grandes, mas ruim em espacos apertados.",
  },
  "Two Handaxes": {
    name: "Two Handaxes",
    aliases: ["two handaxes", "duas machadinhas", "machadinha", "machadinhas"],
    category: "weapon",
    summary: "Duas armas leves, 1d6 cortante cada, arremesso curto.",
    details: "Duas machadinhas: cada uma causa 1d6 cortante. Sao leves e podem ser arremessadas a curta distancia. Uteis para combate com duas armas, cortar cordas/galhos e improvisar ferramentas.",
  },
  Handaxe: {
    name: "Handaxe",
    aliases: ["handaxe", "machadinha"],
    category: "weapon",
    summary: "Arma leve, 1d6 cortante, arremesso curto.",
    details: "Machadinha: arma simples corpo a corpo, leve e arremessavel. Dano 1d6 cortante. Tambem serve para cortar cordas, galhos, estacas e pequenos obstaculos de madeira.",
  },
  Rapier: {
    name: "Rapier",
    aliases: ["rapier", "rapieira", "florete"],
    category: "weapon",
    summary: "Arma marcial finesse, 1d8 perfurante.",
    details: "Rapieira: arma marcial de uma mao, finesse. Dano 1d8 perfurante. Pode usar Forca ou Agilidade/Destreza no ataque. Excelente para golpes precisos, duelos e ataques furtivos.",
  },
  Shortbow: {
    name: "Shortbow",
    aliases: ["shortbow", "arco curto"],
    category: "weapon",
    summary: "Arma a distancia, duas maos, 1d6 perfurante.",
    details: "Arco curto: arma simples a distancia. Dano 1d6 perfurante, usa Agilidade/Destreza. Exige duas maos e flechas. Bom para emboscadas e ataques seguros a distancia.",
  },
  Longbow: {
    name: "Longbow",
    aliases: ["longbow", "arco longo", "arco"],
    category: "weapon",
    summary: "Arma marcial a distancia, duas maos, 1d8 perfurante.",
    details: "Arco longo: arma marcial a distancia, pesada e de duas maos. Dano 1d8 perfurante. Alcance maior que o arco curto, mas exige espaco para puxar e flechas disponiveis.",
  },
  Shortsword: {
    name: "Shortsword",
    aliases: ["shortsword", "espada curta"],
    category: "weapon",
    summary: "Arma marcial leve/finesse, 1d6 perfurante.",
    details: "Espada curta: arma marcial de uma mao, leve e finesse. Dano 1d6 perfurante. Boa para combate agil, duas armas e ataques furtivos.",
  },
  Dagger: {
    name: "Dagger",
    aliases: ["dagger", "adaga", "punhal"],
    category: "weapon",
    summary: "Arma leve/finesse, 1d4 perfurante, arremesso.",
    details: "Adaga: arma simples leve e finesse. Dano 1d4 perfurante. Pode ser arremessada a curta distancia, escondida com facilidade e usada para cortar cordas, tecido ou selos.",
  },
  Quarterstaff: {
    name: "Quarterstaff",
    aliases: ["quarterstaff", "bordao", "cajado"],
    category: "weapon",
    summary: "Arma simples, 1d6 contundente, versatil 1d8.",
    details: "Bordao/cajado: arma simples. Dano 1d6 contundente em uma mao, 1d8 com duas maos. Tambem serve para sondar piso, apoiar escaladas curtas, empurrar objetos e canalizar foco narrativo.",
  },
  Mace: {
    name: "Mace",
    aliases: ["mace", "maca", "maça"],
    category: "weapon",
    summary: "Arma simples, 1d6 contundente.",
    details: "Maca: arma simples corpo a corpo de uma mao. Dano 1d6 contundente. Boa contra ossos, armaduras leves e objetos frageis.",
  },
  Warhammer: {
    name: "Warhammer",
    aliases: ["warhammer", "martelo de guerra"],
    category: "weapon",
    summary: "Arma marcial, 1d8 contundente, versatil 1d10.",
    details: "Martelo de guerra: arma marcial. Dano 1d8 contundente em uma mao, 1d10 com duas maos. Bom contra armaduras, esqueletos, dobradicas e objetos resistentes.",
  },
  Shield: {
    name: "Shield",
    aliases: ["shield", "escudo"],
    category: "shield",
    summary: "+2 AC enquanto empunhado.",
    details: "Escudo: ocupa uma mao e concede +2 de AC enquanto empunhado. Pode bloquear golpes, proteger aliados adjacentes, cobrir parcialmente contra flechas e empurrar em manobras simples.",
  },
  "Chain Mail": {
    name: "Chain Mail",
    aliases: ["chain mail", "cota de malha"],
    category: "armor",
    summary: "Armadura pesada, AC 16.",
    details: "Cota de malha: armadura pesada, AC base 16. Peso aprox. 25 kg. Protege muito bem, mas e barulhenta, limita furtividade e pode atrapalhar nado/escalada sem preparo.",
  },
  "Chain Shirt": {
    name: "Chain Shirt",
    aliases: ["chain shirt", "camisola de cota"],
    category: "armor",
    summary: "Armadura media, AC 13 + Agilidade max +2.",
    details: "Camisola de cota: armadura media, AC 13 + mod. de Agilidade/Destreza ate +2. Peso aprox. 9 kg. Mais discreta que cota completa e boa para mobilidade moderada.",
  },
  "Leather Armor": {
    name: "Leather Armor",
    aliases: ["leather armor", "armadura de couro", "couro"],
    category: "armor",
    summary: "Armadura leve, AC 11 + Agilidade.",
    details: "Armadura de couro: armadura leve, AC 11 + mod. de Agilidade/Destreza. Peso aprox. 5 kg. Boa para furtividade e movimento, mas oferece protecao limitada.",
  },
  "Studded Leather": {
    name: "Studded Leather",
    aliases: ["studded leather", "couro cravejado"],
    category: "armor",
    summary: "Armadura leve, AC 12 + Agilidade.",
    details: "Couro cravejado: armadura leve, AC 12 + mod. de Agilidade/Destreza. Peso aprox. 6,5 kg. Boa protecao para personagens ageis sem prejudicar muito a furtividade.",
  },
  "Scale Mail": {
    name: "Scale Mail",
    aliases: ["scale mail", "cota de escamas"],
    category: "armor",
    summary: "Armadura media, AC 14 + Agilidade max +2.",
    details: "Cota de escamas: armadura media, AC 14 + mod. de Agilidade/Destreza ate +2. Peso aprox. 20 kg. Boa defesa, mas tende a impor desvantagem em furtividade.",
  },
  "Plate Mail": {
    name: "Plate Mail",
    aliases: ["plate mail", "armadura de placas", "placas"],
    category: "armor",
    summary: "Armadura pesada, AC 18.",
    details: "Armadura de placas: armadura pesada, AC 18. Peso aprox. 30 kg. Excelente defesa, barulhenta, cara e pouco discreta. Pode atrapalhar quedas, agua profunda e passagens estreitas.",
  },
  Torch: {
    name: "Torch",
    aliases: ["torch", "tocha"],
    category: "consumable",
    summary: "Ilumina e pode acender fogo; uso consumivel.",
    details: "Tocha: ilumina uma area proxima por cerca de 1 hora. Pode acender materiais inflamaveis, sinalizar, afastar algumas criaturas ou causar dano improvisado de fogo se usada como arma.",
  },
  Torches: {
    name: "Torches",
    aliases: ["torches", "tochas"],
    category: "consumable",
    summary: "Conjunto de tochas; cada uma dura cerca de 1 hora.",
    details: "Tochas: conjunto de tochas. Cada tocha ilumina uma area proxima por cerca de 1 hora e pode ser consumida para acender fogo, marcar caminho ou improvisar uma fonte de calor/luz.",
  },
  Rations: {
    name: "Rations",
    aliases: ["rations", "racao", "rações", "comida"],
    category: "consumable",
    summary: "Comida de viagem; consumivel por dia.",
    details: "Racoes: comida seca de viagem. Normalmente sustenta uma pessoa por um dia por porcao. Serve para viagens, descansos, barganhas simples ou distrair animais famintos.",
  },
  Rope: {
    name: "Rope",
    aliases: ["rope", "corda"],
    category: "adventuring_gear",
    summary: "Corda resistente, 15 m, suporta cerca de 120 kg com seguranca.",
    details: "Corda: corda trancada de cerca de 15 metros, forte o suficiente para segurar aproximadamente 120 kg com seguranca em condicoes normais. Serve para escalada, amarrar prisioneiros, prender cargas, fazer armadilhas simples, descer poco ou atravessar fendas.",
  },
  Lockpicks: {
    name: "Lockpicks",
    aliases: ["lockpicks", "gazuas", "ferramentas de ladrao", "ferramentas de ladrão"],
    category: "tool",
    summary: "Ferramentas para fechaduras e armadilhas.",
    details: "Gazuas/ferramentas de ladrao: usadas para abrir fechaduras, desarmar armadilhas mecanicas e manipular mecanismos pequenos. Normalmente exigem teste de Agilidade/Destreza ou proficiencia apropriada.",
  },
  Caltrops: {
    name: "Caltrops",
    aliases: ["caltrops", "estrepes"],
    category: "consumable",
    summary: "Espinhos no chao para atrasar perseguidores.",
    details: "Estrepes: pequenos espinhos espalhados no chao. Cobrem uma area curta, atrasam perseguidores e podem ferir quem passa sem cuidado. Uso normalmente consumivel ou recuperavel parcialmente depois da cena.",
  },
  "Hunting Trap": {
    name: "Hunting Trap",
    aliases: ["hunting trap", "armadilha de caça", "armadilha"],
    category: "tool",
    summary: "Armadilha mecanica para prender criatura.",
    details: "Armadilha de caca: prende uma criatura que pisa nela, causando ferimento e impedindo movimento ate escapar. Exige tempo para armar e costuma ser visivel se colocada sem cobertura.",
  },
  Waterskin: {
    name: "Waterskin",
    aliases: ["waterskin", "cantil", "odre"],
    category: "adventuring_gear",
    summary: "Recipiente de agua para viagem.",
    details: "Cantil/odre: recipiente portatil de agua. Ajuda em viagens, descansos, sobrevivencia, apagar pequenos focos de fogo ou transportar liquidos simples.",
  },
  "Healer's Kit": {
    name: "Healer's Kit",
    aliases: ["healer's kit", "healers kit", "kit de curandeiro"],
    category: "consumable",
    summary: "10 usos para estabilizar feridos sem teste.",
    details: "Kit de curandeiro: conjunto de bandagens, talas e unguentos. Em D&D, tem 10 usos e pode estabilizar uma criatura com 0 HP sem teste. Tambem ajuda em primeiros socorros narrativos.",
  },
  "Holy Water": {
    name: "Holy Water",
    aliases: ["holy water", "agua benta", "água benta"],
    category: "consumable",
    summary: "Frasco sagrado, util contra mortos-vivos e demonios.",
    details: "Agua benta: frasco consumivel. Pode ser arremessado ou aplicado; costuma ferir mortos-vivos/infernais e purificar pequenos objetos ou simbolos profanos conforme decisao do Mestre.",
  },
  "Holy Symbol": {
    name: "Holy Symbol",
    aliases: ["holy symbol", "simbolo sagrado", "símbolo sagrado"],
    category: "focus",
    summary: "Foco divino para magias e rituais sagrados.",
    details: "Simbolo sagrado: foco usado por Clerigos e Paladinos para conjurar magias e canalizar poder divino. Tambem serve como prova de fe, protecao ritual e autoridade religiosa.",
  },
  "Arcane Focus": {
    name: "Arcane Focus",
    aliases: ["arcane focus", "foco arcano"],
    category: "focus",
    summary: "Foco para conjuracao arcana.",
    details: "Foco arcano: objeto usado por conjuradores arcanos para substituir componentes materiais comuns de magias. Nao concede magias sozinho; apenas ajuda quem ja sabe conjurar.",
  },
  "Focus Wand": {
    name: "Focus Wand",
    aliases: ["focus wand", "varinha de foco", "varinha"],
    category: "focus",
    summary: "Varinha usada como foco arcano.",
    details: "Varinha de foco: foco arcano em formato de varinha. Canaliza magias conhecidas pelo personagem, mas nao permite conjurar magias que ele nao possui.",
  },
  "Druidic Focus": {
    name: "Druidic Focus",
    aliases: ["druidic focus", "foco druidico", "foco druídico"],
    category: "focus",
    summary: "Foco natural para magia druidica.",
    details: "Foco druidico: ramo, totem, cajado ou simbolo natural usado para conjurar magias druidicas conhecidas/preparadas. Tambem pode ajudar em rituais ligados a natureza.",
  },
  "Component Pouch": {
    name: "Component Pouch",
    aliases: ["component pouch", "bolsa de componentes"],
    category: "focus",
    summary: "Componentes materiais comuns para magias.",
    details: "Bolsa de componentes: contem componentes materiais simples para conjuracao. Nao substitui componentes caros nem permite conjurar magias que o personagem nao conhece.",
  },
  Spellbook: {
    name: "Spellbook",
    aliases: ["spellbook", "grimorio", "grimório", "livro de magias"],
    category: "document",
    summary: "Livro onde magias de Mago ficam registradas.",
    details: "Grimorio: livro de magias do Mago. Registra magias aprendidas e permite prepara-las apos descanso. Se perdido, limita muito a flexibilidade do Mago.",
  },
  Ink: {
    name: "Ink",
    aliases: ["ink", "tinta"],
    category: "adventuring_gear",
    summary: "Tinta para escrita, mapas, marcas e copias.",
    details: "Tinta: usada para escrever, copiar runas, marcar mapas, falsificar ou registrar pistas. Pode acabar se usada em volume ou derramada.",
  },
  "Prayer Book": {
    name: "Prayer Book",
    aliases: ["prayer book", "livro de oracoes", "livro de orações"],
    category: "document",
    summary: "Livro devocional com preces e ritos.",
    details: "Livro de oracoes: contem preces, liturgias e referencias religiosas. Ajuda em rituais, identificacao de simbolos sagrados e interacoes com fieis.",
  },
  "Herbalism Kit": {
    name: "Herbalism Kit",
    aliases: ["herbalism kit", "kit de herbalismo", "kit de ervas"],
    category: "tool",
    summary: "Ferramentas para ervas, remedios e venenos simples.",
    details: "Kit de herbalismo: usado para identificar plantas, preparar remedios simples, antitoxinas ou pomadas. Normalmente exige tempo, ingredientes e teste apropriado.",
  },
  "Disguise Kit": {
    name: "Disguise Kit",
    aliases: ["disguise kit", "kit de disfarce"],
    category: "tool",
    summary: "Maquiagem e acessorios para disfarces.",
    details: "Kit de disfarce: permite alterar aparencia com maquiagem, perucas e pequenos acessorios. Bom para infiltracao, esconder identidade e criar personagens falsos.",
  },
  Lute: {
    name: "Lute",
    aliases: ["lute", "alaude", "alaúde"],
    category: "instrument",
    summary: "Instrumento musical; foco narrativo de Bardo.",
    details: "Alaude: instrumento musical. Serve para performance, distrair multidoes, ganhar moedas, sinalizar aliados e como foco artistico para habilidades de Bardo quando aplicavel.",
  },
  Lyre: {
    name: "Lyre",
    aliases: ["lyre", "lira"],
    category: "instrument",
    summary: "Instrumento musical portatil.",
    details: "Lira: instrumento musical pequeno. Serve para performance, rituais, diplomacia, distração e expressoes artisticas de personagem.",
  },
  "Book of Songs": {
    name: "Book of Songs",
    aliases: ["book of songs", "livro de cancoes", "livro de canções"],
    category: "document",
    summary: "Cancioneiro com letras, cifras e historias.",
    details: "Livro de cancoes: repertorio de musicas, poemas e historias. Ajuda em performances, pesquisa cultural e improvisacao social.",
  },
  "Quiver (20 arrows)": {
    name: "Quiver (20 arrows)",
    aliases: ["quiver", "aljava", "20 arrows", "flechas"],
    category: "consumable",
    summary: "Aljava com 20 flechas.",
    details: "Aljava com 20 flechas: municao para arco curto ou longo. Cada disparo normalmente consome uma flecha, embora algumas possam ser recuperadas apos a cena.",
  },
  Insignia: {
    name: "Insignia",
    aliases: ["insignia", "insígnia"],
    category: "adventuring_gear",
    summary: "Sinal de patente, unidade ou faccao.",
    details: "Insignia: marca militar, nobre ou de faccao. Pode provar afiliacao, abrir portas sociais, intimidar subordinados ou criar problemas com inimigos da organizacao.",
  },
  "Dice Set": {
    name: "Dice Set",
    aliases: ["dice set", "dados"],
    category: "tool",
    summary: "Conjunto de dados para jogos e apostas.",
    details: "Conjunto de dados: usado para jogos, apostas, distracao em tavernas e leitura social. Tambem pode servir para blefes, trapaças ou pequenos sinais combinados.",
  },
  Notebook: {
    name: "Notebook",
    aliases: ["notebook", "caderno"],
    category: "document",
    summary: "Caderno de anotacoes.",
    details: "Caderno: usado para anotar pistas, mapas, nomes, runas e descobertas. Ajuda a preservar informacao e pode servir como prova escrita.",
  },
  "Reference Scroll": {
    name: "Reference Scroll",
    aliases: ["reference scroll", "pergaminho de referencia", "pergaminho"],
    category: "document",
    summary: "Pergaminho academico ou tecnico.",
    details: "Pergaminho de referencia: contem notas tecnicas, mapas, lendas ou formulas. Ajuda em testes de conhecimento quando o conteudo for relevante.",
  },
  "Prayer Beads": {
    name: "Prayer Beads",
    aliases: ["prayer beads", "contas de oracao", "terco"],
    category: "focus",
    summary: "Contas devocionais para preces e meditacao.",
    details: "Contas de oracao: auxiliam meditacao, ritos, juramentos e interacoes religiosas. Podem servir como simbolo de fe ou pequeno foco narrativo.",
  },
  Incense: {
    name: "Incense",
    aliases: ["incense", "incenso"],
    category: "consumable",
    summary: "Incenso ritual consumivel.",
    details: "Incenso: usado em rituais, funerais, purificacao, mascarar odores ou criar ambiente cerimonial. Consumido ao queimar.",
  },
  Costume: {
    name: "Costume",
    aliases: ["costume", "fantasia", "traje"],
    category: "adventuring_gear",
    summary: "Roupa de atuacao ou disfarce simples.",
    details: "Fantasia/traje: roupa para performance, disfarce simples ou infiltracao social. Nao substitui armadura e pode chamar atencao em locais inadequados.",
  },
  "Musical Instrument": {
    name: "Musical Instrument",
    aliases: ["musical instrument", "instrumento musical"],
    category: "instrument",
    summary: "Instrumento para performance.",
    details: "Instrumento musical: usado para tocar, distrair, ganhar dinheiro, entreter NPCs, transmitir sinais ou sustentar cenas sociais.",
  },
  "Wooden Carving": {
    name: "Wooden Carving",
    aliases: ["wooden carving", "entalhe de madeira"],
    category: "adventuring_gear",
    summary: "Objeto pessoal ou devocional pequeno.",
    details: "Entalhe de madeira: objeto pessoal, lembranca, simbolo espiritual ou presente. Pode ter valor emocional, social ou ritual conforme a historia.",
  },
};

export const getEquipmentInfo = (itemName: string): EquipmentInfo | null => {
  const direct = equipmentCatalog[itemName];
  if (direct) return direct;
  const normalized = itemName.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  return Object.values(equipmentCatalog).find((item) =>
    item.name.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase() === normalized ||
    item.aliases.some((alias) => alias.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase() === normalized)
  ) ?? null;
};

export const equipmentAliases: Array<{ canonical: string; terms: string[] }> = Object.values(equipmentCatalog).map((item) => ({
  canonical: item.name,
  terms: [item.name, ...item.aliases],
}));

export const describeEquipment = (itemName: string): string => {
  const item = getEquipmentInfo(itemName);
  return item ? `${item.name}: ${item.summary} ${item.details}` : `${itemName}: item registrado na ficha, sem descricao mecanica detalhada.`;
};

export const formatInventoryForPrompt = (equipped: string[], backpack: string[]): string[] => [
  ...equipped.map((item) => `Equipado - ${describeEquipment(item)}`),
  ...backpack.map((item) => `Mochila - ${describeEquipment(item)}`),
];
