import type { BattleIntensity, CharacterCreation, EnemyDifficulty, GmKindness, InventoryState, Player, PlayerLoreEvent, RoomSetup } from "./types.js";
import { defaultResourcesForFeatures } from "./player-resources.js";
import { buildInitialPlayerLore, defaultMoralProfile } from "./player-lore.js";
import { selectMonsterEncounter } from "./monster-catalog.js";
import { visualLocksFromPortuguese } from "./image-prompt-refiner.js";

type ClassTemplate = {
  className: string;
  hitDie: number;
  abilities: Record<string, number>;
  skills: Record<string, number>;
  armorClass: number;
  spells: string[];
  features: string[];
  equipped: string[];
  backpack: string[];
};

type VisualProfile = {
  physicalDescription: string;
  weaponDescription: string;
  outfitDescription: string;
  appearanceDescription: string;
};

type PortraitPresetName = "fighter" | "rogue" | "wizard" | "cleric" | "ranger" | "bard" | "paladin" | "druid";

type PortraitPromptSpec = {
  presetName: PortraitPresetName;
  prompt: string;
  negativePrompt: string;
  seed: number;
  framing: "full-body" | "token" | "portrait";
  weaponPolicy: "secondary" | "visible" | "not_visible";
};

const proficiencyBonusByLevel = (level: number): number => (level >= 5 ? 3 : 2);

const abilityModifier = (score: number): number => Math.floor(((score ?? 10) - 10) / 2);

export const experienceThresholdsByLevel: Record<number, number> = {
  1: 0,
  2: 300,
  3: 900,
  4: 2700,
  5: 6500,
  6: 14000,
  7: 23000,
  8: 34000,
  9: 48000,
  10: 64000,
  11: 85000,
  12: 100000,
  13: 120000,
  14: 140000,
  15: 165000,
  16: 195000,
  17: 225000,
  18: 265000,
  19: 305000,
  20: 355000,
};

export const levelForExperience = (xp: number): number => {
  const safeXp = Math.max(0, Math.floor(xp));
  let level = 1;
  for (const [rawLevel, threshold] of Object.entries(experienceThresholdsByLevel)) {
    const candidate = Number(rawLevel);
    if (safeXp >= threshold && candidate > level) level = candidate;
  }
  return level;
};

export const nextLevelExperience = (level: number): number | null => experienceThresholdsByLevel[level + 1] ?? null;

const hitPointGainForLevel = (className: string, constitutionScore: number): number => {
  const template = classTemplates[className] ?? classTemplates.Fighter;
  const constitutionModifier = Math.floor(((constitutionScore ?? 10) - 10) / 2);
  return Math.max(1, Math.floor(template.hitDie / 2) + 1 + constitutionModifier);
};

const levelOneFeatures: Record<string, string[]> = {
  Fighter: ["Second Wind", "Fighting Style"],
  Rogue: ["Sneak Attack", "Thieves' Cant", "Expertise"],
  Wizard: ["Spellcasting", "Arcane Recovery", "Ritual Casting"],
  Cleric: ["Spellcasting", "Divine Domain"],
  Ranger: ["Favored Enemy", "Natural Explorer"],
  Bard: ["Bardic Inspiration", "Spellcasting"],
  Paladin: ["Divine Sense", "Lay on Hands"],
  Druid: ["Spellcasting", "Druidic"],
};

const levelFeatures: Record<string, Record<number, string[]>> = {
  Fighter: {
    2: ["Action Surge"],
    3: ["Martial Archetype"],
  },
  Rogue: {
    2: ["Cunning Action"],
    3: ["Roguish Archetype"],
  },
  Wizard: {
    2: ["Arcane Tradition"],
    3: ["2nd-level Spells"],
  },
  Cleric: {
    2: ["Channel Divinity"],
    3: ["2nd-level Spells"],
  },
  Ranger: {
    2: ["Ranger Spellcasting"],
    3: ["Ranger Archetype", "Primeval Awareness"],
  },
  Bard: {
    2: ["Jack of All Trades", "Song of Rest"],
    3: ["Bard College", "Expertise"],
  },
  Paladin: {
    2: ["Fighting Style", "Divine Smite", "Paladin Spellcasting"],
    3: ["Divine Health", "Sacred Oath"],
  },
  Druid: {
    2: ["Wild Shape", "Druid Circle"],
    3: ["2nd-level Spells"],
  },
};

const pendingLevelUpsFor = (currentLevel: number, xp: number): number => Math.max(0, levelForExperience(xp) - currentLevel);

const normalizeClassLevels = (player: Pick<Player, "className" | "level"> & Partial<Pick<Player, "classLevels">>): Record<string, number> => {
  const entries = Object.entries(player.classLevels ?? {})
    .filter(([, value]) => Number(value) > 0)
    .map(([key, value]) => [key, Math.max(1, Math.floor(Number(value)))]);
  if (entries.length === 0) return { [player.className]: Math.max(1, player.level) };
  return Object.fromEntries(entries);
};

export const calculateArmorClass = (
  attributes: Record<string, number>,
  inventory: InventoryState,
): number => {
  const agilityModifier = abilityModifier(attributes.agility ?? 10);
  const equippedText = inventory.equipped.join(" | ").toLowerCase();
  const shieldBonus = /\bshield\b|escudo/.test(equippedText) ? 2 : 0;

  let armorBase = 10;
  let agilityCap: number | null = null;

  if (/plate mail|armadura de placas/.test(equippedText)) {
    armorBase = 18;
    agilityCap = 0;
  } else if (/chain mail|cota de malha/.test(equippedText)) {
    armorBase = 16;
    agilityCap = 0;
  } else if (/scale mail|cota de escamas/.test(equippedText)) {
    armorBase = 14;
    agilityCap = 2;
  } else if (/chain shirt|camisola de cota/.test(equippedText)) {
    armorBase = 13;
    agilityCap = 2;
  } else if (/studded leather|couro cravejado/.test(equippedText)) {
    armorBase = 12;
  } else if (/leather armor|armadura de couro|\bcouro\b/.test(equippedText)) {
    armorBase = 11;
  }

  const appliedAgilityModifier = agilityCap === 0 ? 0 : agilityCap === null ? agilityModifier : Math.min(agilityModifier, agilityCap);
  return armorBase + appliedAgilityModifier + shieldBonus;
};

export const applyExperienceToPlayer = (player: Player, xpGained: number): { player: Player; leveledUp: boolean; fromLevel: number; toLevel: number; xpGained: number } => {
  const fromLevel = player.level;
  const totalXp = Math.max(0, Math.floor((player.experiencePoints ?? experienceThresholdsByLevel[fromLevel] ?? 0) + xpGained));
  const availableLevel = levelForExperience(totalXp);
  const pendingLevelUps = pendingLevelUpsFor(fromLevel, totalXp);
  const updated: Player = {
    ...player,
    classLevels: normalizeClassLevels(player),
    experiencePoints: totalXp,
    nextLevelExperience: nextLevelExperience(fromLevel),
    pendingLevelUps,
  };

  return { player: updated, leveledUp: pendingLevelUps > 0, fromLevel, toLevel: Math.max(fromLevel, availableLevel), xpGained };
};

export type LevelUpChoice = {
  className: string;
  newSkillProficiencies?: string[];
  newSpells?: string[];
  source?: string;
};

export const applyLevelUpChoice = (player: Player, choice: LevelUpChoice): { player: Player; fromLevel: number; toLevel: number; classLevel: number; hpGain: number; featuresGained: string[]; spellsGained: string[]; skillsGained: string[] } => {
  const className = choice.className;
  if (!classTemplates[className]) throw new Error(`Classe inválida: ${className}`);
  if ((player.pendingLevelUps ?? 0) <= 0) throw new Error("Este personagem ainda não tem XP suficiente para subir de nível.");

  const currentClassLevels = normalizeClassLevels(player);
  const knownClasses = Object.keys(currentClassLevels);
  if (!currentClassLevels[className] && knownClasses.length >= 2) {
    throw new Error("Multiclasse limitada a no máximo 2 classes diferentes.");
  }

  const fromLevel = player.level;
  const toLevel = fromLevel + 1;
  const classLevel = (currentClassLevels[className] ?? 0) + 1;
  const nextClassLevels = { ...currentClassLevels, [className]: classLevel };
  const hpGain = hitPointGainForLevel(className, player.attributes.constitution ?? 10);
  const featuresGained = classLevel === 1 ? (levelOneFeatures[className] ?? []) : (levelFeatures[className]?.[classLevel] ?? []);
  const allowedSkillChoices = classSkillChoices[className]?.options ?? [];
  const allowedSpellChoices = classSpellChoices[className]?.options ?? [];
  const skillLimit = currentClassLevels[className] ? 1 : Math.min(2, classSkillChoices[className]?.count ?? 0);
  const spellLimit = classSpellChoices[className]?.count ? (classLevel === 1 ? classSpellChoices[className].count : 2) : 0;
  const requestedSkills = [...new Set(choice.newSkillProficiencies ?? [])];
  const requestedSpells = [...new Set(choice.newSpells ?? [])];
  const invalidSkills = requestedSkills.filter((skill) => !allowedSkillChoices.some((allowed) => allowed.toLowerCase() === skill.toLowerCase()));
  const invalidSpells = requestedSpells.filter((spell) => !allowedSpellChoices.includes(spell));
  if (invalidSkills.length > 0) throw new Error(`Pericias invalidas para ${className}: ${invalidSkills.join(", ")}`);
  if (invalidSpells.length > 0) throw new Error(`Magias invalidas para ${className}: ${invalidSpells.join(", ")}`);
  if (requestedSkills.length > skillLimit) throw new Error(`${className} pode escolher no maximo ${skillLimit} pericia(s) neste level up.`);
  if (requestedSpells.length > spellLimit) throw new Error(`${className} pode escolher no maximo ${spellLimit} magia(s) neste level up.`);
  const skillsGained = requestedSkills.filter((skill) => !Object.prototype.hasOwnProperty.call(player.skills, skill.toLowerCase()));
  const spellsGained = requestedSpells.filter((spell) => !player.spells.includes(spell));
  const newFeatures = [...new Set([...player.features, ...featuresGained])];
  const newSkills = { ...player.skills };
  for (const skillName of skillsGained) {
    const key = skillName.toLowerCase();
    const attr = skillAttributeMap[key] ?? skillAttributeMap[skillName];
    const attrMod = attr ? Math.floor(((player.attributes[attr] ?? 10) - 10) / 2) : 0;
    newSkills[key] = proficiencyBonusByLevel(toLevel) + attrMod;
  }

  const loreEvent: PlayerLoreEvent = {
    id: `level-${player.id}-${toLevel}-${Date.now()}`,
    category: "achievement",
    title: `Subiu para o nivel ${toLevel}`,
    summary: `${player.characterName} subiu do nivel ${fromLevel} para o nivel ${toLevel}, escolhendo ${className} ${classLevel}. ${choice.source ?? "Marco de experiencia obtido em aventura."}`,
    importance: toLevel >= 3 ? "major" : "notable",
    consequence: `Ficha atualizada: +${hpGain} HP maximo${featuresGained.length ? `; novas caracteristicas: ${featuresGained.join(", ")}` : ""}.`,
    createdAt: new Date().toISOString(),
  };

  return {
    player: {
      ...player,
      className: Object.entries(nextClassLevels).sort((a, b) => b[1] - a[1])[0]?.[0] ?? className,
      classLevels: nextClassLevels,
      level: toLevel,
      pendingLevelUps: Math.max(0, (player.pendingLevelUps ?? 0) - 1),
      nextLevelExperience: nextLevelExperience(toLevel),
      proficiencyBonus: proficiencyBonusByLevel(toLevel),
      maxHitPoints: player.maxHitPoints + hpGain,
      hitPoints: player.hitPoints + hpGain,
      features: newFeatures,
      spells: [...new Set([...player.spells, ...spellsGained])],
      skills: newSkills,
      resources: defaultResourcesForFeatures(newFeatures),
      loreEvents: [...(player.loreEvents ?? []), loreEvent].slice(-40),
    },
    fromLevel,
    toLevel,
    classLevel,
    hpGain,
    featuresGained,
    spellsGained,
    skillsGained,
  };
};

