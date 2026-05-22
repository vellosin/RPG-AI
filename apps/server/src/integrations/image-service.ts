import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import type { ImageJob } from "../game/types.js";
import { config } from "../config.js";
import type { IntegrationStatus } from "../game/types.js";

type ImageProviderDetection =
  | {
      kind: "comfy";
      provider: "comfyui";
      details: string;
      location: string;
      checkpoint: string;
    }
  | {
      kind: "python-sdxl";
      provider: "python-sdxl-runtime";
      details: string;
      location: string;
    }
  | {
      kind: "automatic1111";
      provider: "automatic1111";
      details: string;
      location: string;
    }
  | {
      kind: "openai-images";
      provider: "openai-compatible";
      details: string;
      location: string;
    }
  | {
      kind: "unsupported-openai";
      provider: "openai-compatible";
      details: string;
      location: string;
    }
  | {
      kind: "unavailable";
      provider: "local-image-server";
      details: string;
      location: string;
    };

const negativePromptByProfile: Record<ImageJob["profile"], string> = {
  npc: "blurry, low quality, deformed, extra limbs, bad anatomy, cropped head, cropped feet, text, watermark, character sheet, reference sheet, multiple views, grey background, white background, flat lighting, top down token, tabletop token, 3d render, photorealistic, side view, close-up face, waist up, bust portrait, generic young handsome hero, random catalog portrait",
  portrait: "blurry, low quality, deformed, extra limbs, bad anatomy, broken hands, malformed limbs, extra fingers, fused fingers, cropped head, asymmetrical eyes, extra face, duplicate person, extra people, repeated character, same character repeated, contact sheet, grid, panels, panel layout, comic panels, filmstrip, split screen, lineup, turnaround, front back side view, floating object, weapon visible, holding weapon, sword, axe, bow, staff weapon, shield, detached weapons, isolated weapons, weapon catalog, armor catalog, shield catalog, item sheet, inventory sheet, prop sheet, concept sheet, model sheet, character sheet, reference sheet, multiple views, icons, separate objects around character, helmet covering face, closed helmet, mask, split face, abstract face, geometric face, metal face, robot face, frame, border, window frame, silhouette, strong backlight, harsh shadow, heavy black shadows, face hidden in shadow, noir lighting, overexposed window, high contrast lighting, landscape, mountains, lake, forest background, scenery, outdoor vista, standing full body, legs, feet, full body, tiny full body figure, text, watermark, signature, grey background, flat lighting, 3d render, photorealistic, side view",
  scene: "blurry, low quality, deformed, duplicate elements, washed out lighting, portrait framing, close-up face, character portrait, people standing still, text, watermark, collage, multiple panels, white background, grey background, flat lighting, sketch, 3d render",
  creature: "blurry, low quality, deformed, extra limbs, human face, duplicate creature, cropped body, cropped feet, text, watermark, character sheet, multiple views, grey background, white background, flat lighting, top down token, tabletop token, 3d render, side view, close-up face, waist up, bust portrait, humanoid with sword, warrior armor, weapon catalog",
  item: "blurry, low quality, deformed, hand holding item, person, character, cropped object, duplicate item, text, watermark",
};

type RenderSettings = {
  width: number;
  height: number;
  steps: number;
  guidanceScale: number;
};

export class ImageService {
  private pythonRuntimeDevice: "cpu" | "cuda" | null = null;
  private cachedDetection: ImageProviderDetection | null = null;
  private cachedComfyCheckpoint: string | null = null;

  private lastStatus: IntegrationStatus = {
    provider: "local-image-server",
    baseUrl: config.imageBaseUrl,
    ok: false,
    mode: "fallback",
    details: "Image API not checked yet.",
  };

  async render(job: ImageJob, options: { skipCache?: boolean } = {}): Promise<{ assetUrl: string } | null> {
    const cached = options.skipCache ? null : this.resolveCached(job);
    if (cached) return cached;

    const liveResult = await this.tryRenderLive(job);
    if (liveResult) {
      this.saveForCuration(liveResult.assetUrl, job);
      return liveResult;
    }

    this.lastStatus = {
      provider: "local-image-server",
      baseUrl: config.imageBaseUrl,
      ok: false,
      mode: "fallback",
      details: "Live image server unavailable. Job left in queue.",
    };
    return null;
  }

  resolveCached(job: ImageJob): { assetUrl: string } | null {
    // 1. Drive cache — curated scene/item images are fine, but NPCs and creatures
    // must respect fresh scene descriptions and should be generated first.
    if (job.profile !== "portrait" && job.profile !== "npc" && job.profile !== "creature") {
      const driveHit = this.tryDriveCache(job);
      if (driveHit) {
        this.lastStatus = {
          provider: "local-image-server",
          baseUrl: config.driveCacheDir,
          ok: true,
          mode: "live",
          details: "Using curated image from Drive cache.",
        };
        return driveHit;
      }
    }

    // 2. For scene images, check the local pre-built catalog (manually placed images)
    if (job.profile === "scene") {
      const prebuilt = this.tryPrebuiltScene(job.prompt);
      if (prebuilt) {
        this.lastStatus = {
          provider: "local-image-server",
          baseUrl: config.scenesDir,
          ok: true,
          mode: "live",
          details: "Using pre-built scene image.",
        };
        return prebuilt;
      }
    }

    // 3. Live generation — SDXL or API
    return null;
  }

  async getStatus(): Promise<IntegrationStatus> {
    const mcpHint = await this.checkMcpHint();
    const detection = await this.detectProvider();
    this.cachedDetection = detection; // refresh cache on explicit status check
    const live =
      detection.kind === "comfy" ||
      detection.kind === "python-sdxl" ||
      detection.kind === "automatic1111" ||
      detection.kind === "openai-images";
    this.lastStatus = {
      provider: detection.provider,
      baseUrl: detection.location,
      ok: live,
      mode: live ? "live" : "fallback",
      details: `${detection.details}. MCP hint: ${mcpHint}`,
    };
    return this.lastStatus;
  }

  getCachedStatus(): IntegrationStatus {
    return this.lastStatus;
  }

