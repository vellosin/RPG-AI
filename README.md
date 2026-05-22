# Local RPG AI

Aplicacao web de RPG cooperativo local-first com mestre controlado por LLM, combate em tempo real via Socket.IO, memoria persistente e integracoes opcionais de imagem e voz.

O backend em Fastify orquestra a campanha, a memoria e os turnos. O frontend em React cuida da sala, do log da historia e das acoes dos jogadores. Quando configurado, o projeto usa provedores locais para texto, retratos e narracao por voz.

## O que o projeto faz

- cria e gerencia salas cooperativas de RPG;
- transmite snapshots e eventos em tempo real com Socket.IO;
- roda combate por turnos com multiplos inimigos e trava por sala para evitar corrida;
- persiste campanha em SQLite e pode complementar memoria com Neo4j;
- gera narracao do mestre com streaming, observabilidade de chamadas LLM e regeneracao da ultima resposta;
- pode gerar retratos e cenas com provider local de imagem;
- pode narrar falas com Piper TTS em portugues.

## Arquitetura

- `apps/server`: API Fastify, Socket.IO, LangGraph, persistencia e integracoes.
- `apps/web`: cliente React/Vite.
- `apps/server/storage`: SQLite, imagens geradas, cache e artefatos locais.
- `scripts`: smoke tests, playtests e automacoes de ambiente.

O servidor pode servir o frontend compilado em `http://127.0.0.1:8787/app/` quando `apps/web/dist` existir. Durante desenvolvimento, tambem e possivel rodar backend e Vite separados.

## Modelos e providers locais usados

O repositorio nao inclui pesos de modelos, checkpoints, chaves ou tokens. Tudo deve ser configurado localmente via `apps/server/.env`.

| Area | Provider local principal | Modelo/configuracao padrao no repo |
| --- | --- | --- |
| LLM do mestre | JanAI em API OpenAI-compativel | `JAN_MODEL=Qwen3_5-9B-IQ4_XS` |
| Fallback de LLM | Ollama | configurado via `OLLAMA_BASE_URL` e `OLLAMA_MODEL` |
| Imagem | ComfyUI | `IMAGE_COMFY_CHECKPOINT=RealVisXL_V5.0_fp16.safetensors` |
| TTS | Piper | `pt_BR-faber-medium` para GM e `pt_BR-edresson-low` para voz grave |
| Memoria | SQLite local | `apps/server/storage/campaign.sqlite` |
| Memoria opcional | Neo4j | habilitado via `NEO4J_ENABLED=true` |

Ordem de providers no servidor:

- texto: JanAI -> Ollama -> fallback interno;
- memoria: SQLite local; com Neo4j habilitado, SQLite + grafo;
- imagem: ComfyUI / runtime local / API compativel -> fallback interno;
- voz: Piper local via processo filho, desabilitado por padrao.

## Requisitos

- Node.js 20+ e npm 10+.
- JanAI ou outro endpoint OpenAI-compativel local para a experiencia completa de texto.
- ComfyUI se voce quiser retratos e imagens locais.
- Piper se voce quiser narracao em voz.
- Neo4j apenas se quiser memoria em grafo.

## Configuracao segura para um repositorio publico

1. Copie `apps/server/.env.example` para `apps/server/.env`.
2. Preencha apenas valores locais da sua maquina.
3. Nao versione `apps/server/.env`, credenciais de Drive, logs, bancos SQLite nem arquivos `.onnx`.
4. Se usar Neo4j cloud, mantenha `NEO4J_PASSWORD` apenas no `.env` local.

O `.gitignore` foi ajustado para ignorar os arquivos sensiveis e artefatos locais mais obvios, mas ainda vale revisar `git status` antes de publicar.

## Instalacao

```bash
npm install
copy apps/server/.env.example apps/server/.env
```

Edite `apps/server/.env` e ajuste o que voce realmente for usar.

Configuracao minima sugerida:

```dotenv
PORT=8787
HOST=127.0.0.1
JAN_BASE_URL=http://127.0.0.1:1337/v1
JAN_MODEL=Qwen3_5-9B-IQ4_XS
TEXT_ONLY=true
```

Com `TEXT_ONLY=true`, o servidor pula jobs de imagem. Isso facilita a primeira subida do projeto antes de configurar ComfyUI e Piper.

## Como rodar

### Modo 1: desenvolvimento com backend e frontend separados

Em um terminal:

```bash
npm run dev:server
```

Em outro terminal:

```bash
npm run dev:web
```

Abra a URL mostrada pelo Vite, normalmente `http://127.0.0.1:5173`.

### Modo 2: servidor unico servindo o frontend compilado

Compile o frontend:

```bash
npm run build
```

Depois suba o backend:

```bash
npm run dev:server
```

Abra:

```text
http://127.0.0.1:8787/app/
```

### Smoke test

Com o backend no ar:

```bash
npm run smoke:server
```

## Como subir a stack completa local

### 1. LLM local via JanAI

- suba o JanAI ou outro servidor OpenAI-compativel local;
- carregue o modelo configurado em `JAN_MODEL`;
- confirme que `http://127.0.0.1:1337/v1/models` responde.

### 2. Imagem local via ComfyUI

- suba o ComfyUI e confirme `http://127.0.0.1:8188/system_stats`;
- se quiser usar checkpoint especifico, configure `IMAGE_COMFY_CHECKPOINT` no `.env`.

### 3. Voz local via Piper

Instale o Piper e baixe as vozes desejadas. Exemplo:

```bash
py -m pip install --user piper-tts
py -m piper.download_voices pt_BR-faber-medium
py -m piper.download_voices pt_BR-edresson-low
```

Depois configure no `.env`:

```dotenv
TTS_ENABLED=true
TTS_PIPER_BINARY=piper
TTS_VOICE_GM=./pt_BR-faber-medium.onnx
TTS_VOICE_NPC_GRUFF=./pt_BR-edresson-low.onnx
```

### 4. Memoria em grafo com Neo4j

Opcional. Ative apenas se realmente quiser o provider em grafo:

```dotenv
NEO4J_ENABLED=true
NEO4J_URI=bolt://127.0.0.1:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your_password
NEO4J_DATABASE=neo4j
```

### 5. Verifique integracoes

Com o backend no ar, confira:

```bash
curl http://127.0.0.1:8787/api/integrations
```

Ou, no PowerShell:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/api/integrations | Select-Object -ExpandProperty Content
```

## Scripts utilitarios

- `npm run stack:check`: verifica a stack local no Windows.
- `npm run stack:start`: tenta subir a stack local no Windows.
- `npm run tts:pronunciation`: laboratorio de pronuncia para Piper.
- `npm run playtest:rpg`: playtest automatizado.

Os scripts PowerShell foram ajustados para usar caminhos relativos do repositorio e `COMFY_ROOT` opcional. Ainda assim, eles assumem um ambiente Windows e podem exigir adaptacao em outra maquina.

## Fluxo recomendado para publicar no GitHub

1. Inicialize o git no diretorio do projeto, se ainda nao existir repositorio.
2. Revise `apps/server/.env.example` e mantenha apenas placeholders publicos.
3. Confirme que `apps/server/.env`, credenciais, logs, bancos e modelos locais nao entraram no indice.
4. Rode `npm run build` para validar o monorepo antes do primeiro push.
5. So entao publique em um repositorio publico.

## Notas

- `OPERACAO_RPG.md` e um documento local da maquina de desenvolvimento e nao deve ser publicado no repositório publico.
- O projeto foi pensado para operacao local-first. Em ambiente publico, priorize `.env` local e providers locais, nao chaves embutidas no codigo.