export const validatePointBuyAllocation = (attributes: Record<string, number>): { ok: boolean; spent: number; remaining: number; message?: string } => {
  const keys = ["strength", "agility", "mind", "presence", "constitution", "wisdom"];
  const spent = keys.reduce((sum, key) => sum + (POINT_BUY_COSTS[attributes[key]] ?? 999), 0);
  const remaining = POINT_BUY_BUDGET - spent;
  if (keys.some((key) => attributes[key] === undefined)) {
    return { ok: false, spent, remaining, message: "Todos os atributos precisam ser definidos." };
  }
  if (remaining !== 0) {
    return { ok: false, spent, remaining, message: `Use exatamente ${POINT_BUY_BUDGET} pontos de atributo. Restam ${remaining}.` };
  }
  return { ok: true, spent, remaining };
};

const classTemplates: Record<string, ClassTemplate> = {
  Fighter: {
    className: "Fighter",
    hitDie: 10,
    abilities: { strength: 16, agility: 12, mind: 10, presence: 10, constitution: 14, wisdom: 11 },
    skills: { athletics: 5, awareness: 2, intimidation: 3, melee: 5, survival: 2 },
    armorClass: 17,
    spells: [],
    features: ["Second Wind", "Fighting Style"],
    equipped: ["Longsword", "Shield", "Chain Mail"],
    backpack: ["Torch", "Rations", "Rope"],
  },
  Rogue: {
    className: "Rogue",
    hitDie: 8,
    abilities: { strength: 10, agility: 16, mind: 12, presence: 13, constitution: 12, wisdom: 12 },
    skills: { stealth: 5, investigation: 4, awareness: 4, acrobatics: 5, melee: 4, persuasion: 2 },
    armorClass: 15,
    spells: [],
    features: ["Sneak Attack", "Thieves' Cant", "Expertise"],
    equipped: ["Rapier", "Shortbow", "Leather Armor"],
    backpack: ["Lockpicks", "Dagger", "Caltrops"],
  },
  Wizard: {
    className: "Wizard",
    hitDie: 6,
    abilities: { strength: 8, agility: 13, mind: 16, presence: 11, constitution: 12, wisdom: 14 },
    skills: { arcana: 5, history: 4, investigation: 4, awareness: 2, persuasion: 1 },
    armorClass: 12,
    spells: ["Magic Missile", "Shield", "Mage Armor", "Fire Bolt"],
    features: ["Arcane Recovery", "Spellcasting", "Ritual Casting"],
    equipped: ["Quarterstaff", "Spellbook", "Focus Wand"],
    backpack: ["Ink", "Component Pouch", "Rations"],
  },
  Cleric: {
    className: "Cleric",
    hitDie: 8,
    abilities: { strength: 13, agility: 10, mind: 12, presence: 12, constitution: 14, wisdom: 16 },
    skills: { religion: 5, insight: 4, medicine: 4, persuasion: 2, melee: 3 },
    armorClass: 16,
    spells: ["Guiding Bolt", "Healing Word", "Sacred Flame", "Bless"],
    features: ["Spellcasting", "Divine Domain"],
    equipped: ["Mace", "Shield", "Scale Mail", "Holy Symbol"],
    backpack: ["Healer's Kit", "Torch", "Prayer Book"],
  },
  Ranger: {
    className: "Ranger",
    hitDie: 10,
    abilities: { strength: 13, agility: 15, mind: 11, presence: 10, constitution: 13, wisdom: 14 },
    skills: { survival: 5, perception: 4, athletics: 3, stealth: 3, nature: 2 },
    armorClass: 14,
    spells: ["Hunter's Mark", "Cure Wounds"],
    features: ["Favored Enemy", "Natural Explorer"],
    equipped: ["Longbow", "Shortsword", "Studded Leather"],
    backpack: ["Quiver (20 arrows)", "Hunting Trap", "Waterskin"],
  },
  Bard: {
    className: "Bard",
    hitDie: 8,
    abilities: { strength: 9, agility: 14, mind: 13, presence: 16, constitution: 12, wisdom: 11 },
    skills: { performance: 5, persuasion: 5, deception: 4, insight: 3, investigation: 2 },
    armorClass: 13,
    spells: ["Vicious Mockery", "Healing Word", "Charm Person", "Thunderwave"],
    features: ["Bardic Inspiration", "Spellcasting"],
    equipped: ["Rapier", "Lute", "Leather Armor"],
    backpack: ["Disguise Kit", "Torch", "Book of Songs"],
  },
  Paladin: {
    className: "Paladin",
    hitDie: 10,
    abilities: { strength: 16, agility: 10, mind: 10, presence: 14, constitution: 14, wisdom: 11 },
    skills: { athletics: 4, persuasion: 4, religion: 3, insight: 3, medicine: 2 },
    armorClass: 18,
    spells: ["Divine Smite", "Cure Wounds", "Shield of Faith", "Bless"],
    features: ["Divine Sense", "Lay on Hands"],
    equipped: ["Longsword", "Shield", "Plate Mail", "Holy Symbol"],
    backpack: ["Healer's Kit", "Holy Water", "Prayer Book"],
  },
  Druid: {
    className: "Druid",
    hitDie: 8,
    abilities: { strength: 10, agility: 12, mind: 13, presence: 11, constitution: 13, wisdom: 16 },
    skills: { nature: 5, perception: 4, insight: 3, medicine: 3, survival: 4 },
    armorClass: 13,
    spells: ["Shillelagh", "Cure Wounds", "Entangle", "Thunderstrike"],
    features: ["Spellcasting", "Druidic"],
    equipped: ["Quarterstaff", "Leather Armor", "Druidic Focus"],
    backpack: ["Healer's Kit", "Torch", "Herbalism Kit"],
  },
};

const speciesBonuses: Record<string, Partial<Record<string, number>>> = {
  Human: { strength: 1, agility: 1, mind: 1, presence: 1, constitution: 1, wisdom: 1 },
  Elf: { agility: 2, mind: 1 },
  Dwarf: { constitution: 2, wisdom: 1 },
  Halfling: { agility: 2, presence: 1 },
};

const backgroundItems: Record<string, string[]> = {
  Soldier: ["Insignia", "Dice Set"],
  Scholar: ["Notebook", "Reference Scroll"],
  Acolyte: ["Prayer Beads", "Incense"],
  Outlander: ["Hunting Trap", "Waterskin"],
  Entertainer: ["Costume", "Musical Instrument"],
  Hermit: ["Herbalism Kit", "Wooden Carving"],
};

const speciesVisualDefaults: Record<string, string> = {
  Human: "humano de traços versáteis, porte resoluto e feições marcantes de aventureiro experiente",
  Elf: "elfo de corpo esguio, orelhas longas, rosto refinado e presença serena porém vigilante",
  Dwarf: "anão robusto, ombros largos, barba ou tranças trabalhadas e expressão endurecida por jornadas difíceis",
  Halfling: "halfling ágil, estatura baixa, traços vivos, sorriso astuto e energia inquieta de explorador",
};

const speciesVisualDefaultsByGender: Record<string, Partial<Record<"male" | "female", string>>> = {
  Dwarf: {
    male: "anão robusto, ombros largos, barba trabalhada ou trançada e expressão endurecida por jornadas difíceis",
    female: "anã robusta, ombros largos, tranças trabalhadas ou cabelo espesso e expressão endurecida por jornadas difíceis",
  },
};

const classWeaponDefaults: Record<string, string> = {
  Fighter: "longsword and shield held in a disciplined battlefield stance",
  Rogue: "rapier ready for a precise strike with a backup dagger at the belt",
  Wizard: "quarterstaff and arcane focus carried like ritual tools of a battle mage",
  Cleric: "mace and holy symbol carried with protective resolve",
  Ranger: "longbow held naturally at side with quiver at hip",
  Bard: "lute or rapier held casually at the side",
  Paladin: "longsword sheathed at hip and holy symbol on chest",
  Druid: "wooden staff held upright as a walking focus",
};

const speciesPromptDescriptors: Record<string, string> = {
  Human: "human",
  Elf: "elf with subtle pointed ears",
  Dwarf: "dwarf with sturdy features",
  Halfling: "halfling with small folk features",
};

const portraitSpeciesDescriptor = (species: string, gender: "male" | "female"): string => {
  if (species === "Dwarf" && gender === "female") {
    return "beardless female dwarf woman, mature stocky fantasy woman with compact proportions";
  }
  return speciesPromptDescriptors[species] ?? species.toLowerCase();
};

const classPromptDescriptors: Record<string, string> = {
  Fighter: "fighter, martial warrior",
  Rogue: "rogue, agile infiltrator",
  Wizard: "wizard, arcane scholar",
  Cleric: "cleric, divine spellcaster",
  Ranger: "ranger, wilderness hunter",
  Bard: "bard, charismatic performer",
  Paladin: "paladin, holy knight",
  Druid: "druid, nature mystic",
};

const speciesPortraitLocks: Record<string, string> = {
  Human: "human facial proportions, grounded realistic fantasy adventurer face",
  Elf: "(elf identity:1.45), graceful angular face, subtle pointed ears visible through hair, refined cheekbones, not human ears",
  Dwarf: "(dwarf identity:1.65), compact stocky dwarven proportions, broad square face, thick neck, strong nose, sturdy head and shoulders, unmistakably dwarven",
  Halfling: "(halfling identity:1.55), small folk facial proportions, round lively face, compact shoulders, warm alert expression, not a tall human",
};

