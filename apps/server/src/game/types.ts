export type ImageProfile = "npc" | "portrait" | "scene" | "creature" | "item";

export type SupportedSystem = "dnd5e-srd";

export type EnemyDifficulty = "story" | "standard" | "deadly";

export type BattleIntensity = "low" | "medium" | "high";

export type GmKindness = "merciful" | "balanced" | "grim";

export type SessionStatus = "lobby" | "preparing" | "active";

export type ChatKind = "system" | "action" | "speech" | "whisper" | "question" | "gm" | "roll";

export type CampaignMemoryKind = "summary" | "location" | "quest" | "event" | "npc" | "faction" | "secret" | "promise" | "consequence";

export type RoomSetup = {
  systemId: SupportedSystem;
  startingLevel: number;
  npcCompanions: number;
  enemyDifficulty: EnemyDifficulty;
  battleIntensity: BattleIntensity;
  gmKindness: GmKindness;
  hostPlayerId?: string;
};

export type InventoryState = {
  equipped: string[];
  backpack: string[];
  gold: number;
};

export type LimitedResourceState = {
  label: string;
  used: number;
  max: number;
  recovery: "short_rest" | "long_rest";
};

export type PlayerResources = {
  limited: Record<string, LimitedResourceState>;
  conditions: string[];
};

export type PlayerLoreCategory =
  | "origin"
  | "motivation"
  | "turning_point"
  | "connection"
  | "reputation"
  | "favor"
  | "crime"
  | "bond"
  | "title"
  | "achievement"
  | "enemy"
  | "promise"
  | "consequence";

export type PlayerLoreImportance = "notable" | "major" | "legendary";

export type MoralProfile = {
  compassion: number;
  cruelty: number;
  honesty: number;
  deceit: number;
  lawfulness: number;
  chaos: number;
  courage: number;
  selfishness: number;
  label: string;
};

export type PlayerLoreEvent = {
  id: string;
  category: PlayerLoreCategory;
  title: string;
  summary: string;
  importance: PlayerLoreImportance;
  location?: string;
  peopleInvolved?: string[];
  consequence?: string;
  moralDelta?: Partial<Omit<MoralProfile, "label">>;
  createdAt: string;
  lastReferencedAt?: string;
};

export type Player = {
  id: string;
  controller?: "human" | "ai";
  name: string;
  characterName: string;
  appearanceDescription: string;
  physicalDescription: string;
  weaponDescription: string;
  outfitDescription: string;
  className: string;
  species: string;
  gender?: "male" | "female";
  background: string;
  origin?: string;
  motivation?: string;
  turningPoint?: string;
  connections?: string;
  backstory?: string;
  level: number;
  classLevels: Record<string, number>;
  experiencePoints: number;
  nextLevelExperience: number | null;
  pendingLevelUps: number;
  attributes: Record<string, number>;
  skills: Record<string, number>;
  hitPoints: number;
  maxHitPoints: number;
  armorClass: number;
  proficiencyBonus: number;
  ready: boolean;
  notes: string;
  portraitAssetUrl?: string;
  inventory: InventoryState;
  spells: string[];
  features: string[];
  resources: PlayerResources;
  loreEvents: PlayerLoreEvent[];
  moralProfile: MoralProfile;
  aiPersonality?: string;
  aiGoal?: string;
};

export type CombatActor = {
  id: string;
  actorId: string;
  actorName: string;
  side: "player" | "enemy";
  initiative: number;
};

export type EnemyState = {
  id: string;
  catalogId?: string;
  name: string;
  hitPoints: number;
  maxHitPoints: number;
  threat: number;
  xpValue: number;
  armorClass: number;
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
};

export type CombatState = {
  active: boolean;
  round: number;
  currentTurnIndex: number;
  order: CombatActor[];
  /**
   * Active enemies in the encounter. Encounters with a single enemy keep
   * a length-1 array. Defeated enemies are filtered out as their HP reaches 0.
   */
  enemies: EnemyState[];
  log: string[];
  lastOutcome?: string;
};

export type ChatRole = "system" | "gm" | "player";

export type ChatMessage = {
  id: string;
  roomId: string;
  role: ChatRole;
  kind: ChatKind;
  authorName: string;
  content: string;
  rawContent?: string;
  createdAt: string;
};

export type ImageJob = {
  id: string;
  roomId: string;
  status: "queued" | "done";
  profile: ImageProfile;
  prompt: string;
  subjectName?: string;
  negativePrompt?: string;
  seed?: number;
  assetUrl?: string;
  messageId?: string;
};