  private async checkMcpHint(): Promise<string> {
    try {
      const response = await fetch(config.imageMcpUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: {
              name: "local-rpg-ai",
              version: "0.1.0",
            },
          },
        }),
        signal: AbortSignal.timeout(2500),
      });

      return response.ok ? `reachable at ${config.imageMcpUrl}` : `HTTP ${response.status} at ${config.imageMcpUrl}`;
    } catch (error) {
      return `unreachable at ${config.imageMcpUrl} (${(error as Error).message})`;
    }
  }

  private async detectProvider(): Promise<ImageProviderDetection> {
    const providerPreference = config.imageProvider.toLowerCase();

    if (providerPreference === "auto" || providerPreference === "comfy") {
      const comfy = await this.detectComfyProvider();
      if (comfy || providerPreference === "comfy") {
        return (
          comfy ?? {
            kind: "unavailable",
            provider: "local-image-server",
            details: `ComfyUI not detected at ${config.imageComfyUrl}`,
            location: config.imageComfyUrl,
          }
        );
      }
    }

    if (providerPreference === "auto" || providerPreference === "python") {
      const pythonRuntime = await this.detectPythonRuntime();
      if (pythonRuntime) {
        return pythonRuntime;
      }
    }

    if (providerPreference === "auto" || providerPreference === "automatic1111") {
      try {
      const response = await fetch(`${config.imageBaseUrl}/sdapi/v1/options`, {
        signal: AbortSignal.timeout(2500),
      });
      if (response.ok) {
        return {
          kind: "automatic1111",
          provider: "automatic1111",
          details: "Detected Automatic1111-compatible image API",
          location: config.imageBaseUrl,
        };
      }
      } catch {
        // Ignore and continue probing other provider shapes.
      }
    }

    if (providerPreference !== "auto" && providerPreference !== "openai") {
      return {
        kind: "unavailable",
        provider: "local-image-server",
        details: `IMAGE_PROVIDER=${config.imageProvider} did not detect a compatible image provider`,
        location: config.imageBaseUrl,
      };
    }

    try {
      const response = await fetch(`${config.imageBaseUrl}/v1/models`, {
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) {
        return {
          kind: "unavailable",
          provider: "local-image-server",
          details: `No compatible image API detected at ${config.imageBaseUrl}`,
          location: config.imageBaseUrl,
        };
      }

      const payload = (await response.json()) as {
        data?: Array<{ id?: string; capabilities?: string[] }>;
        models?: Array<{ model?: string; capabilities?: string[] }>;
      };
      const capabilities = [
        ...(payload.data ?? []).flatMap((model) => model.capabilities ?? []),
        ...(payload.models ?? []).flatMap((model) => model.capabilities ?? []),
      ].map((capability) => capability.toLowerCase());
      const supportsImages = capabilities.some((capability) => capability.includes("image"));

      if (supportsImages) {
        return {
          kind: "openai-images",
          provider: "openai-compatible",
          details: "Detected OpenAI-compatible image API",
          location: config.imageBaseUrl,
        };
      }

      const modelNames = [
        ...(payload.data ?? []).map((model) => model.id).filter(Boolean),
        ...(payload.models ?? []).map((model) => model.model).filter(Boolean),
      ].join(", ");

      return {
        kind: "unsupported-openai",
        provider: "openai-compatible",
        details: `Detected OpenAI-compatible service (${modelNames || "unknown model"}), but it only advertises completion/chat capabilities and cannot generate images`,
        location: config.imageBaseUrl,
      };
    } catch (error) {
      return {
        kind: "unavailable",
        provider: "local-image-server",
        details: `${(error as Error).message}. Local fallback art previews are enabled`,
        location: config.imageBaseUrl,
      };
    }
  }

  private async detectComfyProvider(): Promise<ImageProviderDetection | null> {
    try {
      const status = await fetch(this.comfyUrl("/system_stats"), {
        signal: AbortSignal.timeout(2500),
      });
      if (!status.ok) return null;

      const checkpoint = await this.resolveComfyCheckpoint();
      if (!checkpoint) return null;

      return {
        kind: "comfy",
        provider: "comfyui",
        details: `Detected ComfyUI with checkpoint ${checkpoint}`,
        location: config.imageComfyUrl,
        checkpoint,
      };
    } catch {
      return null;
    }
  }

  private async detectPythonRuntime(): Promise<ImageProviderDetection | null> {
    if (!config.imagePythonExecutable || !config.imageRuntimeDir) {
      return null;
    }

    if (!existsSync(path.join(config.imageRuntimeDir, "sdxl_runtime.py"))) {
      return null;
    }

    try {
      const output = await this.runPythonSnippet(
        [
          "import json",
          "from sdxl_runtime import MODEL_DIR, _DEVICE",
          "print(json.dumps({'model_dir': str(MODEL_DIR), 'device': _DEVICE}))",
        ].join("\n"),
      );
      const payload = JSON.parse(output) as { model_dir?: string; device?: "cpu" | "cuda" };
      this.pythonRuntimeDevice = payload.device ?? null;

      return {
        kind: "python-sdxl",
        provider: "python-sdxl-runtime",
        details: `Detected local SDXL diffusers runtime on ${payload.device ?? "unknown device"}`,
        location: config.imageRuntimeDir,
      };
    } catch (error) {
      this.pythonRuntimeDevice = null;
      return {
        kind: "unavailable",
        provider: "local-image-server",
        details: `Local SDXL runtime is configured but failed to load: ${(error as Error).message}`,
        location: config.imageRuntimeDir,
      };
    }
  }

  // ── Drive cache helpers ─────────────────────────────────────────────────────
  // Check the local drive-cache/ folder (synced from Google Drive by sync_drive.py)
  // before falling back to SDXL generation. Priority: Drive > local catalog > SDXL.

  private tryDriveCache(job: ImageJob): { assetUrl: string } | null {
    if (job.profile === "scene") return this.tryDriveCacheScene(job.prompt);
    if (job.profile === "npc") return this.tryDriveCachePortrait(job.prompt);
    if (job.profile === "creature") return this.tryDriveCacheCreature(job.prompt);
    return null;
  }

  private tryDriveCacheScene(promptText: string): { assetUrl: string } | null {
    const cacheDir = path.join(config.driveCacheDir, "cenarios");
    if (!existsSync(cacheDir)) return null;

    let files: string[];
    try {
      files = readdirSync(cacheDir).filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f));
    } catch { return null; }
    if (files.length === 0) return null;

    // Keyword-to-filename-prefix map — no catalog.json required
    const keywordPrefixMap: Array<[string[], string[]]> = [
      [["cave", "cavern", "caverna", "crypt", "cripta", "dungeon", "underground", "skeleton", "esqueleto", "undead", "morto"], ["Caverna", "caverna", "tunel"]],
      [["swamp", "pantano", "pântano", "marsh", "bog", "pantanal"], ["pantano", "vila-pantano", "floresta-pantano", "casa-pantano"]],
      [["tavern", "taverna", "inn", "estalagem", "pub", "albergue", "bar"], ["Taverna", "taverna"]],
      [["forest", "floresta", "woods", "jungle", "selva", "arvore", "tree"], ["floresta", "tunel-arvores", "montanha-floresta", "casa-moderna-floresta"]],
      [["desert", "deserto", "sand", "dune", "areia"], ["Deserto"]],
      [["church", "chapel", "temple", "cathedral", "igreja", "templo", "sanctuary", "blackstone", "catedral"], ["Interior_Igreja", "Deserto_Noite_igreaofundo"]],
      [["mountain", "montanha", "cliff", "peak", "hill", "morro"], ["montanha"]],
      [["village", "vila", "town", "cidade", "vilarejo", "settlement", "aldeia"], ["vila-pantano", "casa-medieval", "barraco"]],
      [["beach", "praia", "coast", "litoral", "pirate", "pirata", "ship", "navio", "sea", "ocean", "port", "porto", "mar"], ["casa-pantano-porto"]],
      [["ruins", "ruinas", "rubble", "destrocos", "abandoned", "abandonado", "wrecked", "debris"], ["floresta-destroços"]],
      [["road", "estrada", "path", "caminho", "plains", "campo", "trail", "trilha"], ["floresta-inicio", "montanha-floresta"]],
      [["hut", "barraco", "cabin", "shack", "humble", "humilde"], ["barraco", "casa-humilde"]],
      [["house", "home", "casa", "medieval"], ["casa-medieval", "casa-moderna"]],
      [["laboratory", "laboratorio", "alchemist", "alquimista", "lab"], ["Laboratorio"]],
      [["room", "quarto", "chamber", "interior"], ["Quarto", "Interior_Igreja"]],
    ];

    const lower = promptText.toLowerCase();
    for (const [triggers, prefixes] of keywordPrefixMap) {
      if (triggers.some((kw) => lower.includes(kw))) {
        const matching = files.filter((f) => prefixes.some((p) => f.toLowerCase().startsWith(p.toLowerCase())));
        if (matching.length > 0) {
          const chosen = matching[Math.floor(Math.random() * matching.length)]!;
          return { assetUrl: `/assets/drive-cache/cenarios/${chosen}` };
        }
      }
    }

    // Fallback: random image from cenarios
    const chosen = files[Math.floor(Math.random() * files.length)]!;
    return { assetUrl: `/assets/drive-cache/cenarios/${chosen}` };
  }

  private tryDriveCachePortrait(promptText: string): { assetUrl: string } | null {
    const cacheDir = path.join(config.driveCacheDir, "retratos");
    if (!existsSync(cacheDir)) return null;

    let files: string[];
    try {
      files = readdirSync(cacheDir).filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f));
    } catch { return null; }
    if (files.length === 0) return null;

    // Keywords matched against filename substrings (case-insensitive)
    const keywordFileMap: Array<[string[], string[]]> = [
      // Mages / sorcerers
      [["mage", "mago", "maga", "wizard", "sorcerer", "feiticeiro", "feiticeira", "arcanist", "arcana", "witch", "bruxa", "arcane", "scholar scholar", "rune", "runa", "spell", "magia", "magic", "alchemist", "alquimista"], ["mago", "Feiticeiro", "Bruxa", "Gnomo-Alquimista", "humano-estudioso"]],
      // Rogues / thieves / assassins
      [["rogue", "thief", "ladino", "ladrão", "gatuno", "bandit", "bandido", "spy", "espião", "ninja", "assassin", "assassino", "pirata", "pirate"], ["Humano-Gatuno", "Gnomo-Ladino", "Bandido-Mascarado", "Elfo-Assassino", "Ninja-Assassino", "Anao-Pirata-Ladino", "Humano-Pirata", "Humano-Capitao-Pirata", "Meio-Elfo-Besta-pirata"]],
      // Warriors / fighters
      [["warrior", "guerreiro", "fighter", "knight", "cavaleiro", "soldier", "soldado", "guard", "guardião", "captain", "capitão", "inimigo", "enemy", "hostile", "villain", "vilão", "antagonist"], ["guerreiro", "Guerreiro", "armadurado", "espadao", "Rei-guerra", "Soldado", "Humano-Conquistador", "Meio-Orc-Guerreiro", "Meio-Orc-Lutador", "Dark-Elf-Guerreiro", "Elfo-Guerreiro", "Anao-Guerreiro"]],
      // Rangers / archers
      [["ranger", "patrulheiro", "hunter", "caçador", "archer", "arqueiro", "arqueira", "scout", "explorador"], ["Meio-elfo-patrulheiro", "Elfo-Arqueiro", "Dark-Elf-Arqueira", "Meio-Orc-Arqueiro", "Elfa-Lança", "Guerreiro-Lança"]],
      // Clerics / priests
      [["cleric", "clérigo", "priest", "padre", "priestess", "sacerdote", "sacerdotisa", "holy", "sagrado", "paladin", "paladino", "divine", "divino", "religious", "religioso"], ["Humana-Sacerdote", "Humano-Padre-ouro", "Meia-Elfa-Sacerdote"]],
      // Druids
      [["druid", "druida", "nature", "natureza", "shaman", "xamã"], ["Humano-Druida", "mago.druida"]],
      // Nobles / leaders
      [["noble", "nobre", "nobleman", "noblewoman", "lord", "lady", "king", "rei", "queen", "rainha", "prince", "princess", "scholar", "estudioso", "ally", "aliado", "friendly", "merchant", "comerciante", "innkeeper"], ["Humana-Nobre", "Humano-Nobre", "Humano-Nobre-Jovem", "humano-estudioso", "Anao-Anciao", "violinista"]],
      // Bards
      [["bard", "bardo", "musician", "músico", "singer", "cantora", "violinist", "violinista", "minstrel"], ["Anao-Bardo", "violinista", "violinista2"]],
      // Monks
      [["monk", "monge", "martial", "martial artist"], ["humano-monge"]],
      // Dark / undead / evil
      [["undead", "morto-vivo", "lich", "lich", "death", "morte", "dark", "sombrio", "shadow", "sombra", "necromancer", "necromante"], ["Rainha dos mortos", "Feiticeiro-sombrio", "mago.negro", "Guerreiro-Negro-Morcego"]],
    ];

    const lower = promptText.toLowerCase();
    const pickFromSubstrings = (substrings: string[]): string | null => {
      const matching = files.filter((f) => substrings.some((s) => f.toLowerCase().includes(s.toLowerCase())));
      return matching.length > 0 ? (matching[Math.floor(Math.random() * matching.length)] ?? null) : null;
    };

    for (const [triggers, substrings] of keywordFileMap) {
      if (triggers.some((kw) => lower.includes(kw))) {
        const pick = pickFromSubstrings(substrings);
        if (pick) return { assetUrl: `/assets/drive-cache/retratos/${pick}` };
      }
    }

    // Fallback: random portrait
    const chosen = files[Math.floor(Math.random() * files.length)]!;
    return { assetUrl: `/assets/drive-cache/retratos/${chosen}` };
  }

  private tryDriveCacheCreature(promptText: string): { assetUrl: string } | null {
    const cacheDir = path.join(config.driveCacheDir, "monstros");
    if (!existsSync(cacheDir)) return null;

    let files: string[];
    try {
      files = readdirSync(cacheDir).filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f));
    } catch { return null; }
    if (files.length === 0) return null;

    const keywordFileMap: Array<[string[], string[]]> = [
      // Skeletons / undead
      [["skeleton", "esqueleto", "undead", "morto-vivo", "lich", "zombie", "zumbi", "ghost", "fantasma", "wight", "revenant", "ghoul"], ["Esqueleto", "esqueleto", "fantasma-caveiras"]],
      // Goblins / humanoids / small
      [["goblin", "kobold", "gnoll", "bandit group", "bando", "warband"], ["bando-de-goblins", "Hienas-armadas-grupo"]],
      // Cyclops / giants
      [["cyclop", "ciclope", "giant", "gigante", "ogre", "ogro", "troll"], ["Ciclop", "gigante.martelo"]],
      // Imps / fiends / demons
      [["imp", "demon", "demônio", "fiend", "devil", "diabo", "infernal"], ["imp-maior", "imp-verde", "Imp"]],
      // Golems / constructs
      [["golem", "construct", "animated", "stone", "iron", "pedra"], ["Golem-pedra"]],
      // Lizards / reptiles
      [["lizard", "lagarto", "reptile", "reptil", "serpent", "serpente", "snake"], ["Lagarto"]],
      // Beasts / animals
      [["beast", "wolf", "lobo", "bear", "urso", "boar", "javali", "animal", "fera", "creature", "criatura", "monster", "monstro"], ["Fera-Brabissima", "cogumelo-floresta"]],
      // Griffins / flying
      [["griffin", "grifo", "wyvern", "flying", "winged", "alado"], ["Grifo-bebe-mae"]],
      // Pirate / ship
      [["pirate", "pirata", "ship", "navio", "sailor", "marinheiro", "sea", "ocean", "destroyer"], ["Destruidor-de-Barcos", "Esqueleto-Pirata"]],
    ];

    const lower = promptText.toLowerCase();
    const pickFromSubstrings = (substrings: string[]): string | null => {
      const matching = files.filter((f) => substrings.some((s) => f.toLowerCase().includes(s.toLowerCase())));
      return matching.length > 0 ? (matching[Math.floor(Math.random() * matching.length)] ?? null) : null;
    };

    for (const [triggers, substrings] of keywordFileMap) {
      if (triggers.some((kw) => lower.includes(kw))) {
        const pick = pickFromSubstrings(substrings);
        if (pick) return { assetUrl: `/assets/drive-cache/monstros/${pick}` };
      }
    }

    // Fallback: random monster
    const chosen = files[Math.floor(Math.random() * files.length)]!;
    return { assetUrl: `/assets/drive-cache/monstros/${chosen}` };
  }

  /** Returns a structured inventory of all available images so the LLM can plan stories around them. */
  getImageInventory(): { cenarios: string[]; criaturas: string[]; retratos: string[] } {
    const listDir = (dir: string): string[] => {
      if (!existsSync(dir)) return [];
      try {
        return readdirSync(dir).filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f));
      } catch { return []; }
    };
    const scenesLocal = listDir(config.scenesDir).filter((f) => f !== "catalog.json" && /\.(png|jpg|jpeg|webp)$/i.test(f));
    const scenesDrive = listDir(path.join(config.driveCacheDir, "cenarios"));
    return {
      cenarios: [...new Set([...scenesDrive, ...scenesLocal])],
      criaturas: listDir(path.join(config.driveCacheDir, "monstros")),
      retratos: listDir(path.join(config.driveCacheDir, "retratos")),
    };
  }

  /** Picks a random supported image from a directory and returns its asset URL. */
  private pickRandomFromDir(dirPath: string, assetPrefix: string): { assetUrl: string } | null {
    if (!existsSync(dirPath)) return null;
    try {
      const images = readdirSync(dirPath).filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f));
      if (images.length > 0) {
        const pick = images[Math.floor(Math.random() * images.length)];
        return { assetUrl: `/assets/${assetPrefix}/${pick}` };
      }
    } catch {
      // ignore
    }
    return null;
  }

  /** Saves a copy of a freshly generated image to storage/curadoria/ for user review.
   *  The user can then approve images and upload them to Google Drive via sync_drive.py. */
  private saveForCuration(assetUrl: string, job: ImageJob): void {
    const sourcePath = path.join(config.storageDir, assetUrl.replace("/assets/", ""));
    if (!existsSync(sourcePath)) return;

    let subdir: string;
    if (job.profile === "scene") {
      const catalogPath = path.join(config.scenesDir, "catalog.json");
      let category = "outros";
      try {
        const catalog = JSON.parse(readFileSync(catalogPath, "utf-8")) as Array<{ id: string; keywords: string[] }>;
        const lower = job.prompt.toLowerCase();
        const match = catalog.find((e) => e.keywords.some((kw) => lower.includes(kw)));
        if (match) category = match.id;
      } catch { /* ignore */ }
      subdir = `cenarios/${category}`;
    } else if (job.profile === "portrait" || job.profile === "npc") {
      subdir = "retratos";
    } else if (job.profile === "creature") {
      subdir = "monstros";
    } else {
      subdir = "outros";
    }

    const destDir = path.join(config.curationDir, subdir);
    mkdirSync(destDir, { recursive: true });
    try {
      copyFileSync(sourcePath, path.join(destDir, path.basename(sourcePath)));
    } catch { /* ignore silently — curation copy is non-critical */ }
  }

  /** Returns a pre-built scene asset URL if a matching image exists in the scenes directory,
   *  driven by catalog.json keyword matching with random variant selection for variety.
   *  Returns null if the directory is missing or no match found. */
  private tryPrebuiltScene(promptText: string): { assetUrl: string } | null {
    if (!existsSync(config.scenesDir)) return null;

    const catalogPath = path.join(config.scenesDir, "catalog.json");
    if (!existsSync(catalogPath)) return null;

    type CatalogEntry = { id: string; keywords: string[]; files: string[] };
    let catalog: CatalogEntry[];
    try {
      catalog = JSON.parse(readFileSync(catalogPath, "utf-8")) as CatalogEntry[];
    } catch {
      return null;
    }

    const lower = promptText.toLowerCase();

    for (const entry of catalog) {
      if (entry.keywords.some((kw) => lower.includes(kw))) {
        const available = entry.files.filter((f) => existsSync(path.join(config.scenesDir, f)));
        if (available.length > 0) {
          const pick = available[Math.floor(Math.random() * available.length)];
          return { assetUrl: `/assets/scenes/${pick}` };
        }
      }
    }

    // Generic fallback within the scenes dir
    if (existsSync(path.join(config.scenesDir, "default.png"))) {
      return { assetUrl: "/assets/scenes/default.png" };
    }

    // Use any PNG in the directory as an absolute last resort
    try {
      const files = readdirSync(config.scenesDir).filter((f) => f.endsWith(".png"));
      if (files.length > 0) {
        return { assetUrl: `/assets/scenes/${files[0]}` };
      }
    } catch {
      // ignore
    }

    return null;
  }

  private async tryRenderLive(job: ImageJob): Promise<{ assetUrl: string } | null> {
    // Use cached detection to avoid spawning a redundant Python subprocess on every render.
    // Only re-probe if the previous detection was unsuccessful.
    if (!this.cachedDetection) {
      this.cachedDetection = await this.detectProvider();
    }
    const detection = this.cachedDetection;
    // Don't persist a failed/unavailable detection — retry on next call
    if (detection.kind === "unavailable" || detection.kind === "unsupported-openai") {
      this.cachedDetection = null;
    }

    if (detection.kind === "comfy") {
      const result = await this.tryRenderComfy(job, detection.checkpoint);
      if (result || config.imageProvider.toLowerCase() === "comfy") return result;

      const pythonRuntime = await this.detectPythonRuntime();
      if (pythonRuntime) return this.tryRenderPythonSdxl(job);
    }

    if (detection.kind === "python-sdxl") {
      return this.tryRenderPythonSdxl(job);
    }

    if (detection.kind === "automatic1111") {
      return this.tryRenderAutomatic1111(job);
    }

    if (detection.kind === "openai-images") {
      return this.tryRenderOpenAiImages(job);
    }

    this.lastStatus = {
      provider: detection.provider,
      baseUrl: detection.location,
      ok: false,
      mode: "fallback",
      details: detection.details,
    };
    return null;
  }

  private async tryRenderComfy(job: ImageJob, checkpoint: string): Promise<{ assetUrl: string } | null> {
    const settings = this.getComfyRenderSettings(job.profile);
    const fileName = `${job.id}.png`;
    const clientId = `rpg-${job.id}`;
      const prompt = this.buildComfyWorkflow(job, settings, checkpoint);

    try {
      const response = await fetch(this.comfyUrl("/prompt"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, client_id: clientId }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`ComfyUI /prompt failed with HTTP ${response.status}`);

      const payload = (await response.json()) as { prompt_id?: string };
      if (!payload.prompt_id) throw new Error("ComfyUI did not return a prompt_id.");

      const image = await this.waitForComfyImage(payload.prompt_id);
      const imageResponse = await fetch(this.comfyViewUrl(image), {
        signal: AbortSignal.timeout(120000),
      });
      if (!imageResponse.ok) throw new Error(`ComfyUI /view failed with HTTP ${imageResponse.status}`);

      mkdirSync(config.generatedImagesDir, { recursive: true });
      const filePath = path.join(config.generatedImagesDir, fileName);
      writeFileSync(filePath, Buffer.from(await imageResponse.arrayBuffer()));

      this.lastStatus = {
        provider: "comfyui",
        baseUrl: config.imageComfyUrl,
        ok: true,
        mode: "live",
        details: `Generated ${job.profile} via ComfyUI ${this.getComfyWorkflowName(job.profile)} using ${checkpoint}.`,
      };
      return { assetUrl: `/assets/generated/${fileName}` };
    } catch (error) {
      this.cachedDetection = null;
      this.lastStatus = {
        provider: "comfyui",
        baseUrl: config.imageComfyUrl,
        ok: false,
        mode: "fallback",
        details: (error as Error).message,
      };
      return null;
    }
  }

  private async tryRenderPythonSdxl(job: ImageJob): Promise<{ assetUrl: string } | null> {
    const settings = this.getRenderSettings(job.profile);
    const { width, height, steps, guidanceScale } = settings;
    const fileName = `${job.id}.png`;

    try {
      const payload = await this.runPythonSnippet(
        [
          "import json, sys",
          "from sdxl_runtime import generate_image",
          "payload = json.loads(sys.argv[1])",
          "output_path = generate_image(",
          "    payload['prompt'],",
          "    negative_prompt=payload['negative_prompt'],",
          "    width=payload['width'],",
          "    height=payload['height'],",
          "    steps=payload['steps'],",
          "    guidance_scale=payload['guidance_scale'],",
          "    seed=payload['seed'],",
          "    output_name=payload['output_name'],",
          ")",
          "print(json.dumps({'path': str(output_path)}))",
        ].join("\n"),
        JSON.stringify({
          prompt: job.prompt,
          negative_prompt: this.buildNegativePrompt(job),
          width,
          height,
          steps,
          guidance_scale: guidanceScale,
          seed: job.seed ?? 42,
          output_name: fileName,
        }),
        900000,
      );

      const result = JSON.parse(payload) as { path?: string };
      if (!result.path || !existsSync(result.path)) {
        throw new Error("Python SDXL runtime did not return a valid image path.");
      }

      mkdirSync(config.generatedImagesDir, { recursive: true });
      const filePath = path.join(config.generatedImagesDir, fileName);
      copyFileSync(result.path, filePath);

      this.lastStatus = {
        provider: "python-sdxl-runtime",
        baseUrl: config.imageRuntimeDir,
        ok: true,
        mode: "live",
        details: `Generated image via local Python SDXL runtime on ${this.pythonRuntimeDevice ?? "unknown device"}.`,
      };
      return { assetUrl: `/assets/generated/${fileName}` };
    } catch (error) {
      this.lastStatus = {
        provider: "python-sdxl-runtime",
        baseUrl: config.imageRuntimeDir,
        ok: false,
        mode: "fallback",
        details: (error as Error).message,
      };
      return null;
    }
  }

  private async tryRenderAutomatic1111(job: ImageJob): Promise<{ assetUrl: string } | null> {
    try {
      const settings = this.getRenderSettings(job.profile);
      const response = await fetch(`${config.imageBaseUrl}/sdapi/v1/txt2img`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: job.prompt,
          negative_prompt: this.buildNegativePrompt(job),
          width: settings.width,
          height: settings.height,
          steps: settings.steps,
          cfg_scale: settings.guidanceScale,
          seed: job.seed ?? 42,
        }),
        signal: AbortSignal.timeout(120000),
      });

      if (!response.ok) {
        this.lastStatus = {
          provider: "automatic1111",
          baseUrl: config.imageBaseUrl,
          ok: false,
          mode: "fallback",
          details: `txt2img failed with HTTP ${response.status}`,
        };
        return null;
      }

      const payload = (await response.json()) as { images?: string[] };
      const image = payload.images?.[0];
      if (!image) {
        this.lastStatus = {
          provider: "automatic1111",
          baseUrl: config.imageBaseUrl,
          ok: false,
          mode: "fallback",
          details: "No image returned.",
        };
        return null;
      }

      mkdirSync(config.generatedImagesDir, { recursive: true });
      const fileName = `${job.id}.png`;
      const filePath = path.join(config.generatedImagesDir, fileName);
      writeFileSync(filePath, Buffer.from(image, "base64"));

      this.lastStatus = {
        provider: "automatic1111",
        baseUrl: config.imageBaseUrl,
        ok: true,
        mode: "live",
        details: "Generated image via local txt2img.",
      };
      return { assetUrl: `/assets/generated/${fileName}` };
    } catch (error) {
      this.lastStatus = {
        provider: "automatic1111",
        baseUrl: config.imageBaseUrl,
        ok: false,
        mode: "fallback",
        details: (error as Error).message,
      };
      return null;
    }
  }

  private async tryRenderOpenAiImages(job: ImageJob): Promise<{ assetUrl: string } | null> {
    try {
      const response = await fetch(`${config.imageBaseUrl}/v1/images/generations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.imageModel || undefined,
          prompt: job.prompt,
          size: job.profile === "scene" ? "1536x1024" : "1024x1024",
          response_format: "b64_json",
        }),
        signal: AbortSignal.timeout(120000),
      });

      if (!response.ok) {
        this.lastStatus = {
          provider: "openai-compatible",
          baseUrl: config.imageBaseUrl,
          ok: false,
          mode: "fallback",
          details: `images/generations failed with HTTP ${response.status}`,
        };
        return null;
      }

      const payload = (await response.json()) as {
        data?: Array<{ b64_json?: string; url?: string }>;
      };
      const image = payload.data?.[0]?.b64_json;
      const remoteUrl = payload.data?.[0]?.url;

      if (!image && remoteUrl) {
        this.lastStatus = {
          provider: "openai-compatible",
          baseUrl: config.imageBaseUrl,
          ok: true,
          mode: "live",
          details: "Generated image via remote OpenAI-compatible URL response.",
        };
        return { assetUrl: remoteUrl };
      }

      if (!image) {
        this.lastStatus = {
          provider: "openai-compatible",
          baseUrl: config.imageBaseUrl,
          ok: false,
          mode: "fallback",
          details: "No image payload returned by images/generations.",
        };
        return null;
      }

      mkdirSync(config.generatedImagesDir, { recursive: true });
      const fileName = `${job.id}.png`;
      const filePath = path.join(config.generatedImagesDir, fileName);
      writeFileSync(filePath, Buffer.from(image, "base64"));

      this.lastStatus = {
        provider: "openai-compatible",
        baseUrl: config.imageBaseUrl,
        ok: true,
        mode: "live",
        details: "Generated image via OpenAI-compatible images endpoint.",
      };
      return { assetUrl: `/assets/generated/${fileName}` };
    } catch (error) {
      this.lastStatus = {
        provider: "openai-compatible",
        baseUrl: config.imageBaseUrl,
        ok: false,
        mode: "fallback",
        details: (error as Error).message,
      };
      return null;
    }
  }

  private async resolveComfyCheckpoint(): Promise<string | null> {
    if (this.cachedComfyCheckpoint) return this.cachedComfyCheckpoint;

    const configured = config.imageComfyCheckpoint.trim();
    if (configured) {
      this.cachedComfyCheckpoint = configured;
      return configured;
    }

    const response = await fetch(this.comfyUrl("/object_info/CheckpointLoaderSimple"), {
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return null;

    const payload = (await response.json()) as {
      CheckpointLoaderSimple?: {
        input?: {
          required?: {
            ckpt_name?: unknown;
          };
        };
      };
    };
    const raw = payload.CheckpointLoaderSimple?.input?.required?.ckpt_name;
    const options = Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : [];
    const checkpoint = options.find((value): value is string => typeof value === "string");
    this.cachedComfyCheckpoint = checkpoint ?? null;
    return this.cachedComfyCheckpoint;
  }

  private buildComfyWorkflow(job: ImageJob, settings: RenderSettings, checkpoint: string): Record<string, unknown> {
    switch (job.profile) {
      case "portrait":
        return this.buildComfyPortraitWorkflow(job, settings, checkpoint);
      case "scene":
        return this.buildComfySceneWorkflow(job, settings, checkpoint);
      case "npc":
        return this.buildComfyCharacterSceneWorkflow(job, settings, checkpoint, "npc");
      case "creature":
        return this.buildComfyCharacterSceneWorkflow(job, settings, checkpoint, "creature");
      case "item":
      default:
        return this.buildComfyItemWorkflow(job, settings, checkpoint);
    }
  }

  private buildComfyPortraitWorkflow(job: ImageJob, settings: RenderSettings, checkpoint: string): Record<string, unknown> {
    return this.buildComfyBaseTxt2ImgWorkflow({
      job,
      settings,
      checkpoint,
      positivePrompt: this.buildComfyPositivePrompt(job),
      negativePrompt: this.buildNegativePrompt(job),
      samplerName: "dpmpp_2m",
      scheduler: "karras",
    });
  }

  private buildComfySceneWorkflow(job: ImageJob, settings: RenderSettings, checkpoint: string): Record<string, unknown> {
    return this.buildComfyBaseTxt2ImgWorkflow({
      job,
      settings,
      checkpoint,
      positivePrompt: this.buildComfyPositivePrompt(job),
      negativePrompt: this.buildNegativePrompt(job),
      samplerName: "dpmpp_2m_sde",
      scheduler: "karras",
    });
  }

  private buildComfyCharacterSceneWorkflow(
    job: ImageJob,
    settings: RenderSettings,
    checkpoint: string,
    kind: "npc" | "creature",
  ): Record<string, unknown> {
    return this.buildComfyBaseTxt2ImgWorkflow({
      job,
      settings,
      checkpoint,
      positivePrompt: this.buildComfyPositivePrompt(job),
      negativePrompt: this.buildNegativePrompt(job),
      samplerName: kind === "creature" ? "dpmpp_2m_sde" : "dpmpp_2m",
      scheduler: "karras",
    });
  }

  private buildComfyItemWorkflow(job: ImageJob, settings: RenderSettings, checkpoint: string): Record<string, unknown> {
    return this.buildComfyBaseTxt2ImgWorkflow({
      job,
      settings,
      checkpoint,
      positivePrompt: this.buildComfyPositivePrompt(job),
      negativePrompt: this.buildNegativePrompt(job),
      samplerName: "dpmpp_2m",
      scheduler: "karras",
    });
  }

  private buildComfyBaseTxt2ImgWorkflow(args: {
    job: ImageJob;
    settings: RenderSettings;
    checkpoint: string;
    positivePrompt: string;
    negativePrompt: string;
    samplerName: string;
    scheduler: string;
  }): Record<string, unknown> {
    const { job, settings, checkpoint, positivePrompt, negativePrompt, samplerName, scheduler } = args;
    const safePrefix = `rpg_${job.profile}_${job.id}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    return {
      "1": {
        class_type: "CheckpointLoaderSimple",
        inputs: { ckpt_name: checkpoint },
      },
      "2": {
        class_type: "CLIPTextEncode",
        inputs: { text: positivePrompt, clip: ["1", 1] },
      },
      "3": {
        class_type: "CLIPTextEncode",
        inputs: { text: negativePrompt, clip: ["1", 1] },
      },
      "4": {
        class_type: "EmptyLatentImage",
        inputs: { width: settings.width, height: settings.height, batch_size: 1 },
      },
      "5": {
        class_type: "KSampler",
        inputs: {
          seed: job.seed ?? Math.floor(Math.random() * 1_000_000_000),
          steps: settings.steps,
          cfg: settings.guidanceScale,
          sampler_name: samplerName,
          scheduler,
          denoise: 1,
          model: ["1", 0],
          positive: ["2", 0],
          negative: ["3", 0],
          latent_image: ["4", 0],
        },
      },
      "6": {
        class_type: "VAEDecode",
        inputs: { samples: ["5", 0], vae: ["1", 2] },
      },
      "7": {
        class_type: "SaveImage",
        inputs: { filename_prefix: safePrefix, images: ["6", 0] },
      },
    };
  }

  private buildComfyPositivePrompt(job: ImageJob): string {
    switch (job.profile) {
      case "portrait":
        return [
          "professional fantasy RPG player character bust portrait, close portrait crop, face-first composition",
          "normal uncovered face, visible hair, eyes, nose and mouth, head and shoulders only, upper chest clothing visible, no waist, no legs, no feet",
          "plain warm parchment studio background, soft even light, no landscape, no mountains, no outdoor scenery, no weapon, no scene, no helmet covering the face",
          "player written face and clothing descriptions are mandatory and have highest priority",
          job.prompt,
        ].join(", ");
      case "npc":
        return [
          "COMFY NPC WORKFLOW, full body fantasy character in environment",
          "head-to-feet visible, standing in the established RPG scene, scene background visible behind character",
          "cinematic integrated lighting, not a token, not a portrait crop",
          job.prompt,
        ].join(", ");
      case "creature":
        return [
          "COMFY CREATURE WORKFLOW, full body fantasy enemy in environment",
          "head-to-feet visible, creature or enemy centered inside the established RPG scene, background visible",
          "cinematic integrated lighting, threatening silhouette, not a token, not a portrait crop",
          job.prompt,
        ].join(", ");
      case "scene":
        return [
          "COMFY SCENE WORKFLOW, environment establishing shot only",
          "wide cinematic RPG location, no characters, no portrait, no UI",
          job.prompt,
        ].join(", ");
      case "item":
      default:
        return [
          "COMFY ITEM WORKFLOW, single fantasy item illustration",
          "object centered, readable shape and material, simple neutral background",
          job.prompt,
        ].join(", ");
    }
  }

  private getComfyWorkflowName(profile: ImageJob["profile"]): string {
    switch (profile) {
      case "portrait":
        return "portrait-bust-v1";
      case "scene":
        return "scene-establishing-v1";
      case "npc":
        return "npc-fullbody-in-scene-v1";
      case "creature":
        return "creature-fullbody-in-scene-v1";
      case "item":
      default:
        return "item-catalog-v1";
    }
  }

  private async waitForComfyImage(promptId: string): Promise<{ filename: string; subfolder?: string; type?: string }> {
    const startedAt = Date.now();
    const timeout = 900000;

    while (Date.now() - startedAt < timeout) {
      const response = await fetch(this.comfyUrl(`/history/${encodeURIComponent(promptId)}`), {
        signal: AbortSignal.timeout(10000),
      });
      if (response.ok) {
        const history = (await response.json()) as Record<
          string,
          {
            outputs?: Record<string, { images?: Array<{ filename?: string; subfolder?: string; type?: string }> }>;
          }
        >;
        const entry = history[promptId];
        const images = Object.values(entry?.outputs ?? {}).flatMap((output) => output.images ?? []);
        const image = images.find((candidate) => candidate.filename);
        if (image?.filename) {
          return {
            filename: image.filename,
            subfolder: image.subfolder,
            type: image.type,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    throw new Error("ComfyUI generation timed out before returning an image.");
  }

  private comfyUrl(endpoint: string): string {
    return `${config.imageComfyUrl.replace(/\/+$/, "")}${endpoint}`;
  }

  private comfyViewUrl(image: { filename: string; subfolder?: string; type?: string }): string {
    const url = new URL(this.comfyUrl("/view"));
    url.searchParams.set("filename", image.filename);
    url.searchParams.set("subfolder", image.subfolder ?? "");
    url.searchParams.set("type", image.type ?? "output");
    return url.toString();
  }

  private buildNegativePrompt(job: ImageJob): string {
    return [negativePromptByProfile[job.profile], job.negativePrompt]
      .filter(Boolean)
      .join(", ");
  }

  private getComfyRenderSettings(profile: ImageJob["profile"]): RenderSettings {
    switch (profile) {
      case "portrait":
        return { width: 640, height: 768, steps: 22, guidanceScale: 7.2 };
      case "scene":
        return { width: 1152, height: 704, steps: 26, guidanceScale: 6.4 };
      case "item":
        return { width: 768, height: 768, steps: 20, guidanceScale: 6 };
      case "npc":
        return { width: 768, height: 1024, steps: 24, guidanceScale: 6.1 };
      case "creature":
        return { width: 832, height: 1024, steps: 24, guidanceScale: 6.2 };
      default:
        return { width: 768, height: 1024, steps: 24, guidanceScale: 6.1 };
    }
  }

  private getRenderSettings(profile: ImageJob["profile"]): RenderSettings {
    const useCpuPreset = this.pythonRuntimeDevice !== "cuda";

    if (useCpuPreset && config.imageFastMode) {
      switch (profile) {
        case "scene":
          return { width: 640, height: 384, steps: 6, guidanceScale: 5.5 };
        case "item":
          return { width: 512, height: 512, steps: 6, guidanceScale: 5.5 };
        case "portrait":
        case "npc":
        case "creature":
        default:
          return profile === "portrait"
            ? { width: 640, height: 640, steps: 10, guidanceScale: 5.8 }
            : { width: 512, height: 512, steps: 7, guidanceScale: 5.5 };
      }
    }

    switch (profile) {
      case "portrait":
        return useCpuPreset
          ? { width: 768, height: 768, steps: 14, guidanceScale: 6.5 }
          : { width: 1024, height: 1024, steps: 26, guidanceScale: 7.2 };
      case "scene":
        return useCpuPreset
          ? { width: 768, height: 512, steps: 10, guidanceScale: 6 }
          : { width: 1344, height: 768, steps: 28, guidanceScale: 7 };
      case "item":
        return useCpuPreset
          ? { width: 512, height: 512, steps: 8, guidanceScale: 6 }
          : { width: 768, height: 768, steps: 24, guidanceScale: 7 };
      default:
        return useCpuPreset
          ? { width: 768, height: 768, steps: 10, guidanceScale: 6 }
          : { width: 1024, height: 1024, steps: 24, guidanceScale: 7 };
    }
  }

  private async runPythonSnippet(code: string, payload?: string, timeout = 20000): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ["-c", code];
      if (payload) {
        args.push(payload);
      }

      const child = spawn(config.imagePythonExecutable, args, {
        cwd: config.imageRuntimeDir,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Python SDXL runtime timed out after ${timeout}ms.`));
      }, timeout);

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });

      child.on("close", (codeValue) => {
        clearTimeout(timer);
        if (codeValue !== 0) {
          reject(new Error(stderr.trim() || stdout.trim() || `Python exited with code ${codeValue}`));
          return;
        }

        const lastLine = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .at(-1);

        if (!lastLine) {
          reject(new Error("Python SDXL runtime produced no output."));
          return;
        }

        resolve(lastLine);
      });
    });
  }
}