const speciesGenderPortraitLocks: Record<string, Partial<Record<"male" | "female", string>>> = {
  Dwarf: {
    male: "male dwarf traits: full thick beard or braided beard, rugged masculine dwarven face",
    female: "(beardless female dwarf woman:2.2), (mature stocky fantasy woman:1.9), broad square face, strong wide nose, thick neck, rounded ears, rugged adult feminine face, smooth clean chin, visible mouth and chin, braided thick hair, strong adult woman features, compact body type",
  },
};

const speciesPortraitNegatives: Record<string, string[]> = {
  Human: ["pointed ears", "dwarf beard braids", "halfling childlike proportions"],
  Elf: ["round human ears", "dwarf proportions", "stocky dwarf face", "halfling proportions"],
  Dwarf: ["tall human", "slim human face", "young pretty human girl", "teenage girl", "clean fashionable human hero", "narrow neck", "thin shoulders", "elf ears", "pointed ears", "long pointed ears", "halfling childlike face", "facial hair", "long beard", "white beard", "beard covering chin"],
  Halfling: ["tall human", "dwarf heavy beard", "elf ears", "large heroic warrior body"],
};

const classPortraitLocks: Record<string, { positive: string; negative: string[] }> = {
  Fighter: {
    positive: "(fighter identity:1.45), disciplined martial adventurer, practical battle-worn armor or gambeson, utilitarian straps, soldierly posture",
    negative: ["nature priest", "wizard robes", "holy vestments", "performer costume"],
  },
  Rogue: {
    positive: "(rogue identity:1.45), agile infiltrator, dark practical hood or scarf, fitted leather or cloth layers, lockpicks and small belt pouches, quiet streetwise expression",
    negative: ["heavy armor", "plate armor", "holy knight", "nature priest", "scholar robe"],
  },
  Wizard: {
    positive: "(wizard identity:1.5), arcane scholar, layered mage robes, subtle embroidered arcane patterns, component pouch, thoughtful intelligent expression, no armor",
    negative: ["fighter armor", "military cuirass", "paladin armor", "ranger leather armor", "druid leaves"],
  },
  Cleric: {
    positive: "(cleric identity:1.5), divine spellcaster, travel-worn vestments, sacred symbol, humble protective presence, simple ritual ornaments",
    negative: ["fighter armor", "rogue hood", "wizard academic robe without holy symbol", "bard costume"],
  },
  Ranger: {
    positive: "(ranger identity:1.45), wilderness tracker, weathered green and brown trail clothes, fur or canvas shoulder layer, quiver strap or survival pouches, outdoorsman look",
    negative: ["plate armor", "formal noble clothing", "wizard robe", "temple vestments"],
  },
  Bard: {
    positive: "(bard identity:1.45), charismatic travelling performer, colorful but practical clothes, scarf or sash, small instrument strap or decorative brooch, expressive face",
    negative: ["heavy armor", "plain soldier uniform", "druidic leaves", "wizard scholar robe"],
  },
  Paladin: {
    positive: "(paladin identity:1.5), holy knight, polished but battle-worn armor, visible sacred symbol, noble stern bearing, radiant devotional details",
    negative: ["ragged druid robes", "rogue hood", "wizard robe", "peasant clothes"],
  },
  Druid: {
    positive: "(druid identity:1.75), nature mystic, wild wise presence, rough-spun earth tone robes, moss green and bark brown cloth, leaf stitching, wooden beads, bone or seed charms, natural leather cord, druidic focus pendant, no military armor",
    negative: ["fighter", "warrior", "soldier", "paladin", "knight", "military uniform", "leather cuirass", "red leather armor", "metal armor", "metal pauldrons", "shoulder armor", "breastplate", "chainmail", "plate armor", "polished armor", "noble cloak", "courtly clothing"],
  },
};

const classPortraitOutfits: Record<string, string> = {
  Fighter: "practical battle-worn gambeson or armor, muted metal or quilted fabric, disciplined adventurer silhouette",
  Rogue: "dark fitted cloth and soft leather layers, hood or scarf, belt pouches, quiet practical infiltrator outfit",
  Wizard: "layered mage robes, cloth mantle, subtle arcane embroidery, component pouch, no armor",
  Cleric: "travel-worn vestments and simple protective cloth layers, visible sacred symbol, humble ritual details",
  Ranger: "weathered green and brown trail clothes, canvas or fur shoulder layer, survival straps and pouches",
  Bard: "colorful practical travelling clothes, scarf or sash, decorative but road-worn performer details",
  Paladin: "battle-worn holy armor with sacred symbol, restrained devotional ornament, noble protective silhouette",
  Druid: "rough-spun earth tone druid robes, moss green and bark brown cloth, leaf stitching, wooden beads, bone or seed charms, natural leather cord, no metal armor",
};

const genderPortraitDefaults: Record<"male" | "female", string[]> = {
  male: [
    "masculine adult face, practical expression, grounded fantasy realism",
    "adult male adventurer, defined jaw, lived-in expression, not youthful glamour",
    "mature masculine presence, weathered eyes, believable adventurer features",
  ],
  female: [
    "(adult woman:1.7), feminine adult face, smooth hairless chin, practical expression, grounded fantasy realism",
    "(adult woman:1.7), adult female adventurer, strong readable features, lived-in expression, not beauty glamour, smooth clean chin",
    "(adult woman:1.7), mature feminine presence, weathered eyes, believable adventurer features, smooth chin",
  ],
};

const speciesPortraitVariants: Record<string, string[]> = {
  Human: [
    "human facial proportions, natural skin texture, grounded realistic fantasy face",
    "recognizably human adventurer, balanced facial structure, practical road-worn expression",
    "human face with distinctive but believable features, no exaggerated fantasy anatomy",
  ],
  Elf: [
    "slender elven face, visible pointed ears, refined cheekbones, calm watchful eyes",
    "angular elf features, subtle pointed ears through the hair, elegant long-lived expression",
    "graceful elven facial structure, narrow jaw, visible pointed ears, serene alert gaze",
  ],
  Dwarf: [
    "unmistakable dwarf, broad square face, thick neck, strong nose, compact powerful shoulders",
    "stocky dwarven head and shoulders, wide jaw, sturdy nose, carved-stone expression, deep-set eyes",
    "classic dwarf features, compact powerful build visible in shoulders, thick braided hair, grounded dwarven presence",
  ],
  Halfling: [
    "small folk face, round lively features, compact shoulders, warm alert eyes",
    "halfling proportions, shorter compact build implied by shoulders, friendly but sharp expression",
    "recognizably halfling, round cheeks, bright eyes, compact adventurer silhouette",
  ],
};

const classPortraitVariants: Record<string, string[]> = {
  Fighter: [
    "fighter visual base, quilted gambeson and scuffed practical armor, disciplined soldier posture",
    "fighter visual base, battle-worn martial clothing, reinforced straps, no noble polish",
    "fighter visual base, practical frontline adventurer gear, stern readiness, simple protective layers",
  ],
  Rogue: [
    "rogue visual base, fitted dark cloth, soft leather straps, hood or scarf, small belt pouches",
    "rogue visual base, quiet infiltrator outfit, shadow-colored layers, nimble streetwise look",
    "rogue visual base, practical thief garb, concealed pockets, lean stealth silhouette",
  ],
  Wizard: [
    "wizard visual base, layered robes, subtle arcane embroidery, component pouch, no armor",
    "wizard visual base, scholar-mage clothing, worn mantle, ink stains or small arcane charms",
    "wizard visual base, composed arcane robes, simple magical focus pendant, thoughtful gaze",
  ],
  Cleric: [
    "cleric visual base, travel-worn vestments, sacred symbol, humble protective presence",
    "cleric visual base, devotional robes over practical road clothing, simple ritual ornaments",
    "cleric visual base, healer-priest outfit, worn holy symbol, calm resilient face",
  ],
  Ranger: [
    "ranger visual base, green and brown trail clothes, canvas or fur shoulder layer, survival pouches",
    "ranger visual base, weathered wilderness clothing, muted natural colors, tracker silhouette",
    "ranger visual base, forest scout outfit, worn cloak, quiver strap implied but no visible weapon",
  ],
  Bard: [
    "bard visual base, colorful road-worn performer clothes, scarf or sash, expressive face",
    "bard visual base, travelling artist outfit, decorative trim, practical boots and charm",
    "bard visual base, stylish but weathered clothes, small musical token, confident expression",
  ],
  Paladin: [
    "paladin visual base, holy armor, sacred symbol, restrained radiant details, noble stern bearing",
    "paladin visual base, battle-worn devotional armor, clean sacred emblem, protective presence",
    "paladin visual base, knightly religious gear, polished but used metal, solemn purpose",
  ],
  Druid: [
    "druid visual base, rough-spun earth tone robes, moss green and bark brown cloth, leaf stitching, wooden beads",
    "druid visual base, wild nature mystic clothing, woven plant fibers, seed charms, simple natural cords",
    "druid visual base, forest hermit robes, weathered linen, bark-like textures, bone or seed ornaments, no metal armor",
  ],
};

const backgroundOutfitDefaults: Record<string, string> = {
  Soldier: "weathered military armor, travel cloak, reinforced boots and campaign gear",
  Scholar: "layered academic robes adapted for the road, satchel of notes and practical belt pouches",
  Acolyte: "ceremonial vestments, sacred ornaments, layered fabric and devotional accessories",
  Outlander: "rugged trail leathers, fur or canvas layers, survival tools and weather-beaten boots",
  Entertainer: "colorful travelling performer's outfit, silk sash, decorative belt and well-worn stage boots",
  Hermit: "simple rough-spun robes, rope belt, pilgrim's pouch, worn sandals or bare feet",
};

