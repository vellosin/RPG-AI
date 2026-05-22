# Plano do RPG IA

Este arquivo guarda as ideias que nao podem se perder entre iteracoes.

## Orquestra e LangGraph

- Criar uma camada de `RpgSkillRegistry` chamada pelos nos do LangGraph.
- As skills internas devem consultar modulos deterministas, nao depender apenas do prompt do Mestre.
- Primeiras skills planejadas:
  - `consult_character_sheet`: ficha, recursos, magias, itens e limites do personagem.
  - `validate_player_action`: valida se a acao existe, se precisa rolagem e se fere a ficha.
  - `query_scene_canon`: consulta cena, NPCs presentes, inimigos confirmados e fatos canonicos.
  - `select_monster_statblock`: escolhe monstro por CR, XP, bioma, papel tatico e nivel do grupo.
  - `resolve_xp_and_levelup`: aplica XP, pendencias de nivel e mudancas na ficha.
  - `retrieve_player_lore`: busca feitos importantes, conexoes, reputacao e bussola moral.
  - `update_lore_moral_compass`: registra feitos dignos de memoria e ajusta tendencia moral.
  - `request_image_generation`: pede imagem por fluxo correto do Comfy, separado por retrato/cena/NPC/inimigo.
  - `request_tts`: gera narracao com texto preprocessado para Piper.

## Monstros

- Expandir o compendio com base SRD/Creative Commons e descricoes proprias.
- Usar materiais homebrew, como Conflux, apenas como inspiracao/curadoria salvo permissao/licenca explicita.
- Cada monstro precisa ter: familia, tipo, CR, XP, CA, HP, biomas, papel tatico, ataques, tracos e variantes.
- Variantes devem preservar identidade da familia e ajustar CR/XP/HP sem descaracterizar a criatura.
- A selecao de encontro deve respeitar nivel do grupo, dificuldade, intensidade e contexto da cena.

## Avaliacao de Modelos

- Usar Hugging Face/benchmarks locais para comparar modelos em:
  - portugues natural;
  - fidelidade a regras e ficha;
  - consistencia de estado canonico;
  - qualidade narrativa do Mestre;
  - geracao de prompts para imagem;
  - latencia, timeout e taxa de fallback.
- Manter uma suite local de cenas e acoes para comparar evolucao entre modelos/prompts.

## Playtests

- Manter logs versionados por pasta em `playtest-logs/`.
- Rodar testes de:
  - narrativa livre;
  - combate e XP level 1 ao 3;
  - ficha e level-up;
  - imagens por fluxo;
  - TTS com portugues.
