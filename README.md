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

Para a experiencia principal deste projeto, considere este conjunto como o caminho suportado:

- texto do mestre: JanAI com `JAN_MODEL=Qwen3_5-9B-IQ4_XS` ou outro modelo compativel exposto via API OpenAI-like;
- imagem: ComfyUI em `IMAGE_COMFY_URL`, com `IMAGE_PROVIDER=comfy`;
- voz: Piper local com as vozes `pt_BR-faber-medium` e `pt_BR-edresson-low`;
- memoria: SQLite local + Neo4j habilitado com `NEO4J_ENABLED=true`.

O servidor tem modos de fallback para degradar com seguranca, mas o README abaixo prioriza a stack principal completa.

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

No fluxo principal de imagem com ComfyUI, o backend monta o workflow via API e envia para `/prompt`. Nao e necessario importar workflow JSON manualmente no ComfyUI nem instalar custom nodes do projeto. O fluxo usa apenas os nodes padrao `CheckpointLoaderSimple`, `CLIPTextEncode`, `EmptyLatentImage`, `KSampler`, `VAEDecode` e `SaveImage`.

## Requisitos

- Windows 10/11.
- Node.js 20+ e npm 10+.
- Git.
- JanAI para o fluxo principal de texto.
- ComfyUI para o fluxo principal de retratos e imagens.
- Piper para a narracao em voz.
- Neo4j para a memoria em grafo.

## Instalacao do zero

Esta secao assume que a pessoa vai montar a stack principal completa a partir do repositorio publico.

### 1. Baixe e instale o que e externo ao repositorio

Voce precisa ter estes componentes instalados fora do repo:

1. Node.js 20+.
2. Git.
3. JanAI Desktop, ou outro servidor local compativel com API OpenAI-like.
4. ComfyUI.
5. Neo4j Desktop, Neo4j Server local ou uma instancia remota acessivel.
6. Piper TTS.
7. As duas vozes Piper usadas pelo projeto:
	- `pt_BR-faber-medium.onnx`
	- `pt_BR-edresson-low.onnx`
8. Um checkpoint SDXL disponivel no ComfyUI. O padrao documentado no projeto e `RealVisXL_V5.0_fp16.safetensors`.

O repositorio nao traz nenhum desses pesos, binarios ou bancos prontos. Ele traz apenas o codigo que conversa com eles.

### 2. Clone o repositorio e instale dependencias Node

```bash
git clone https://github.com/vellosin/RPG-AI.git
cd RPG-AI
npm install
copy apps/server/.env.example apps/server/.env
```

### 3. Configure o JanAI

Fluxo esperado pelo projeto:

1. Instale e abra o JanAI.
2. Baixe dentro do JanAI um modelo compativel com o nome que voce pretende usar no `.env`.
3. O padrao documentado no repo e `Qwen3_5-9B-IQ4_XS`.
4. Ligue o servidor local OpenAI-compatible do JanAI.
5. Confirme que este endpoint responde:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:1337/v1/models | Select-Object -ExpandProperty Content
```

Se voce usar outro modelo ou outra porta, ajuste `JAN_MODEL` e `JAN_BASE_URL` no `.env`.

### 4. Configure o ComfyUI para o fluxo principal de imagem

O projeto usa ComfyUI como provider principal de imagem. O backend monta e envia o workflow por API. Voce nao precisa importar workflow manual deste projeto.

Passos:

1. Instale o ComfyUI.
2. Coloque pelo menos um checkpoint SDXL na pasta de checkpoints do ComfyUI.
3. Se quiser seguir exatamente o padrao documentado, use `RealVisXL_V5.0_fp16.safetensors`.
4. Inicie o ComfyUI.
5. Confirme que ele responde:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8188/system_stats | Select-Object -ExpandProperty StatusCode
```