const portraitPresets: Record<PortraitPresetName, {
  identity: string;
  pose: string;
  priority: string;
  props: string;
  background: string;
  negative: string[];
}> = {
  fighter: {
    identity: "seasoned martial hero with disciplined presence",
    pose: "stable grounded full-body stance, facing camera, no attack swing, no extreme perspective",
    priority: "focus on face, armor silhouette, torso readability and grounded posture",
    props: "shield optional, kept lowered or strapped; main weapon secondary, sheathed, strapped, on the back, or held low beside the leg without crossing the torso",
    background: "subtle medieval hall or chapel background with low visual noise",
    negative: [
      "raised shield covering torso",
      "crossed weapons",
      "oversized shield",
      "combat leap",
      "weapon across chest",
    ],
  },
  rogue: {
    identity: "agile infiltrator with quiet confidence",
    pose: "balanced full-body stance, calm and stealth-ready, no crouching lunge, no acrobatic jump",
    priority: "focus on face, hood or leather silhouette, belt line and clean anatomy",
    props: "dagger, rapier, or short weapon secondary at belt, hip, or held low; no dual-wield action pose",
    background: "softly lit stone corridor or alley background kept secondary to the character",
    negative: [
      "dual wield action pose",
      "extreme crouch",
      "weapon thrust toward camera",
      "multiple daggers floating",
    ],
  },
  wizard: {
    identity: "arcane scholar-adventurer with composed authority",
    pose: "full-body portrait with calm upright posture, simple hand placement, no dramatic spellcasting gesture",
    priority: "focus on face, robe silhouette, staff or focus readability and clean hands",
    props: "staff, spellbook, or arcane focus as a single secondary prop; at most one subtle magical glow",
    background: "dim arcane interior or torchlit archway with restrained effects",
    negative: [
      "multiple floating objects",
      "many spell effects",
      "two staves",
      "glowing orb swarm",
      "dramatic casting pose",
    ],
  },
  cleric: {
    identity: "protective divine adventurer with serene resolve",
    pose: "full-body portrait, frontal or three-quarter stance, still and dignified, no sermon gesture, no battle swing",
    priority: "focus on face, vestment silhouette, holy symbol readability and clean anatomy",
    props: "holy symbol or ritual focus prominent; mace optional and secondary at belt, back, or lowered hand",
    background: "warm sacred interior with quiet light and restrained ornament",
    negative: [
      "multiple holy symbols",
      "floating relics",
      "weapon raised overhead",
      "both hands carrying large props",
      "busy altar clutter",
    ],
  },
  ranger: {
    identity: "skilled wilderness hunter and tracker with quiet alertness",
    pose: "full-body portrait, relaxed hunter's stance, bow held naturally at side or slung on back",
    priority: "focus on face, ranger garb silhouette, bow or blade readability and natural posture",
    props: "longbow or shortsword secondary; quiver at back or hip; no arrow nocked toward camera",
    background: "misty forest edge or woodland path with restrained foliage detail",
    negative: [
      "arrow nocked at camera",
      "combat draw stance",
      "dual weapon action pose",
      "overly busy forest background",
    ],
  },
  bard: {
    identity: "charming wandering performer with quick wit and hidden edge",
    pose: "full-body portrait, open relaxed stance, instrument held casually at side or strapped to back",
    priority: "focus on face, traveller's outfit silhouette, instrument or rapier readability",
    props: "lute, flute, or similar instrument as a single prop; rapier optional at hip, not raised",
    background: "warm tavern interior or lantern-lit stage with very restrained detail",
    negative: [
      "dramatic performance pose",
      "instrument raised overhead",
      "multiple instruments",
      "crowd in background",
    ],
  },
  paladin: {
    identity: "devoted holy knight with radiant authority and stern purpose",
    pose: "full-body portrait, grounded upright stance, shield lowered or at side, sword sheathed or lowered",
    priority: "focus on face, plate armor silhouette, holy symbol visibility and noble bearing",
    props: "holy symbol on chest or in hand; shield at side; longsword sheathed or lowered beside leg",
    background: "sacred stone hall or chapel moonlight with restrained sacred glow",
    negative: [
      "weapon raised in battle",
      "charging pose",
      "shield covering face",
      "multiple glowing auras",
    ],
  },
  druid: {
    identity: "nature-bonded shapeshifter with ancient wisdom and wild calm",
    pose: "full-body portrait, still grounded stance, staff held upright or resting at side",
    priority: "focus on face, natural garb silhouette, staff or druidic focus readability",
    props: "wooden staff or druidic focus held upright; no dramatic nature magic erupting around figure",
    background: "ancient grove or mossy stone ruin with soft natural light",
    negative: [
      "multiple animals surrounding",
      "dramatic nature explosion",
      "glowing swarm of leaves",
      "transformation mid-shift",
    ],
  },
};

export const POINT_BUY_BUDGET = 27;
export const POINT_BUY_COSTS: Record<number, number> = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };

export const classSkillChoices: Record<string, { count: number; options: string[] }> = {
  Fighter: { count: 2, options: ["Athletics", "Acrobatics", "History", "Insight", "Intimidation", "Perception", "Survival"] },
  Rogue: { count: 4, options: ["Acrobatics", "Athletics", "Deception", "Insight", "Intimidation", "Investigation", "Perception", "Persuasion", "Stealth"] },
  Wizard: { count: 2, options: ["Arcana", "History", "Insight", "Investigation", "Medicine", "Religion"] },
  Cleric: { count: 2, options: ["History", "Insight", "Medicine", "Persuasion", "Religion"] },
  Ranger: { count: 3, options: ["Animal Handling", "Athletics", "Insight", "Investigation", "Nature", "Perception", "Stealth", "Survival"] },
  Bard: { count: 3, options: ["Acrobatics", "Athletics", "Deception", "History", "Insight", "Intimidation", "Investigation", "Nature", "Perception", "Performance", "Persuasion", "Stealth"] },
  Paladin: { count: 2, options: ["Athletics", "Insight", "Intimidation", "Medicine", "Persuasion", "Religion"] },
  Druid: { count: 2, options: ["Arcana", "Animal Handling", "Insight", "Medicine", "Nature", "Perception", "Religion", "Survival"] },
};

export const classSpellChoices: Record<string, { count: number; options: string[] }> = {
  Fighter:  { count: 0, options: [] },
  Rogue:    { count: 0, options: [] },
  Wizard:   { count: 4, options: ["Fire Bolt", "Ray of Frost", "Mage Hand", "Minor Illusion", "Shocking Grasp", "Prestidigitation", "Magic Missile", "Shield", "Mage Armor", "Sleep", "Detect Magic", "Burning Hands", "Charm Person", "Thunderwave", "Feather Fall", "Chromatic Orb"] },
  Cleric:   { count: 4, options: ["Sacred Flame", "Guidance", "Thaumaturgy", "Light", "Spare the Dying", "Cure Wounds", "Healing Word", "Bless", "Command", "Guiding Bolt", "Detect Magic", "Inflict Wounds", "Sanctuary", "Shield of Faith"] },
  Ranger:   { count: 2, options: ["Hunter's Mark", "Cure Wounds", "Entangle", "Fog Cloud", "Speak with Animals", "Alarm", "Goodberry", "Longstrider"] },
  Bard:     { count: 4, options: ["Vicious Mockery", "Friends", "Minor Illusion", "Prestidigitation", "Healing Word", "Charm Person", "Disguise Self", "Faerie Fire", "Sleep", "Thunderwave", "Heroism", "Tasha's Hideous Laughter"] },
  Paladin:  { count: 2, options: ["Cure Wounds", "Bless", "Command", "Divine Favor", "Shield of Faith", "Detect Evil and Good", "Detect Magic", "Thunderous Smite"] },
  Druid:    { count: 4, options: ["Shillelagh", "Druidcraft", "Produce Flame", "Guidance", "Entangle", "Cure Wounds", "Healing Word", "Faerie Fire", "Goodberry", "Speak with Animals", "Thunderwave", "Fog Cloud"] },
};

export type EquipmentOption = { label: string; equipped: string[]; backpack: string[] };

export const classEquipmentChoices: Record<string, EquipmentOption[]> = {
  Fighter: [
    { label: "Espada Longa + Escudo + Cota de Malha", equipped: ["Longsword", "Shield", "Chain Mail"], backpack: ["Torch", "Rations", "Rope"] },
    { label: "Machadão + Camisola de Cota", equipped: ["Greataxe", "Chain Shirt"], backpack: ["Two Handaxes", "Torch", "Rations"] },
  ],
  Rogue: [
    { label: "Rapieira + Arco Curto + Couro", equipped: ["Rapier", "Shortbow", "Leather Armor"], backpack: ["Lockpicks", "Dagger", "Caltrops"] },
    { label: "Duas Espadas Curtas + Couro", equipped: ["Shortsword", "Shortsword", "Leather Armor"], backpack: ["Lockpicks", "Caltrops", "Thieves' Tools"] },
  ],
  Wizard: [
    { label: "Cajado + Varinha de Foco", equipped: ["Quarterstaff", "Spellbook", "Focus Wand"], backpack: ["Ink", "Component Pouch", "Rations"] },
    { label: "Adaga + Foco Arcano", equipped: ["Dagger", "Spellbook", "Arcane Focus"], backpack: ["Component Pouch", "Ink", "Rations"] },
  ],
  Cleric: [
    { label: "Maça + Escudo + Cota de Escamas", equipped: ["Mace", "Shield", "Scale Mail", "Holy Symbol"], backpack: ["Healer's Kit", "Torch", "Prayer Book"] },
    { label: "Martelo de Guerra + Cota de Escamas", equipped: ["Warhammer", "Scale Mail", "Holy Symbol"], backpack: ["Healer's Kit", "Torch", "Prayer Book"] },
  ],
  Ranger: [
    { label: "Arco Longo + Espada Curta + Couro Cravejado", equipped: ["Longbow", "Shortsword", "Studded Leather"], backpack: ["Quiver (20 arrows)", "Hunting Trap", "Waterskin"] },
    { label: "Duas Espadas Curtas + Couro Cravejado", equipped: ["Shortsword", "Shortsword", "Studded Leather"], backpack: ["Hunting Trap", "Torches", "Waterskin"] },
  ],
  Bard: [
    { label: "Rapieira + Alaúde + Couro", equipped: ["Rapier", "Lute", "Leather Armor"], backpack: ["Disguise Kit", "Torch", "Book of Songs"] },
    { label: "Espada Longa + Lira + Couro", equipped: ["Longsword", "Lyre", "Leather Armor"], backpack: ["Disguise Kit", "Torch", "Book of Songs"] },
  ],
  Paladin: [
    { label: "Espada Longa + Escudo + Armadura de Placas", equipped: ["Longsword", "Shield", "Plate Mail", "Holy Symbol"], backpack: ["Healer's Kit", "Holy Water", "Prayer Book"] },
    { label: "Montante + Armadura de Placas", equipped: ["Greatsword", "Plate Mail", "Holy Symbol"], backpack: ["Healer's Kit", "Holy Water", "Prayer Book"] },
  ],
  Druid: [
    { label: "Bordão + Foco Druídico + Couro", equipped: ["Quarterstaff", "Leather Armor", "Druidic Focus"], backpack: ["Healer's Kit", "Torch", "Herbalism Kit"] },
    { label: "Bordão + Escudo + Couro", equipped: ["Quarterstaff", "Shield", "Leather Armor", "Druidic Focus"], backpack: ["Healer's Kit", "Torch", "Herbalism Kit"] },
  ],
};