export type NpcStatus = "active" | "unconscious" | "dead";

export type SceneNpc = {
  name: string;
  role: string;
  description: string;
  className?: string;
  race?: string;
  level?: number;
  portraitAssetUrl?: string;
  hitPoints?: number;
  maxHitPoints?: number;
  armorClass?: number;
  status?: NpcStatus;
  relation?: "scene" | "companion";
};

export type RollRequest = {
  skill: string;
  die: "d4" | "d6" | "d8" | "d10" | "d12" | "d20";
  diceCount?: number;
  modifier: number;
  difficulty: number;
  description: string;
  advantage?: "advantage" | "disadvantage" | null;
};

export type RollRequestKind = "skill_check" | "combat_attack" | "combat_damage" | "combat_defense";

export type PendingRollRequest = RollRequest & {
  playerName: string;
  requestedAt: string;
  kind?: RollRequestKind;
  targetEnemyId?: string;
  targetEnemyName?: string;
  sourceAction?: string;
  damageDie?: "d4" | "d6" | "d8" | "d10" | "d12";
  damageDiceCount?: number;
  damageModifier?: number;
  damageType?: string;
  extraDamageDie?: "d4" | "d6" | "d8" | "d10" | "d12";
  extraDamageDiceCount?: number;
  extraDamageLabel?: string;
  isBonusDamage?: boolean;
};

export type StoryArcState = {
  title: string;
  premise: string;
  phase: "opening" | "investigation" | "travel" | "complication" | "confrontation" | "aftermath";
  openQuestions: string[];
  knownClues: string[];
  activeThreats: string[];
  npcAgendas: string[];
  completedBeats: string[];
  tensionLevel: number;
  recentCombatsSinceLongRest: number;
  restRecommendation?: string;
  nextSessionHook?: string;
};

export type SceneState = {
  title: string;
  summary: string;
  activeQuest?: string;
  combatRound?: number;
  activeNpcs?: SceneNpc[];
  partyContext?: string;
  pendingRollRequest?: PendingRollRequest | null;
  storyArc?: StoryArcState;
};

export type CampaignMemoryEntry = {
  id: string;
  kind: CampaignMemoryKind;
  title: string;
  content: string;
  tags: string[];
  importance: number;
  createdAt: string;
  updatedAt: string;
  lastReferencedAt?: string;
};

export type CampaignMemoryState = {
  entries: CampaignMemoryEntry[];
  summary: string;
  updatedAt?: string;
};

export type RoomState = {
  id: string;
  code: string;
  name: string;
  status: SessionStatus;
  setup: RoomSetup;
  players: Player[];
  messages: ChatMessage[];
  scene: SceneState;
  combat: CombatState;
  imageJobs: ImageJob[];
  memory: CampaignMemoryState;
};

export type PlayerAction = {
  playerId: string;
  content: string;
};

export type DiceRollRequest = {
  playerId: string;
  count: number;
  sides: 4 | 6 | 8 | 10 | 12 | 20;
  modifier: number;
  results: number[];
};

export type CharacterCreation = {
  name: string;
  characterName: string;
  appearanceDescription: string;
  physicalDescription: string;
  weaponDescription: string;
  outfitDescription: string;
  className: string;
  species: string;
  gender?: "male" | "female";
  background: string;
  origin?: string;
  motivation?: string;
  turningPoint?: string;
  connections?: string;
  backstory?: string;
  portraitAssetUrl?: string;
  attributeOverrides?: Record<string, number>;
  skillProficiencies?: string[];
  spellSelection?: string[];
  equipmentChoice?: number;
};

export type NpcHealthUpdate = {
  npcName: string;
  hitPoints: number;
  status: NpcStatus;
};

export type GmResponse = {
  narration: string;
  sceneSummary: string;
  ruleOutcome: string;
  imageJobs: Array<{
    profile: ImageProfile;
    prompt: string;
  }>;
  npcActions?: Array<{ npcName: string; narration: string }>;
  joiningNpcs?: Array<{ name: string; role: string; description: string; className?: string; race?: string; level?: number }>;
  rollRequest?: RollRequest | null;
  npcHealthUpdates?: NpcHealthUpdate[];
};

export type IntegrationStatus = {
  provider: string;
  baseUrl: string;
  ok: boolean;
  mode: "live" | "fallback";
  details?: string;
};