6. Confirme que o node de checkpoint esta exposto:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8188/object_info/CheckpointLoaderSimple | Select-Object -ExpandProperty StatusCode
```

Para este repositorio, o ComfyUI precisa responder corretamente a:

- `GET /system_stats`
- `GET /object_info/CheckpointLoaderSimple`
- `POST /prompt`
- `GET /history/:promptId`
- `GET /view`

O fluxo principal documentado aqui considera apenas ComfyUI. O fallback antigo de imagem nao precisa ser configurado.

### 5. Configure o Piper

Instale o Piper em um ambiente acessivel pelo terminal. Exemplo no Windows:

```bash
py -m pip install --user piper-tts
```

Baixe as vozes usadas pelo projeto:

```bash
py -m piper.download_voices pt_BR-faber-medium
py -m piper.download_voices pt_BR-edresson-low
```

Depois descubra onde os arquivos `.onnx` ficaram e aponte esses caminhos no `.env`.

Se o comando `piper` nao estiver no `PATH`, use caminho absoluto em `TTS_PIPER_BINARY`.

### 6. Configure o Neo4j

Fluxo esperado:

1. Suba uma instancia Neo4j local ou remota.
2. Tenha em maos URI, usuario, senha e database.
3. Preencha esses valores no `.env`.

O backend cria automaticamente constraints, indice por tipo e tenta criar o indice vetorial quando a versao do Neo4j suporta isso.

## Checklist da stack principal

Antes de tentar jogar com a experiencia completa, confirme estes quatro blocos:

1. JanAI online em `http://127.0.0.1:1337/v1` com um modelo carregado.
2. ComfyUI online em `http://127.0.0.1:8188` com um checkpoint SDXL disponivel. O padrao documentado no repo e `RealVisXL_V5.0_fp16.safetensors`.
3. Piper instalado e acessivel por `piper` ou por caminho absoluto, com as vozes `.onnx` configuradas no `.env`.
4. Neo4j acessivel com usuario, senha e database validos.

Se qualquer um desses blocos faltar, o servidor ainda pode iniciar, mas voce nao estara validando a stack principal do projeto.

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

Configuracao recomendada para a stack principal:

```dotenv
PORT=8787
HOST=127.0.0.1
JAN_BASE_URL=http://127.0.0.1:1337/v1
JAN_MODEL=Qwen3_5-9B-IQ4_XS
IMAGE_PROVIDER=comfy
IMAGE_COMFY_URL=http://127.0.0.1:8188
IMAGE_COMFY_CHECKPOINT=RealVisXL_V5.0_fp16.safetensors
NEO4J_ENABLED=true
NEO4J_URI=bolt://127.0.0.1:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your_password
NEO4J_DATABASE=neo4j
TTS_ENABLED=true
TTS_PIPER_BINARY=piper
TTS_VOICE_GM=./pt_BR-faber-medium.onnx
TTS_VOICE_NPC_GRUFF=./pt_BR-edresson-low.onnx
```

Exemplo mais realista com caminhos absolutos no Windows:

```dotenv
PORT=8787
HOST=127.0.0.1
JAN_BASE_URL=http://127.0.0.1:1337/v1
JAN_MODEL=Qwen3_5-9B-IQ4_XS
IMAGE_PROVIDER=comfy
IMAGE_COMFY_URL=http://127.0.0.1:8188
IMAGE_COMFY_CHECKPOINT=RealVisXL_V5.0_fp16.safetensors
NEO4J_ENABLED=true
NEO4J_URI=bolt://127.0.0.1:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=sua_senha
NEO4J_DATABASE=neo4j
TTS_ENABLED=true
TTS_PIPER_BINARY=piper
TTS_VOICE_GM=C:/caminho/para/pt_BR-faber-medium.onnx
TTS_VOICE_NPC_GRUFF=C:/caminho/para/pt_BR-edresson-low.onnx
```

Se voce quiser apenas testar a subida basica do servidor antes da stack completa, pode habilitar um modo reduzido com `TEXT_ONLY=true` e deixar Neo4j/TTS desativados. Isso e util para desenvolvimento, mas nao representa o fluxo principal documentado aqui.

## Ordem recomendada de inicializacao

Para evitar erro de integracao na primeira execucao, suba nesta ordem:

1. JanAI.
2. ComfyUI.
3. Neo4j.
4. Backend do RPG com `npm run dev:server`.
5. Frontend com `npm run dev:web`, ou use `/app/` depois de `npm run build`.

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

Se `/v1/models` responder, mas o nome do modelo nao bater com `JAN_MODEL`, ajuste o `.env`.

### 2. Imagem local via ComfyUI