// Maps skill names (lowercase) to their governing attribute
const skillAttributeMap: Record<string, string> = {
  athletics: "strength",
  melee: "strength",
  acrobatics: "agility",
  stealth: "agility",
  arcana: "mind",
  history: "mind",
  investigation: "mind",
  nature: "mind",
  religion: "mind",
  insight: "wisdom",
  medicine: "wisdom",
  perception: "wisdom",
  survival: "wisdom",
  "animal handling": "wisdom",
  deception: "presence",
  intimidation: "presence",
  performance: "presence",
  persuasion: "presence",
  awareness: "wisdom",
};


const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");

const normalizeClause = (value: string): string => normalizeText(value).replace(/[.,;:]+$/g, "");

const cleanImagePromptText = (value: string, fallback = ""): string => {
  const cleaned = normalizeClause(value || fallback)
    .replace(/\b(reference sheet|character sheet|concept sheet|model sheet|item sheet|inventory sheet|weapon catalog|armor catalog|shield catalog|multiple views?|front and back|turnaround|grid|panel|panels)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || fallback;
};

const expandPortugueseVisualHints = (value: string): string => {
  const lowered = value.toLowerCase();
  const hints: string[] = [];
  if (lowered.includes("barba longa")) hints.push("(very long beard:1.45), full long beard reaching the upper chest");
  else if (lowered.includes("barba")) hints.push("beard");
  if (lowered.includes("cabelo longo")) hints.push("(long hair:1.45), long hair falling behind the shoulders");
  if (lowered.includes("encaracolado") || lowered.includes("cacheado")) hints.push("(curly hair:1.35), clearly curled hair texture");
  if (lowered.includes("cabelo curto")) hints.push("short hair");
  if (lowered.includes("careca")) hints.push("bald head");
  if (lowered.includes("cicatriz")) hints.push("(visible scar:1.35), scar exactly where described by the player");
  if (lowered.includes("cicatriz no olho") || lowered.includes("cicatriz sobre o olho")) hints.push("(visible scar over one eye:1.7), clear facial scar crossing the eye area");
  if (lowered.includes("olhos azuis")) hints.push("(blue eyes:1.45), clearly blue eyes");
  if (lowered.includes("olhos verdes")) hints.push("(green eyes:1.45), clearly green eyes");
  if (lowered.includes("ruivo") || lowered.includes("ruiva")) hints.push("(red ginger hair:1.45), copper red hair");
  if (lowered.includes("loiro") || lowered.includes("loira")) hints.push("(blond hair:1.45), clear blond hair");
  if (lowered.includes("trapo") || lowered.includes("farrapo")) hints.push("(ragged torn cloth:1.45), poor worn fabric, frayed neckline, visibly ripped clothing, no armor, no jewelry");
  if (lowered.includes("pano")) hints.push("simple fabric clothing");
  if (lowered.includes("rasgado") || lowered.includes("rasgada")) hints.push("(torn ripped fabric:1.4), ragged damaged edges, visible tears");
  if (lowered.includes("preto") || lowered.includes("preta")) hints.push("(black clothing:1.6), dark black fabric color, charcoal black cloth, not blue");
  if (lowered.includes("branco") || lowered.includes("branca")) hints.push("(white clothing:1.35)");
  if (lowered.includes("vermelho") || lowered.includes("vermelha")) hints.push("(red clothing:1.35)");
  if (lowered.includes("azul")) hints.push("(blue clothing:1.35)");
  if (lowered.includes("verde")) hints.push("(green clothing:1.35)");
  if (lowered.includes("dourado") || lowered.includes("dourada")) hints.push("(golden details:1.25)");
  if (lowered.includes("prateado") || lowered.includes("prateada")) hints.push("(silver details:1.25)");
  return hints.join(", ");
};

const describesRaggedClothes = (value: string): boolean => {
  const lowered = value.toLowerCase();
  return ["trapo", "farrapo", "pano rasgado", "roupa rasgada", "mendigo", "pobre"].some((term) => lowered.includes(term));
};

const wantsLongHairOrBeard = (value: string): boolean => {
  const lowered = value.toLowerCase();
  return lowered.includes("cabelo longo") || lowered.includes("barba longa");
};

const wantsBlackClothes = (value: string): boolean => {
  const lowered = value.toLowerCase();
  return lowered.includes("preto") || lowered.includes("preta");
};

const uniqueClauses = (clauses: Array<string | undefined>): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const clause of clauses) {
    const normalized = clause ? normalizeClause(clause) : "";
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }

  return result;
};

const createStableSeed = (value: string): number => {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (Math.abs(hash) % 900000000) + 1000000;
};

const isGeneratedDefaultText = (value: string, defaults: Record<string, string>): boolean => {
  const normalized = normalizeClause(value).toLowerCase();
  return Object.values(defaults).some((entry) => normalizeClause(entry).toLowerCase() === normalized);
};

const pickVariant = (variants: string[] | undefined, seed: number, salt: number): string | undefined => {
  if (!variants || variants.length === 0) return undefined;
  return variants[Math.abs(seed + salt) % variants.length];
};

const portraitSpeciesLock = (species: string, gender: "male" | "female"): string => {
  if (species === "Dwarf" && gender === "female") {
    return speciesGenderPortraitLocks.Dwarf?.female ?? "";
  }
  return [
    speciesPortraitLocks[species] ?? speciesPromptDescriptors[species] ?? species.toLowerCase(),
    speciesGenderPortraitLocks[species]?.[gender],
  ].filter(Boolean).join(", ");
};

const portraitSpeciesBase = (species: string, gender: "male" | "female", seed: number): string | undefined => {
  if (species === "Dwarf" && gender === "female") {
    return pickVariant([
      "beardless female dwarf woman, mature stocky face, broad wide nose, thick neck, rounded ears, compact powerful shoulders, thick braided hair, smooth chin",
      "mature short-statured fantasy woman, wide square face, sturdy nose, rounded ears, braided hair, smooth clean chin, rugged adult expression",
      "compact stocky fantasy woman, strong shoulders, rounded ears, thick hair braids, grounded clan artisan presence, smooth chin, not young",
    ], seed, 23);
  }
  return pickVariant(speciesPortraitVariants[species], seed, 23);
};

const portraitPresetForClass = (className: string): PortraitPresetName => {
  switch (className) {
    case "Rogue":
      return "rogue";
    case "Wizard":
      return "wizard";
    case "Cleric":
      return "cleric";
    case "Ranger":
      return "ranger";
    case "Bard":
      return "bard";
    case "Paladin":
      return "paladin";
    case "Druid":
      return "druid";
    default:
      return "fighter";
  }
};

const buildVisualProfile = (character: CharacterCreation, template: ClassTemplate): VisualProfile => {
  const physicalDescription = normalizeText(character.physicalDescription)
    || speciesVisualDefaultsByGender[character.species]?.[character.gender ?? "male"]
    || speciesVisualDefaults[character.species]
    || speciesVisualDefaults.Human;
  const weaponDescription = normalizeText(character.weaponDescription)
    || classWeaponDefaults[character.className]
    || classWeaponDefaults.Fighter;
  const outfitDescription = normalizeText(character.outfitDescription)
    || backgroundOutfitDefaults[character.background]
    || `${template.equipped.join(", ")} integrated into practical fantasy adventuring clothes`;
  const extraDescription = normalizeText(character.appearanceDescription);
  const appearanceDescription = [
    physicalDescription,
    `wearing ${outfitDescription}`,
    `equipped with ${weaponDescription}`,
    extraDescription || undefined,
  ].filter(Boolean).join(", ");

  return {
    physicalDescription,
    weaponDescription,
    outfitDescription,
    appearanceDescription,
  };
};

export const buildNpcStats = (
  className: string,
  level: number,
): { hitPoints: number; maxHitPoints: number; armorClass: number } => {
  const template = classTemplates[className] ?? classTemplates.Fighter;
  const constitutionModifier = Math.floor(((template.abilities.constitution ?? 10) - 10) / 2);
  const maxHitPoints = template.hitDie + constitutionModifier + Math.max(0, level - 1) * (Math.floor(template.hitDie / 2) + 1 + constitutionModifier);
  return { hitPoints: maxHitPoints, maxHitPoints, armorClass: template.armorClass };
};

export const defaultRoomSetup = (): RoomSetup => ({
  systemId: "dnd5e-srd",
  startingLevel: 1,
  npcCompanions: 0,
  enemyDifficulty: "standard",
  battleIntensity: "medium",
  gmKindness: "balanced",
  hostPlayerId: undefined,
});

export const roomSetupOptions = {
  systems: [{ id: "dnd5e-srd", label: "D&D 5e SRD" }],
  npcCompanions: [
    { id: 0, label: "Nenhum (solo)" },
    { id: 1, label: "1 companheiro" },
    { id: 2, label: "2 companheiros" },
    { id: 3, label: "3 companheiros" },
  ],
  difficulties: [
    { id: "story", label: "História heroica" },
    { id: "standard", label: "Padrão aventureiro" },
    { id: "deadly", label: "Perigoso" },
  ],
  battleIntensity: [
    { id: "low", label: "Poucos combates" },
    { id: "medium", label: "Equilibrado" },
    { id: "high", label: "Mais intensas e frequentes" },
  ],
  gmKindness: [
    { id: "merciful", label: "Mestre benevolente" },
    { id: "balanced", label: "Mestre equilibrado" },
    { id: "grim", label: "Mestre implacável" },
  ],
  classes: Object.keys(classTemplates),
  species: Object.keys(speciesBonuses),
  backgrounds: Object.keys(backgroundItems),
  classSkillChoices,
  classSpellChoices,
  classEquipmentChoices,
  pointBuyCosts: POINT_BUY_COSTS,
};

