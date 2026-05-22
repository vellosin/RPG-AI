import type { SceneNpc } from "./types.js";
import { config } from "../config.js";

/**
 * Mapeia perfis de voz para arquivos de modelo Piper.
 *
 * Filosofia:
 * - "gm-narrator" é a voz padrão do Mestre, calma e quente.
 * - NPCs ganham timbres distintos derivados de classe/raça/role.
 * - Quem não tem voz dedicada cai pro fallback gm-narrator — nada quebra.
 *
 * Os caminhos vêm do config (vars de ambiente). Se uma voz não estiver definida,
 * o catálogo retorna `null` e o engine emite a frase sem áudio.
 */

export type VoiceProfile =
  | "gm-narrator"
  | "npc-gruff"
  | "npc-mystic"
  | "npc-merchant"
  | "npc-child"
  | "npc-villain";

export type VoiceConfig = {
  profile: VoiceProfile;
  modelPath: string | null;
  /** Velocidade de leitura (1.0 = normal, 0.85 = lento, 1.15 = rápido). */
  lengthScale: number;
  /** Variação de pitch (Piper interpreta dentro de limites estreitos). */
  noiseScale: number;
};

/**
 * Tabela mestra. Pode ser estendida sem mexer no código que consome.
 */
const buildCatalog = (): Record<VoiceProfile, VoiceConfig> => ({
  "gm-narrator": {
    profile: "gm-narrator",
    modelPath: config.ttsVoiceGm || null,
    lengthScale: 1.28,
    noiseScale: 0.58,
  },
  "npc-gruff": {
    profile: "npc-gruff",
    modelPath: config.ttsVoiceNpcGruff || config.ttsVoiceGm || null,
    lengthScale: 1.18,
    noiseScale: 0.62,
  },
  "npc-mystic": {
    profile: "npc-mystic",
    modelPath: config.ttsVoiceNpcMystic || config.ttsVoiceGm || null,
    lengthScale: 1.32,
    noiseScale: 0.55,
  },
  "npc-merchant": {
    profile: "npc-merchant",
    modelPath: config.ttsVoiceNpcMerchant || config.ttsVoiceGm || null,
    lengthScale: 1.16,
    noiseScale: 0.62,
  },
  "npc-child": {
    profile: "npc-child",
    modelPath: config.ttsVoiceNpcChild || config.ttsVoiceGm || null,
    lengthScale: 1.2,
    noiseScale: 0.66,
  },
  "npc-villain": {
    profile: "npc-villain",
    modelPath: config.ttsVoiceNpcVillain || config.ttsVoiceGm || null,
    lengthScale: 1.25,
    noiseScale: 0.58,
  },
});

let cachedCatalog: Record<VoiceProfile, VoiceConfig> | null = null;

export const getVoiceConfig = (profile: VoiceProfile): VoiceConfig => {
  if (!cachedCatalog) cachedCatalog = buildCatalog();
  return cachedCatalog[profile] ?? cachedCatalog["gm-narrator"];
};

/**
 * Recarrega o catálogo (chamar se o config mudar em runtime, ex: hot reload).
 */
export const resetVoiceCatalogCache = (): void => {
  cachedCatalog = null;
};

/**
 * Heurística determinística: dada a ficha de um NPC, inferimos uma voz.
 * Mestre roteia automático sem precisar declarar voz explícita.
 */
export const inferVoiceProfile = (npc: Pick<SceneNpc, "name" | "role" | "className" | "race" | "description">): VoiceProfile => {
  const haystack = [
    npc.name ?? "",
    npc.role ?? "",
    npc.className ?? "",
    npc.race ?? "",
    npc.description ?? "",
  ].join(" ").toLowerCase();

  // Vilões/antagonistas explícitos ganham voz dura.
  if (/\b(vil[aã]o|antagonista|tirano|necr[oô]mante|dark lord|chefe|boss)\b/.test(haystack)) {
    return "npc-villain";
  }

  // Crianças têm voz própria.
  if (/\b(crian[çc]a|menino|menina|garoto|garota|filho|filha)\b/.test(haystack)) {
    return "npc-child";
  }

  // Magos, sacerdotes, druidas → místico.
  if (/\b(mago|maga|wizard|feiticeiro|bruxo|sorcerer|clerigo|cl[eé]rigo|cleric|druida|druid|or[aá]culo|m[aá]gico|sage)\b/.test(haystack)) {
    return "npc-mystic";
  }

  // Mercadores, taverneiros, comerciantes.
  if (/\b(mercador|comerciante|merchant|taverneiro|estalajadeiro|innkeeper|vendedor|loja)\b/.test(haystack)) {
    return "npc-merchant";
  }

  // Guerreiros, bárbaros, soldados, ferreiros → bruto.
  if (/\b(guerreiro|fighter|b[aá]rbaro|barbarian|soldado|guarda|sentinela|ferreiro|smith|capit[aã]o|warrior)\b/.test(haystack)) {
    return "npc-gruff";
  }

  // Default cai pra narrador.
  return "gm-narrator";
};