- suba o ComfyUI e confirme `http://127.0.0.1:8188/system_stats`;
- configure `IMAGE_PROVIDER=comfy` no `.env` para forcar o fluxo principal;
- configure `IMAGE_COMFY_CHECKPOINT` no `.env` se quiser prender o projeto a um checkpoint especifico;
- se `IMAGE_COMFY_CHECKPOINT` ficar vazio, o backend tenta usar o primeiro checkpoint retornado por `CheckpointLoaderSimple`.

Para este projeto, o backend envia workflows txt2img gerados em codigo para perfis de `portrait`, `scene`, `npc`, `creature` e `item`. O ComfyUI precisa responder a:

- `GET /system_stats`
- `GET /object_info/CheckpointLoaderSimple`
- `POST /prompt`
- `GET /history/:promptId`
- `GET /view`

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

Observacoes importantes sobre Piper:

- o projeto nao sobe um servidor HTTP do Piper; ele executa `piper` como processo one-shot por frase;
- `TTS_VOICE_GM` e obrigatorio para o TTS ficar verde em `/api/integrations`;
- as vozes extras de NPC sao opcionais, mas a voz do GM precisa existir no disco.
- se `TTS_ENABLED=true` e `TTS_VOICE_GM` apontar para um arquivo inexistente, o backend sobe, mas o TTS fica em falha.

### 4. Memoria em grafo com Neo4j

No fluxo principal desta stack, Neo4j deve estar habilitado:

```dotenv
NEO4J_ENABLED=true
NEO4J_URI=bolt://127.0.0.1:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your_password
NEO4J_DATABASE=neo4j
```

O backend cria automaticamente:

- constraints para `RpgRoom`, `CampaignMemory` e `MemoryTag`;
- indice por `kind`;
- indice vetorial em `CampaignMemory.embedding` quando a versao do Neo4j suportar isso.

Mesmo com Neo4j ativo, o projeto continua usando SQLite local para persistencia de campanha.

### 5. Verifique integracoes

Com o backend no ar, confira:

```bash
curl http://127.0.0.1:8787/api/integrations
```

Ou, no PowerShell:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8787/api/integrations | Select-Object -ExpandProperty Content
```

Para considerar a stack principal pronta, o esperado e:

- `jan.ok = true`
- `image.provider = comfyui` e `image.ok = true`
- `memory.provider` apontando para o provider com Neo4j habilitado e `memory.ok = true`
- `tts.provider = piper-tts` e `tts.ok = true`

## Diagnostico rapido

Se a aplicacao iniciar, mas a stack principal nao estiver completa, consulte `/api/integrations` e compare com esta tabela:

- `jan.ok = false`: JanAI nao esta no ar, a porta esta errada, ou `JAN_MODEL` nao corresponde ao modelo carregado.
- `image.ok = false` com provider `comfyui` ou `local-image-server`: ComfyUI nao esta no ar, o checkpoint configurado nao existe, ou a API nao esta respondendo aos endpoints esperados.
- `memory.ok = false`: URI, usuario, senha ou database do Neo4j estao errados; em algumas versoes antigas o indice vetorial pode nao ser criado, mas o provider ainda deve funcionar.
- `tts.ok = false`: `TTS_ENABLED` esta desligado, `TTS_PIPER_BINARY` nao foi encontrado, ou `TTS_VOICE_GM` aponta para um arquivo ausente.

## Resumo do que precisa ser baixado

Para uma pessoa conseguir executar a aplicacao corretamente com o fluxo principal, ela precisa baixar e configurar:

1. O proprio repositorio.
2. Node.js.
3. JanAI e um modelo local compativel com `JAN_MODEL`.
4. ComfyUI.
5. Um checkpoint SDXL para o ComfyUI, de preferencia `RealVisXL_V5.0_fp16.safetensors`.
6. Piper TTS.
7. As vozes `pt_BR-faber-medium.onnx` e `pt_BR-edresson-low.onnx`.
8. Neo4j.

Sem esses itens, o repositorio compila e o servidor pode ate iniciar, mas a experiencia principal do projeto nao fica reproduzivel.

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
- O repositório atual permite subir o servidor apenas com `npm install` e `.env.example`, mas isso resulta em modo degradado. Para um terceiro reproduzir a experiencia principal, ele ainda precisa providenciar JanAI, ComfyUI, Piper, vozes `.onnx`, checkpoint e Neo4j funcionando localmente ou em endpoints acessiveis.