export const buildPlayerFromCharacter = (character: CharacterCreation, level: number): Omit<Player, "id"> => {
  const template = classTemplates[character.className] ?? classTemplates.Fighter;
  const bonuses = speciesBonuses[character.species] ?? speciesBonuses.Human;
  const visualProfile = buildVisualProfile(character, template);
  if (character.attributeOverrides) {
    const validation = validatePointBuyAllocation(character.attributeOverrides);
    if (!validation.ok) throw new Error(validation.message ?? "Distribuição de atributos inválida.");
  }

  // If player used point-buy attribute overrides, use them; otherwise fall back to template + species bonuses
  const attributes = character.attributeOverrides
    ? Object.fromEntries(
        Object.entries(character.attributeOverrides).map(([key, value]) => [key, value + (bonuses[key] ?? 0)]),
      )
    : Object.fromEntries(
        Object.entries(template.abilities).map(([key, value]) => [key, value + (bonuses[key] ?? 0)]),
      );

  const constitutionModifier = Math.floor(((attributes.constitution ?? 10) - 10) / 2);
  const maxHitPoints = template.hitDie + constitutionModifier + Math.max(0, level - 1) * (Math.floor(template.hitDie / 2) + 1 + constitutionModifier);
  const proficiencyBonus = proficiencyBonusByLevel(level);

  // Equipment: use player's chosen alternative pack or fall back to template default
  const chosenEquip = classEquipmentChoices[character.className]?.[character.equipmentChoice ?? 0]
    ?? classEquipmentChoices[character.className]?.[0];
  const inventory: InventoryState = {
    equipped: [...(chosenEquip?.equipped ?? template.equipped)],
    backpack: [...(chosenEquip?.backpack ?? template.backpack), ...(backgroundItems[character.background] ?? [])],
    gold: 15 + level * 10,
  };

  // Build skills: merge template defaults with proficiency-based overrides if provided
  let skills = { ...template.skills };
  if (character.skillProficiencies && character.skillProficiencies.length > 0) {
    for (const skillName of character.skillProficiencies) {
      const key = skillName.toLowerCase().replace(/\s+/g, "_");
      const attr = skillAttributeMap[skillName.toLowerCase()] ?? skillAttributeMap[key];
      const attrMod = attr ? Math.floor(((attributes[attr] ?? 10) - 10) / 2) : 0;
      skills[skillName.toLowerCase()] = proficiencyBonus + attrMod;
    }
  }

  const features = template.features;
  return {
    name: character.name,
    characterName: character.characterName,
    appearanceDescription: visualProfile.appearanceDescription,
    physicalDescription: visualProfile.physicalDescription,
    weaponDescription: visualProfile.weaponDescription,
    outfitDescription: visualProfile.outfitDescription,
    className: template.className,
    species: character.species,
    gender: character.gender,
    background: character.background,
    origin: character.origin,
    motivation: character.motivation,
    turningPoint: character.turningPoint,
    connections: character.connections,
    backstory: character.backstory,
    level,
    classLevels: { [template.className]: level },
    experiencePoints: experienceThresholdsByLevel[level] ?? 0,
    nextLevelExperience: nextLevelExperience(level),
    pendingLevelUps: 0,
    attributes,
    skills,
    hitPoints: maxHitPoints,
    maxHitPoints,
      armorClass: calculateArmorClass(attributes, inventory),
    proficiencyBonus,
    ready: false,
    notes: "",
    portraitAssetUrl: character.portraitAssetUrl || undefined,
    inventory,
    spells: (character.spellSelection && character.spellSelection.length > 0) ? character.spellSelection : template.spells,
    features,
    resources: defaultResourcesForFeatures(features),
    loreEvents: buildInitialPlayerLore({
      characterName: character.characterName,
      origin: character.origin,
      motivation: character.motivation,
      turningPoint: character.turningPoint,
      connections: character.connections,
      backstory: character.backstory,
    }),
    moralProfile: defaultMoralProfile(),
  };
};

export const buildCharacterPortraitPrompt = (
  player: Pick<Player, "characterName" | "className" | "species" | "gender" | "background" | "appearanceDescription" | "physicalDescription" | "weaponDescription" | "outfitDescription">,
): PortraitPromptSpec => {
  const presetName = portraitPresetForClass(player.className);
  const preset = portraitPresets[presetName];
  const genderKey = player.gender === "female" ? "female" : "male";
  const genderDescriptor = genderKey === "female" ? "female woman" : "male man";
  const speciesDescriptor = portraitSpeciesDescriptor(player.species, genderKey);
  const classDescriptor = classPromptDescriptors[player.className] ?? player.className.toLowerCase();
  const speciesLock = portraitSpeciesLock(player.species, genderKey);
  const speciesNegative = speciesPortraitNegatives[player.species] ?? [];
  const classLock = classPortraitLocks[player.className] ?? classPortraitLocks.Fighter;
  const physical = cleanImagePromptText(player.physicalDescription);
  const outfit = cleanImagePromptText(player.outfitDescription, "practical fantasy adventuring outfit");
  const physicalIsDefault = isGeneratedDefaultText(physical, speciesVisualDefaults);
  const outfitIsBackgroundDefault = isGeneratedDefaultText(outfit, backgroundOutfitDefaults);
  const effectiveOutfit = outfitIsBackgroundDefault
    ? (classPortraitOutfits[player.className] ?? "practical fantasy adventuring clothes matching the class")
    : outfit;
  const userVisualHints = expandPortugueseVisualHints(`${physical}, ${outfit}`);
  const refinedLocks = visualLocksFromPortuguese(`${physical}, ${outfit}`);
  const raggedClothes = describesRaggedClothes(outfit);
  const longHairOrBeard = wantsLongHairOrBeard(physical);
  const blackClothes = wantsBlackClothes(outfit);
  const portraitSeed = createStableSeed([
    player.characterName,
    player.className,
    player.species,
    player.gender ?? "",
    player.background,
    player.physicalDescription,
    player.outfitDescription,
  ].join("|"));
  const genderBase = pickVariant(genderPortraitDefaults[genderKey], portraitSeed, 11);
  const speciesBase = portraitSpeciesBase(player.species, genderKey, portraitSeed);
  const classBase = pickVariant(classPortraitVariants[player.className], portraitSeed, 37);
  const playerDetailPriority = player.gender === "female"
    ? "if the player typed colors, scars, hair texture, clothing material or clothing damage, preserve those details with highest priority"
    : "if the player typed colors, scars, hair texture, beard length, clothing material or clothing damage, preserve those details with highest priority";
  const prompt = uniqueClauses([
    "high quality fantasy RPG player character portrait",
    "single character only, one person, no duplicates",
    `CORE ARCHETYPE, must be obvious: adult ${genderDescriptor} ${speciesDescriptor} ${classDescriptor}`,
    `default combination base for selected gender, ancestry and class: ${[genderBase, speciesBase, classBase].filter(Boolean).join("; ")}`,
    `race locks: ${speciesLock}`,
    `class locks: ${classLock.positive}`,
    physicalIsDefault
      ? `base face if player gives no extra face details: ${physical}`
      : `MANDATORY player face description, overrides base: ${physical}`,
    outfitIsBackgroundDefault
      ? `base clothing because player gave no outfit details: ${effectiveOutfit}`
      : `MANDATORY player clothing description, overrides base: ${outfit}`,
    userVisualHints ? `English visual clarification: ${userVisualHints}` : undefined,
    refinedLocks.positive.length ? `MANDATORY visual locks from player text: ${refinedLocks.positive.join(", ")}` : undefined,
    playerDetailPriority,
    "when player descriptions are generic or empty, class and race locks have priority over background outfit stereotypes",
    `adult ${genderDescriptor} ${speciesDescriptor} fantasy portrait subject`,
    `strict identity: ${player.gender === "female" ? "female" : "male"} ${speciesDescriptor}`,
    "bust portrait, head and shoulders, face and upper chest visible, centered, looking at viewer",
    "focus on face, hair, facial structure, skin tone, facial details, clear readable human face, expressive eyes, natural anatomy, clean silhouette",
    "plain warm parchment background, no frame, no border, no scenery, no props around the character",
    "even soft studio lighting, visible colors, low contrast shadows, no dramatic backlight",
    `visible upper body clothing exactly as described, same color and condition: ${effectiveOutfit}`,
    raggedClothes ? "wearing ragged cloth only, torn fabric visible on shoulders and chest, frayed and poor clothing, no metal anywhere, no armor plates, no shoulder guards, no necklace" : undefined,
    "clean painterly fantasy RPG character portrait",
    "detailed face, polished fantasy art, warm muted colors, sharp focus",
  ]).join(", ");

  const negativePrompt = uniqueClauses([
    "top down view",
    "token sheet",
    "contact sheet",
    "grid",
    "panels",
    "panel layout",
    "comic panels",
    "filmstrip",
    "split screen",
    "multiple views",
    "turnaround",
    "front back side view",
    "lineup",
    "repeated character",
    "same character repeated",
    "reference sheet",
    "concept sheet",
    "model sheet",
    "character sheet",
    "inventory sheet",
    "item sheet",
    "prop sheet",
    "weapon visible",
    "holding weapon",
    "sword",
    "axe",
    "bow",
    "staff weapon",
    "shield",
    "weapon catalog",
    "armor catalog",
    "shield catalog",
    "detached weapons",
    "isolated weapons",
    "separate shields",
    "icons",
    "multiple objects around character",
    "helmet covering face",
    "closed helmet",
    "mask",
    raggedClothes ? "armor, leather armor, plate armor, pauldrons, shoulder armor, metal shoulders, chainmail, breastplate, polished armor, military armor, ornate armor, heroic armor" : undefined,
    raggedClothes ? "noble clothing, clean cloak, jewelry, necklace, medallion, polished costume, expensive fabric" : undefined,
    longHairOrBeard ? "short hair, neat haircut, cropped hair, short beard, trimmed beard, stubble, clean shaven" : undefined,
    blackClothes ? "white clothing, cream clothing, bright beige clothing, clean white shirt, pale cloak, blue clothing, navy clothing, grey clothing" : undefined,
    ...refinedLocks.negative,
    "split face",
    "abstract face",
    "geometric face",
    "metal face",
    "robot face",
    player.gender === "female" ? "male, man, masculine, beard, long beard, white beard, facial hair, mustache, stubble, masculine jaw, old male dwarf, grandfather, male dwarf face" : "female, woman, feminine, breasts, dress unless described",
    "side view",
    "full body",
    "tiny full body figure",
    "cropped body",
    "busy background",
    "landscape background",
    "crowd scene",
    "multiple characters",
    "frame",
    "border",
    "window frame",
    "boxed composition",
    "silhouette",
    "strong backlight",
    "harsh shadow",
    "heavy black shadows",
    "face hidden in shadow",
    "noir lighting",
    "overexposed window",
    "high contrast lighting",
    "text",
    "watermark",
    "signature",
    ...speciesNegative,
    ...classLock.negative,
    ...preset.negative,
  ]).join(", ");

  return {
    presetName,
    prompt,
    negativePrompt,
    seed: portraitSeed,
    framing: "portrait",
    weaponPolicy: "not_visible",
  };
};

// ── Scene prompt builder ────────────────────────────────────────────────────
//
// Generates a detailed, style-consistent image prompt for RPG environmental
// art. Priority rules:
//   1. Scene classifier detects the location archetype from title + summary.
//   2. Each archetype forces the correct viewpoint (exterior / interior),
//      time of day, light sources, and mood modifiers.
//   3. A shared quality prefix and negative-hint suffix keep the style stable.
//
// The second attached reference image (moonlit road + gothic chapel) is the
// stylistic target for outdoor/chapel scenes.

type SceneArchetype = {
  readonly viewpoint: string;
  readonly timeAndLight: string;
  readonly atmosphere: string;
  readonly style: string;
};

const SCENE_ARCHETYPES: Array<{
  keywords: readonly string[];
  archetype: SceneArchetype;
}> = [
  // ── Chapel / church / road approach ───────────────────────────────────────
  {
    keywords: ["chapel", "catedral", "cathedral", "church", "igreja", "blackstone", "estrada", "road", "path", "caminho"],
    archetype: {
      viewpoint: "wide exterior establishing shot, low camera angle on a cobblestone road leading to an ancient gothic chapel, no interior, outside view only",
      timeAndLight: "nighttime, full blood moon low on the horizon, warm lantern glow on the road, moonlight casting long blue shadows across fog",
      atmosphere: "dense ground fog, bare leafless trees silhouetted against the moonlit sky, ravens and crows circling, distant chapel steeple piercing the clouds, eerie and foreboding",
      style: "dark fantasy digital painting, cinematic widescreen, rich amber and deep blue tones, dramatic contrast, volumetric moonlight",
    },
  },
  // ── Dungeon / prison / passage ────────────────────────────────────────────
  {
    keywords: ["dungeon", "masmorra", "prison", "prisão", "cell", "cela", "pit", "corredor", "corridor", "passage", "passagem"],
    archetype: {
      viewpoint: "underground stone dungeon corridor stretching into darkness, deep interior, no sky, low vaulted ceiling",
      timeAndLight: "flickering iron torch sconces casting orange pools of light, deep shadow pools between torches, no natural light",
      atmosphere: "damp mossy granite walls, locked iron grate at the far end, scattered bones and old chains, heavy oppressive silence",
      style: "dark fantasy atmospheric painting, deep chiaroscuro, orange and charcoal tones, wet stone texture",
    },
  },
  // ── Crypt / tomb / burial chamber ────────────────────────────────────────
  {
    keywords: ["crypt", "cripta", "catacomb", "catacumba", "tomb", "tumba", "burial", "sepultura", "mausoleum", "sarcophagus", "sarcófago"],
    archetype: {
      viewpoint: "stone burial chamber interior, rows of sarcophagi receding into darkness, vaulted ceiling",
      timeAndLight: "guttering iron candle stands barely lighting the room, cold dim crack of light from above, near-darkness",
      atmosphere: "carved stone sarcophagi with worn inscriptions, shattered urns, cobwebs, cracked reliefs of skeletal figures, deathly still",
      style: "dark fantasy matte painting, blue-grey and charcoal tones, deep shadow atmosphere, ancient dread",
    },
  },
  // ── Cave / cavern / grotto / mine ────────────────────────────────────────
  {
    keywords: ["cave", "caverna", "cavern", "grotto", "gruta", "mine", "mina", "underground"],
    archetype: {
      viewpoint: "vast natural underground cavern, stalactites and stalagmites receding into deep darkness, narrow stone bridge over chasm",
      timeAndLight: "phosphorescent blue light from underground stream, pale fungal glow on wet walls, no natural light",
      atmosphere: "massive cavern ceiling disappearing above, glowing fungal formations, ancient and primordial, echoing void",
      style: "dark fantasy matte painting, cool blue and grey tones, soft bioluminescent glow, primordial atmosphere",
    },
  },
  // ── Swamp / marsh / wetlands / river / lake ───────────────────────────────
  {
    keywords: ["swamp", "pântano", "marsh", "alagado", "wetlands", "mire", "bog", "river", "rio", "lake", "lago", "shore", "margem", "coast", "costa"],
    archetype: {
      viewpoint: "wide exterior landscape shot of misty marshland at night, dead trees half-submerged in black still water",
      timeAndLight: "cold silver moonlight filtering through heavy storm clouds, will-o-wisp pale blue glow over the water",
      atmosphere: "rotting docks, skeletal branches reaching from the water, fog swallowing the horizon, eerie cursed silence",
      style: "moody dark fantasy landscape painting, muted cool greens and silver greys, heavy fog atmosphere",
    },
  },
  // ── Ruins / ancient exterior site ────────────────────────────────────────
  {
    keywords: ["ruins", "ruínas", "ruinas", "ancient", "antigo", "collapsed", "desmoronado", "fallen"],
    archetype: {
      viewpoint: "wide exterior shot of vast crumbling ancient stone ruins at twilight, epic scale",
      timeAndLight: "overcast late dusk, pale storm light on stone, amber glow where last daylight touches the columns",
      atmosphere: "massive fallen granite columns half-buried, carved reliefs of forgotten gods, vines and roots consuming the walls",
      style: "epic dark fantasy matte painting, desaturated amber and warm tones, dramatic atmospheric depth",
    },
  },
  // ── Temple / shrine / altar / sanctum ────────────────────────────────────
  {
    keywords: ["temple", "templo", "shrine", "sanctuário", "sanctum", "altar", "reliquary", "relicário", "holy_chamber"],
    archetype: {
      viewpoint: "interior of an ancient corrupted temple, stone pillars with elder runes flanking a central altar, arched windows",
      timeAndLight: "tall arched windows shattered, cold grey light filtering in, scattered ritual candles on the floor",
      atmosphere: "sacrificial altar stained with ritual markings, stone statues of dark deities, ancient malevolence, deeply quiet",
      style: "dark fantasy cinematic matte painting, cold blue-grey atmospheric light, ancient dread, painterly",
    },
  },
  // ── Forest / woods / grove ────────────────────────────────────────────────
  {
    keywords: ["forest", "floresta", "woods", "grove", "bosque", "árvore", "tree", "jungle", "selva", "woodland"],
    archetype: {
      viewpoint: "wide forest interior shot, towering gnarled oaks forming a cathedral canopy, narrow path leading into darkness",
      timeAndLight: "cold grey overcast light faintly filtering through the dense canopy, mist near the forest floor",
      atmosphere: "grey mist clinging to gnarled roots, distant shadowy silhouettes between trunks, fallen lichen-covered stones",
      style: "dark fantasy painterly illustration, deep emerald grey tones, soft volumetric mist, layered atmospheric depth",
    },
  },
  // ── Tavern / inn interior ─────────────────────────────────────────────────
  {
    keywords: ["tavern", "taverna", "inn", "estalagem", "alehouse", "pub_interior", "common_room"],
    archetype: {
      viewpoint: "warm interior of a medieval tavern, wide shot showing the full common room and stone fireplace",
      timeAndLight: "large fireplace casting amber light, tallow candles on tables, evening warmth, amber and honey tones",
      atmosphere: "rough oak beamed ceiling, barrels along the bar, dried herbs hanging, weathered animal trophies, lived-in cozy",
      style: "dark fantasy warm illustration, rich earthy tones, soft candlefire ambiance, detailed medieval lived-in",
    },
  },
  // ── Village / town exterior street ───────────────────────────────────────
  {
    keywords: ["village", "vila", "town", "cidade", "settlement", "assentamento", "aldeia", "rua", "market", "mercado", "pub"],
    archetype: {
      viewpoint: "medieval village main street at twilight dusk, wide shot showing buildings on both sides, gothic tower at street end",
      timeAndLight: "full moon in purple-orange twilight sky, warm orange lanterns on posts, windows glowing golden",
      atmosphere: "wet cobblestones reflecting lantern light, half-timbered buildings, early fog between buildings, deserted silence",
      style: "dark fantasy atmospheric matte painting, rich amber and violet tones, volumetric fog, cinematic",
    },
  },
  // ── Castle / fortress exterior ────────────────────────────────────────────
  {
    keywords: ["castle", "castelo", "fortress", "fortaleza", "battlements", "ramparts", "garrison", "stronghold", "citadel"],
    archetype: {
      viewpoint: "wide exterior shot of a looming dark stone castle on a hilltop, viewed from the approach road far below",
      timeAndLight: "deep twilight, purple-orange sunset behind the castle silhouette, torchlit windows glowing orange",
      atmosphere: "heavy iron drawbridge, ravens on the battlements, moat reflecting the sky, dead vines on outer walls",
      style: "dark fantasy oil painting, deep purples and charcoal blacks, dramatic silhouette, high contrast, ominous",
    },
  },
  // ── Tower / spire / watchtower ────────────────────────────────────────────
  {
    keywords: ["tower", "torre", "spire", "campanário", "watchtower", "torreão", "steeple", "obelisk", "keep"],
    archetype: {
      viewpoint: "crumbling ancient stone tower standing alone in open field at night, low horizon, wide establishing shot",
      timeAndLight: "full moon framing the broken jagged tower top, cold blue moonlight, distant lightning on the horizon",
      atmosphere: "top floors collapsed with exposed rusted iron, lichen covering the exterior, dead grass, crows on the parapet",
      style: "dark fantasy atmospheric matte painting, cold blue and grey moonlit tones, haunted and isolated",
    },
  },
  // ── Cemetery / graveyard ─────────────────────────────────────────────────
  {
    keywords: ["cemetery", "cemitério", "graveyard", "burial_ground", "necropolis", "tombstone", "túmulo", "grave", "sepultura"],
    archetype: {
      viewpoint: "wide shot of a medieval cemetery at night, rows of grave markers receding into darkness, leafless oak at center",
      timeAndLight: "cold white moonlight casting sharp shadows from every grave marker, low ground fog between graves",
      atmosphere: "weathered stone tombs, rusted wrought iron fence, crumbling chapel in background, silent and eerie",
      style: "dark fantasy atmospheric matte painting, cool blue and grey tones, crisp moonlit shadow play",
    },
  },
  // ── Throne room / great hall / palace interior ────────────────────────────
  {
    keywords: ["throne", "trono", "throne_room", "great_hall", "hall", "salão", "court", "corte", "palace", "palácio", "royal"],
    archetype: {
      viewpoint: "interior of a vast medieval throne room, stone throne on a raised dais, massive pillars receding to both sides",
      timeAndLight: "iron candelabras barely lighting the space, cold blue-grey tone from dark stained glass windows, deep shadows",
      atmosphere: "cracked stone floor with carved inscriptions, worn ceremonial banner behind throne, sense of fallen power, oppressive",
      style: "dark fantasy cinematic matte painting, cold blue and deep shadow tones, imposing and desolate",
    },
  },
  // ── Mountain / cliff / pass ───────────────────────────────────────────────
  {
    keywords: ["mountain", "montanha", "peak", "pico", "cliff", "falésia", "plateau", "planalto", "highland", "pass", "passagem", "ridge"],
    archetype: {
      viewpoint: "dramatic exterior mountain pass at dawn, narrow rocky ridge, ancient crumbling watchpost, sheer cliff faces on both sides",
      timeAndLight: "first pale sunrise light breaking through storm clouds, boulders dusted with frost, cold dawn atmosphere",
      atmosphere: "fog filling the valley far below, twisted wind-bent pine trees, birds of prey circling, harsh and isolating",
      style: "epic dark fantasy environment painting, cool stone blues, pale dawn gold, wide cinematic composition",
    },
  },
  // ── Battlefield / warzone / siege aftermath ───────────────────────────────
  {
    keywords: ["battlefield", "campo_de_batalha", "warzone", "siege", "cerco", "carnage", "war", "guerra", "aftermath"],
    archetype: {
      viewpoint: "wide exterior shot of medieval battlefield aftermath, scarred earth stretching to a dark horizon",
      timeAndLight: "grey overcast sky, no direct sun, flat diffused light, smoldering siege engine glowing orange in distance",
      atmosphere: "abandoned shields spears and broken banners, ravens across the foggy field, churned mud, collapsed torn tents",
      style: "dark fantasy grim matte painting, muted grey and muddy brown tones, desolate and somber, cinematic wide",
    },
  },
];

const DEFAULT_ARCHETYPE: SceneArchetype = {
  viewpoint: "wide establishing exterior shot, low angle looking across ancient stone ruins at dusk",
  timeAndLight: "late dusk, golden-orange sky fading to dark blue at zenith, torches and lanterns beginning to light",
  atmosphere: "mist rolling across the ground, distant silhouette of a tower or structure, lonely and atmospheric",
  style: "cinematic dark fantasy matte painting, warm amber against cool blue shadows, atmospheric depth",
};

const SCENE_QUALITY_PREFIX = "masterpiece, best quality, dark fantasy environment art, cinematic matte painting, no characters, no people, no figures, no text, no UI";
const SCENE_NEGATIVE_HINTS = "characters, people, heroes, portraits, faces, HUD, text, watermark, interior church ceiling if exterior requested, bright cheerful daytime, clean polished floors, modern architecture, photorealistic photo";

const detectSceneArchetype = (title: string, summary: string): SceneArchetype => {
  const haystack = `${title} ${summary}`.toLowerCase();
  for (const { keywords, archetype } of SCENE_ARCHETYPES) {
    if (keywords.some((kw) => haystack.includes(kw))) {
      return archetype;
    }
  }
  return DEFAULT_ARCHETYPE;
};

export const buildScenePrompt = (sceneTitle: string, sceneSummary: string): string => {
  const arch = detectSceneArchetype(sceneTitle, sceneSummary);

  const subjectHint = `${sceneTitle}`.replace(/["""]/g, "").trim();
  const canonicalDescription = normalizeText(sceneSummary)
    .replace(/["""]/g, "")
    .slice(0, 520);

  return [
    SCENE_QUALITY_PREFIX,
    `CANONICAL SCENE TITLE: ${subjectHint}`,
    canonicalDescription ? `CANONICAL SCENE DESCRIPTION, must match: ${canonicalDescription}` : undefined,
    arch.viewpoint,
    arch.timeAndLight,
    arch.atmosphere,
    arch.style,
    "compose the image from the canonical description first, then use the archetype only to improve lighting and camera",
    "single coherent environment, no random catalog scene, no unrelated tavern or forest unless explicitly described",
    `negative: ${SCENE_NEGATIVE_HINTS}`,
  ].filter(Boolean).join(", ");
};

export const buildOpeningScene = (setup: RoomSetup): { title: string; summary: string; quest: string } => {
  const pressureText: Record<EnemyDifficulty, string> = {
    story: "O comeco deve ter pressao leve e varias saidas seguras.",
    standard: "O comeco deve ter tensao real, mas sem trilho obrigatorio.",
    deadly: "O comeco deve sugerir perigo, sem forcar combate imediato.",
  };

  const styleText: Record<GmKindness, string> = {
    merciful: "O Mestre oferece sinais claros e oportunidades de escolha.",
    balanced: "O Mestre reage ao que os jogadores investigam, dizem e fazem.",
    grim: "O Mestre deixa consequencias pesarem, mas ainda com escolhas abertas.",
  };

  return {
    title: "Inicio em Aberto",
    summary: `${pressureText[setup.enemyDifficulty]} ${styleText[setup.gmKindness]} A sessao deve comecar em um lugar social ou de transicao onde os personagens possam se conhecer, observar o mundo e escolher o primeiro rumo.`,
    quest: "",
  };
};

type SrdEnemyTemplate = {
  name: string;
  xpValue: number;
  baseHp: number;
  threat: number;
  description: string;
};

const srdEnemyCatalog: Record<number, Record<EnemyDifficulty, SrdEnemyTemplate>> = {
  1: {
    story: { name: "Cultista", xpValue: 25, baseHp: 9, threat: 2, description: "Um fanático frágil, perigoso mais por seus segredos e rituais do que por força bruta." },
    standard: { name: "Goblin", xpValue: 50, baseHp: 12, threat: 3, description: "Um goblin ágil e cruel, acostumado a emboscadas, truques e ataques rápidos." },
    deadly: { name: "Orc", xpValue: 100, baseHp: 18, threat: 4, description: "Um orc brutal, capaz de atravessar uma linha defensiva com pura força e ferocidade." },
  },
  2: {
    story: { name: "Esqueleto", xpValue: 50, baseHp: 13, threat: 3, description: "Um morto-vivo armado, frio e obediente a uma vontade sombria." },
    standard: { name: "Orc", xpValue: 100, baseHp: 20, threat: 4, description: "Um orc endurecido por combate, agressivo e difícil de deter em curta distância." },
    deadly: { name: "Carniçal", xpValue: 200, baseHp: 26, threat: 5, description: "Um carniçal faminto, rápido demais para algo morto e perigoso por sua paralisia profana." },
  },
  3: {
    story: { name: "Lobo Atroz", xpValue: 200, baseHp: 28, threat: 5, description: "Um lobo imenso, inteligente o bastante para flanquear e derrubar presas isoladas." },
    standard: { name: "Bugbear", xpValue: 200, baseHp: 32, threat: 5, description: "Um bugbear sorrateiro e forte, perigoso quando consegue atacar de surpresa." },
    deadly: { name: "Ogro", xpValue: 450, baseHp: 54, threat: 6, description: "Um ogro enorme, lento, mas capaz de transformar um erro de posição em desastre." },
  },
  4: {
    story: { name: "Bugbear", xpValue: 200, baseHp: 36, threat: 5, description: "Um bugbear veterano, acostumado a caçar viajantes e quebrar escudos." },
    standard: { name: "Ogro", xpValue: 450, baseHp: 59, threat: 6, description: "Um ogro de força esmagadora, mais perigoso quanto menos espaço o grupo tiver." },
    deadly: { name: "Troll Jovem", xpValue: 700, baseHp: 72, threat: 7, description: "Uma criatura regenerativa e voraz, ainda jovem, mas aterrorizante para aventureiros iniciantes." },
  },
  5: {
    story: { name: "Ogro", xpValue: 450, baseHp: 59, threat: 6, description: "Um ogro bruto, ameaça séria para quem tenta vencer só pela força." },
    standard: { name: "Troll Jovem", xpValue: 700, baseHp: 84, threat: 7, description: "Um troll ainda menor que os antigos de sua espécie, mas já capaz de se regenerar e causar pânico." },
    deadly: { name: "Elemental Menor", xpValue: 1100, baseHp: 92, threat: 8, description: "Uma manifestação elemental instável, muito acima de ameaças comuns de estrada." },
  },
};

const enemyTemplateFor = (level: number, difficulty: EnemyDifficulty): SrdEnemyTemplate => {
  const bounded = Math.max(1, Math.min(5, Math.round(level)));
  return srdEnemyCatalog[bounded]?.[difficulty] ?? srdEnemyCatalog[1].standard;
};

export const buildEnemyProfile = (playerCount: number, level: number, difficulty: EnemyDifficulty, intensity: BattleIntensity) => {
  const difficultyMultiplier: Record<EnemyDifficulty, number> = { story: 0.8, standard: 1, deadly: 1.35 };
  const intensityMultiplier: Record<BattleIntensity, number> = { low: 0.9, medium: 1, high: 1.25 };
  const multiplier = difficultyMultiplier[difficulty] * intensityMultiplier[intensity];
  const template = enemyTemplateFor(level, difficulty);
  const threat = Math.max(2, Math.round(template.threat * difficultyMultiplier[difficulty]));
  const hitPoints = Math.max(8, Math.round((template.baseHp + playerCount * 3) * multiplier));
  const xpValue = Math.max(10, Math.round(template.xpValue * intensityMultiplier[intensity]));

  return {
    hitPoints,
    threat,
    xpValue,
    name: intensity === "high" ? `${template.name} de elite` : intensity === "low" ? `${template.name} isolado` : template.name,
    description: intensity === "high"
      ? "Uma pequena tropa de fanáticos armados avança em formação, pressionando os heróis por todos os lados."
      : "Um inimigo marcado por rituais proibidos emerge das ruínas com aço enferrujado e olhos vazios.",
  };
};

/**
 * Builds a list of enemy stat blocks for an encounter. Encounter size scales with
 * battle intensity: low=1, medium=1–2, high=2–3 enemies. Each enemy's HP/threat
 * is reduced when there are multiple combatants to keep total encounter pressure
 * roughly balanced against the party.
 */
export const buildEnemyGroup = (
  playerCount: number,
  level: number,
  difficulty: EnemyDifficulty,
  intensity: BattleIntensity,
  sceneContext = "",
): Array<{
  id?: string;
  name: string;
  hitPoints: number;
  threat: number;
  xpValue: number;
  armorClass?: number;
  challengeRating?: string;
  kind?: string;
  abilities?: Record<string, number>;
  traits?: string[];
  actions?: Array<{
    name: string;
    attackBonus: number;
    damageDie: "d4" | "d6" | "d8" | "d10" | "d12";
    damageDiceCount: number;
    damageModifier: number;
    damageType: string;
    notes?: string;
  }>;
  description: string;
}> => {
  return selectMonsterEncounter(playerCount, level, difficulty, intensity, sceneContext);
};

const xpForEncounterEnemy = (level: number, difficulty: EnemyDifficulty, intensity: BattleIntensity): number => {
  const byLevel: Record<number, Record<EnemyDifficulty, number>> = {
    1: { story: 25, standard: 50, deadly: 100 },
    2: { story: 50, standard: 100, deadly: 200 },
    3: { story: 100, standard: 200, deadly: 450 },
    4: { story: 200, standard: 450, deadly: 700 },
    5: { story: 450, standard: 700, deadly: 1100 },
  };
  const base = (byLevel[Math.max(1, Math.min(5, level))] ?? byLevel[1])[difficulty];
  const intensityBonus: Record<BattleIntensity, number> = { low: 0.85, medium: 1, high: 1.15 };
  return Math.max(10, Math.round(base * intensityBonus[intensity]));
};
