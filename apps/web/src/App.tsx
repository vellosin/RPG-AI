import { CSSProperties, FormEvent, useLayoutEffect, useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { io, Socket } from "socket.io-client";
import type { CampaignMemoryEntry, ChatKind, ChatMessage, CombatState, GmAudioEvent, ImageJob, IntegrationStatus, LlmStatsResponse, LobbyOptions, MemoryIntegrationStatus, PendingRollRequest, Player, RoomSetup, RoomState, AdventureSuggestion, SceneNpc } from "./types";
import { getEquipmentInfo } from "./equipmentCatalog";

const configuredApiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").trim();
const apiBaseUrl = configuredApiBaseUrl || (import.meta.env.DEV ? "http://127.0.0.1:8787" : window.location.origin);
const sessionKey = "local-rpg-ai-client";
const silentAudioDataUri = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQQAAAAAAA==";
const visibleAudioTtlMs = 120_000;

const socket: Socket = io(apiBaseUrl, {
  autoConnect: true,
});

type ClientSession = {
  roomId: string;
  roomCode: string;
  playerId: string;
  playerName: string;
  characterName: string;
};

type SetupDraft = Omit<RoomSetup, "hostPlayerId">;

type CharacterDraft = {
  name: string;
  characterName: string;
  className: string;
  species: string;
  background: string;
  gender: "male" | "female";
  appearanceDescription: string;
  physicalDescription: string;
  weaponDescription: string;
  outfitDescription: string;
  origin: string;
  motivation: string;
  turningPoint: string;
  connections: string;
  backstory: string;
  portraitUrl: string;
};

type VisibleAudioClip = GmAudioEvent & {
  expiresAt: number;
};

type DieKind = 4 | 6 | 8 | 10 | 12 | 20;

type DieResult = {
  id: string;
  sides: DieKind;
  value: number;
  revealed: boolean;
};

type DiceRollState = {
  status: "idle" | "rolling" | "revealed";
  label: string;
  modifier: number;
  dice: DieResult[];
  total?: number;
};

type GmStreamEvent =
  | { streamId: string; status: "start"; authorName?: string }
  | { streamId: string; status: "chunk"; chunk: string }
  | { streamId: string; status: "done" };

const readSession = (): ClientSession | null => {
  const raw = window.sessionStorage.getItem(sessionKey);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as ClientSession;
  } catch {
    return null;
  }
};

const deriveInputKind = (value: string): ChatKind => {
  const trimmed = value.trim();
  if (trimmed.startsWith("*")) {
    return "action";
  }
  if (trimmed.startsWith("-")) {
    return "speech";
  }
  if (trimmed.startsWith('"')) {
    return "whisper";
  }
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    return "question";
  }
  return "action";
};

const messagePrefix: Record<ChatKind, string> = {
  system: "Sistema",
  action: "Ação",
  speech: "Fala",
  whisper: "Sussurro",
  question: "Pergunta",
  gm: "Mestre",
  roll: "Rolagem",
};

const commonDice: DieKind[] = [4, 6, 8, 10, 12, 20];

const randomDieValue = (sides: DieKind): number => Math.max(1, Math.floor(Math.random() * sides) + 1);

const buildDicePool = (count: number, sides: DieKind): DieResult[] => Array.from({ length: count }, (_, index) => ({
  id: `${sides}-${index}-${crypto.randomUUID()}`,
  sides,
  value: randomDieValue(sides),
  revealed: false,
}));

const toAssetUrl = (assetUrl: string): string => assetUrl.startsWith("http") ? assetUrl : `${apiBaseUrl}${assetUrl}`;

const findPendingPortraitJob = (room: RoomState, player: Player): ImageJob | undefined => room.imageJobs.find(
  (job) => job.profile === "portrait" && job.status === "queued" && job.subjectName === player.characterName,
);

const summarizePendingImages = (jobs: ImageJob[]): string => {
  if (jobs.length === 0) {
    return "";
  }

  const labels = jobs.reduce<Record<string, number>>((counts, job) => {
    counts[job.profile] = (counts[job.profile] ?? 0) + 1;
    return counts;
  }, {});

  return Object.entries(labels)
    .map(([profile, count]) => `${count} ${profile}`)
    .join(" · ");
};

export function App() {
  const initialSession = readSession();
  const [room, setRoom] = useState<RoomState | null>(null);
  const [rooms, setRooms] = useState<RoomState[]>([]);
  const [playerId, setPlayerId] = useState(initialSession?.playerId ?? "");
  const [roomCode, setRoomCode] = useState(initialSession?.roomCode ?? "");
  const [status, setStatus] = useState("Crie uma sessão ou carregue uma existente.");
  const [integrations, setIntegrations] = useState<{ jan: IntegrationStatus; image: IntegrationStatus; memory?: MemoryIntegrationStatus } | null>(null);
  const [lobbyOptions, setLobbyOptions] = useState<LobbyOptions | null>(null);
  const [setupDraft, setSetupDraft] = useState<SetupDraft>({
    systemId: "dnd5e-srd",
    startingLevel: 1,
    npcCompanions: 0,
    enemyDifficulty: "standard",
    battleIntensity: "medium",
    gmKindness: "balanced",
  });
  const [roomName, setRoomName] = useState("");
  const [isGeneratingPortraitPreview, setIsGeneratingPortraitPreview] = useState(false);
  const [characterDraft, setCharacterDraft] = useState<CharacterDraft>({
    name: initialSession?.playerName ?? "Lucas",
    characterName: initialSession?.characterName ?? "Aldren",
    className: "Fighter",
    species: "Human",
    background: "Soldier",
    gender: "male",
    appearanceDescription: "",
    physicalDescription: "",
    weaponDescription: "",
    outfitDescription: "",
    origin: "",
    motivation: "",
    turningPoint: "",
    connections: "",
    backstory: "",
    portraitUrl: "",
  });
  const [chatInput, setChatInput] = useState("*avanço contra o inimigo com a espada erguida");
  const [activePanel, setActivePanel] = useState<"sheet" | "inventory" | "lore" | "notes" | null>(null);
  const [notesDraft, setNotesDraft] = useState("");
  const [diceCount, setDiceCount] = useState(1);
  const [diceSides, setDiceSides] = useState<DieKind>(20);
  const [diceModifier, setDiceModifier] = useState(0);
  const [diceRoll, setDiceRoll] = useState<DiceRollState>({
    status: "idle",
    label: "Pronto para rolar",
    modifier: 0,
    dice: [],
  });
  const [isSending, setIsSending] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [llmStatsOpen, setLlmStatsOpen] = useState(false);
  const [llmStats, setLlmStats] = useState<LlmStatsResponse | null>(null);
  const [streamingNarrations, setStreamingNarrations] = useState<Record<string, string>>({});
  // TTS: o usuário precisa habilitar uma vez (autoplay policy do browser) e depois
  // todos os eventos `room:gmAudio` entram numa fila tocada sequencialmente.
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [audioClips, setAudioClips] = useState<VisibleAudioClip[]>([]);
  const audioQueueRef = useRef<GmAudioEvent[]>([]);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const isPlayingRef = useRef(false);
  const [preparationStep, setPreparationStep] = useState("");
  const [preparationProgress, setPreparationProgress] = useState(0);
  const [suggestions, setSuggestions] = useState<AdventureSuggestion[] | null>(null);
  const [selectedSuggestion, setSelectedSuggestion] = useState<AdventureSuggestion | null>(null);
  const [isFetchingSuggestions, setIsFetchingSuggestions] = useState(false);
  const [charCreationStep, setCharCreationStep] = useState<1 | 2 | 3 | 4 | 5 | 6 | 7>(1);
  const [attributeDraft, setAttributeDraft] = useState<Record<string, number>>({
    strength: 8, agility: 8, mind: 8, presence: 8, constitution: 8, wisdom: 8,
  });
  const [skillDraft, setSkillDraft] = useState<string[]>([]);
  const [spellDraft, setSpellDraft] = useState<string[]>([]);
  const [equipChoiceIdx, setEquipChoiceIdx] = useState<number>(0);

  useEffect(() => {
    const handleSnapshot = (snapshot: RoomState) => {
      setRoom(snapshot);
      const localPlayer = snapshot.players.find((entry) => entry.id === playerId);
      setNotesDraft(localPlayer?.notes ?? "");
    };
    const handleMessages = (incoming: ChatMessage[]) => {
      setRoom((current) => current ? { ...current, messages: [...current.messages, ...incoming] } : current);
      const finalGmMessage = incoming.find((message) => message.role === "gm" && message.authorName === "Game Master");
      if (finalGmMessage) {
        setAudioClips((current) => current.map((clip) =>
          clip.messageId ? clip : { ...clip, messageId: finalGmMessage.id }
        ));
        setStreamingNarrations({});
      }
    };
    const handleScene = (scene: RoomState["scene"]) => {
      setRoom((current) => current ? { ...current, scene } : current);
    };
    const handleImage = (job: ImageJob) => {
      setRoom((current) => current ? {
        ...current,
        imageJobs: current.imageJobs.some((entry) => entry.id === job.id)
          ? current.imageJobs.map((entry) => (entry.id === job.id ? job : entry))
          : [...current.imageJobs, job],
      } : current);
    };
    const handlePlayers = (players: Player[]) => {
      setRoom((current) => current ? { ...current, players } : current);
      const localPlayer = players.find((entry) => entry.id === playerId);
      setNotesDraft(localPlayer?.notes ?? "");
    };
    const handleCombat = (combat: CombatState) => {
      setRoom((current) => current ? { ...current, combat } : current);
    };
    const handleImageJobs = (imageJobs: ImageJob[]) => {
      setRoom((current) => current ? { ...current, imageJobs } : current);
    };
    const handlePreparationStep = ({ step, progress }: { step: string; progress: number }) => {
      setPreparationStep(step);
      setPreparationProgress(progress);
    };
    const handleGmStream = (event: GmStreamEvent) => {
      if (event.status === "start") {
        setStreamingNarrations((current) => ({ ...current, [event.streamId]: "" }));
        return;
      }
      if (event.status === "chunk") {
        setStreamingNarrations((current) => ({
          ...current,
          [event.streamId]: `${current[event.streamId] ?? ""}${event.chunk}`,
        }));
        return;
      }
      setStreamingNarrations((current) => {
        const next = { ...current };
        delete next[event.streamId];
        return next;
      });
    };

    const playNextAudio = (): void => {
      if (isPlayingRef.current) return;
      const next = audioQueueRef.current.shift();
      if (!next) return;
      const audio = audioElementRef.current;
      if (!audio) return;

      isPlayingRef.current = true;
      audio.src = `${apiBaseUrl}${next.audioUrl}`;
      audio.play().catch(() => {
        // Falha no play (autoplay bloqueado, áudio expirado, etc.). Pula essa frase.
        isPlayingRef.current = false;
        playNextAudio();
      });
    };

    const handleGmAudio = (event: GmAudioEvent): void => {
      setAudioClips((current) => {
        const clip: VisibleAudioClip = { ...event, expiresAt: Date.now() + visibleAudioTtlMs };
        const withoutDuplicate = current.filter((entry) => entry.audioId !== event.audioId && entry.expiresAt > Date.now());
        return [...withoutDuplicate, clip].sort((a, b) =>
          (a.messageId ?? a.streamId).localeCompare(b.messageId ?? b.streamId) || a.sequence - b.sequence
        );
      });
      window.setTimeout(() => {
        setAudioClips((current) => current.filter((entry) => entry.audioId !== event.audioId));
      }, visibleAudioTtlMs);
      if (!ttsEnabled) return;
      // Insere mantendo ordem por sequence dentro do mesmo streamId.
      const queue = audioQueueRef.current;
      const insertIndex = queue.findIndex((entry) => entry.streamId === event.streamId && entry.sequence > event.sequence);
      if (insertIndex === -1) {
        queue.push(event);
      } else {
        queue.splice(insertIndex, 0, event);
      }
      playNextAudio();
    };

    const handleGmAudioCancel = (): void => {
      audioQueueRef.current = [];
      setAudioClips([]);
      const audio = audioElementRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      isPlayingRef.current = false;
    };

    socket.on("room:snapshot", handleSnapshot);
    socket.on("room:messages", handleMessages);
    socket.on("room:scene", handleScene);
    socket.on("room:image", handleImage);
    socket.on("room:players", handlePlayers);
    socket.on("room:combat", handleCombat);
    socket.on("room:imageJobs", handleImageJobs);
    socket.on("room:preparationStep", handlePreparationStep);
    socket.on("room:gmStream", handleGmStream);
    socket.on("room:gmAudio", handleGmAudio);
    socket.on("room:gmAudioCancel", handleGmAudioCancel);

    // Avança a fila quando uma frase termina de tocar.
    const audio = audioElementRef.current;
    const handleAudioEnded = (): void => {
      isPlayingRef.current = false;
      playNextAudio();
    };
    audio?.addEventListener("ended", handleAudioEnded);
    audio?.addEventListener("error", handleAudioEnded);

    return () => {
      socket.off("room:snapshot", handleSnapshot);
      socket.off("room:messages", handleMessages);
      socket.off("room:scene", handleScene);
      socket.off("room:image", handleImage);
      socket.off("room:players", handlePlayers);
      socket.off("room:combat", handleCombat);
      socket.off("room:imageJobs", handleImageJobs);
      socket.off("room:preparationStep", handlePreparationStep);
      socket.off("room:gmStream", handleGmStream);
      socket.off("room:gmAudio", handleGmAudio);
      socket.off("room:gmAudioCancel", handleGmAudioCancel);
      audio?.removeEventListener("ended", handleAudioEnded);
      audio?.removeEventListener("error", handleAudioEnded);
    };
  }, [playerId, ttsEnabled]);

  useEffect(() => {
    const loadInitialData = async () => {
      const [roomsResponse, integrationsResponse, lobbyOptionsResponse] = await Promise.all([
        fetch(`${apiBaseUrl}/api/rooms`),
        fetch(`${apiBaseUrl}/api/integrations`),
        fetch(`${apiBaseUrl}/api/lobby-options`),
      ]);

      if (roomsResponse.ok) {
        setRooms(await roomsResponse.json());
      }
      if (integrationsResponse.ok) {
        setIntegrations(await integrationsResponse.json());
      }
      if (lobbyOptionsResponse.ok) {
        const payload: LobbyOptions = await lobbyOptionsResponse.json();
        setLobbyOptions(payload);
        setSetupDraft(payload.defaults);
        setCharacterDraft((current) => ({
          ...current,
          className: payload.options.classes[0] ?? current.className,
          species: payload.options.species[0] ?? current.species,
          background: payload.options.backgrounds[0] ?? current.background,
        }));
      }
    };

    void loadInitialData();
  }, []);

  useEffect(() => {
    if (!initialSession?.roomId) {
      return;
    }

    const restore = async () => {
      const response = await fetch(`${apiBaseUrl}/api/rooms/${initialSession.roomId}`);
      if (!response.ok) {
        window.sessionStorage.removeItem(sessionKey);
        return;
      }

      const payload: RoomState = await response.json();
      setRoom(payload);
      socket.emit("room:subscribe", payload.id);
      const localPlayer = payload.players.find((entry) => entry.id === initialSession.playerId);
      if (localPlayer) {
        setCharacterDraft((current) => ({
          ...current,
          name: localPlayer.name,
          characterName: localPlayer.characterName,
          className: localPlayer.className,
          species: localPlayer.species,
          background: localPlayer.background,
          origin: localPlayer.origin ?? "",
          motivation: localPlayer.motivation ?? "",
          turningPoint: localPlayer.turningPoint ?? "",
          connections: localPlayer.connections ?? "",
          backstory: localPlayer.backstory ?? "",
        }));
        setNotesDraft(localPlayer.notes);
        setStatus(`Sessão restaurada para ${localPlayer.characterName}.`);
      } else {
        setPlayerId("");
        window.sessionStorage.removeItem(sessionKey);
      }
    };

    void restore();
  }, []);

  // Re-subscribe to the room after socket reconnects (e.g. after SDXL generation delay)
  useEffect(() => {
    if (!room?.id) {
      return;
    }

    const roomId = room.id;
    const handleReconnect = () => {
      socket.emit("room:subscribe", roomId);
    };

    socket.on("connect", handleReconnect);
    return () => {
      socket.off("connect", handleReconnect);
    };
  }, [room?.id]);

  useEffect(() => {
    if (!room || !playerId) {
      return;
    }

    window.sessionStorage.setItem(sessionKey, JSON.stringify({
      roomId: room.id,
      roomCode: room.code,
      playerId,
      playerName: characterDraft.name,
      characterName: characterDraft.characterName,
    } satisfies ClientSession));
  }, [room, playerId, characterDraft.name, characterDraft.characterName]);

  // Auto-configure dice panel when a roll is requested
  const pendingRoll: PendingRollRequest | null | undefined = room?.scene.pendingRollRequest;
  useEffect(() => {
    if (!pendingRoll) return;
    const sideMap: Record<string, DieKind> = { d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20 };
    const sides = sideMap[pendingRoll.die] ?? 20;
    setDiceSides(sides as DieKind);
    setDiceCount(pendingRoll.advantage ? 2 : (pendingRoll.diceCount ?? pendingRoll.damageDiceCount ?? 1));
    setDiceModifier(pendingRoll.modifier);
  }, [pendingRoll?.die, pendingRoll?.modifier, pendingRoll?.advantage, pendingRoll?.diceCount, pendingRoll?.damageDiceCount]);

  const localPlayer = room?.players.find((entry) => entry.id === playerId) ?? null;
  const isHost = Boolean(localPlayer && room?.setup.hostPlayerId === localPlayer.id);
  const allReady = Boolean(room && room.players.length >= 1 && room.players.every((entry) => entry.ready));
  const currentTurn = room?.combat.order[room.combat.currentTurnIndex];
  const localInputKind = deriveInputKind(chatInput);
  const canSendChat = Boolean(room && room.status === "active" && playerId && (localInputKind !== "action" || !room.combat.active || currentTurn?.actorId === playerId));
  const pendingImageJobs = room?.imageJobs.filter((job) => job.status === "queued") ?? [];
  const pendingImageSummary = summarizePendingImages(pendingImageJobs);
  const recentMessages = room?.messages.slice(-14) ?? [];
  const streamingEntries = Object.entries(streamingNarrations);

  // Build a map of messageId → ImageJob[] so each job can be rendered inline in its message
  const jobsByMessage = new Map<string, ImageJob[]>();
  for (const job of room?.imageJobs ?? []) {
    if (job.messageId) {
      const arr = jobsByMessage.get(job.messageId) ?? [];
      arr.push(job);
      jobsByMessage.set(job.messageId, arr);
    }
  }
  // Orphan jobs (no messageId — e.g. portraits or legacy) kept for the right-panel gallery
  const orphanImageJobs = (room?.imageJobs ?? []).filter((j) => !j.messageId && j.profile !== "portrait").slice(-2).reverse();

  const refreshRooms = async () => {
    const response = await fetch(`${apiBaseUrl}/api/rooms`);
    if (response.ok) {
      setRooms(await response.json());
    }
  };

  const createRoom = async (event: FormEvent) => {
    event.preventDefault();
    const response = await fetch(`${apiBaseUrl}/api/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: roomName, setup: setupDraft }),
    });
    const payload: RoomState = await response.json();
    setRoom(payload);
    setRoomCode(payload.code);
    socket.emit("room:subscribe", payload.id);
    setStatus(`Sessão ${payload.name} criada. Agora crie o personagem do anfitrião.`);
    await refreshRooms();
  };

  const loadRoomByCode = async (event: FormEvent) => {
    event.preventDefault();
    const response = await fetch(`${apiBaseUrl}/api/rooms/by-code/${roomCode}`);
    if (!response.ok) {
      setStatus("Código de sessão não encontrado.");
      return;
    }

    const payload: RoomState = await response.json();
    setRoom(payload);
    socket.emit("room:subscribe", payload.id);
    setStatus(`Sessão ${payload.name} carregada.`);
  };

  const deleteSavedRoom = async (entry: RoomState) => {
    const confirmed = window.confirm(`Excluir a sessão "${entry.name}" (${entry.code})? Essa ação remove a sala e o histórico dela.`);
    if (!confirmed) return;

    const response = await fetch(`${apiBaseUrl}/api/rooms/${entry.id}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      setStatus("Não foi possível excluir a sessão agora.");
      return;
    }

    setRooms((current) => current.filter((roomEntry) => roomEntry.id !== entry.id));
    if (room?.id === entry.id) {
      setRoom(null);
      setPlayerId("");
      window.sessionStorage.removeItem(sessionKey);
    }
    setStatus(`Sessão ${entry.name} excluída.`);
    await refreshRooms();
  };

  const joinRoom = async (event: FormEvent) => {
    event.preventDefault();
    if (!room) {
      return;
    }

    const response = await fetch(`${apiBaseUrl}/api/rooms/${room.id}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...characterDraft,
        attributeOverrides: attributeDraft,
        skillProficiencies: skillDraft.length > 0 ? skillDraft : undefined,
        spellSelection: spellDraft.length > 0 ? spellDraft : undefined,
        equipmentChoice: equipChoiceIdx,
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setStatus(payload.message ?? "Não foi possível entrar na sessão.");
      return;
    }

    setPlayerId(payload.player.id);
    setRoom(payload.room);
    setRoomCode(payload.room.code);
    socket.emit("room:subscribe", payload.room.id);
    setNotesDraft(payload.player.notes ?? "");
    setStatus(`${payload.player.characterName} entrou na sessão.${characterDraft.portraitUrl ? "" : " Retrato em geração."}`);
    await refreshRooms();
  };

  const generatePortraitPreview = async () => {
    if (isGeneratingPortraitPreview) return;
    setIsGeneratingPortraitPreview(true);
    setStatus("Gerando retrato com as descrições do personagem...");
    try {
      const response = await fetch(`${apiBaseUrl}/api/portrait-preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...characterDraft,
          attributeOverrides: attributeDraft,
          skillProficiencies: skillDraft.length > 0 ? skillDraft : undefined,
          spellSelection: spellDraft.length > 0 ? spellDraft : undefined,
          equipmentChoice: equipChoiceIdx,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setStatus(payload.message ?? "Não foi possível gerar o retrato.");
        return;
      }
      setCharacterDraft((current) => ({ ...current, portraitUrl: payload.assetUrl }));
      setStatus("Retrato gerado. Você pode entrar com ele ou alterar descrições e gerar outro.");
    } catch {
      setStatus("Falha de rede ao gerar retrato.");
    } finally {
      setIsGeneratingPortraitPreview(false);
    }
  };

  const setReady = async (ready: boolean) => {
    if (!room || !localPlayer) {
      return;
    }

    const response = await fetch(`${apiBaseUrl}/api/rooms/${room.id}/players/${localPlayer.id}/ready`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ready }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setStatus(payload.message ?? "Não foi possível alterar a prontidão.");
      return;
    }

    setRoom(payload);
    setStatus(ready ? "Você está pronto." : "Você não está mais pronto.");
    await refreshRooms();
  };

  const fetchSuggestions = async () => {
    if (!room) return;
    setIsFetchingSuggestions(true);
    setStatus("O Mestre está preparando as sugestões de aventura...");
    try {
      const response = await fetch(`${apiBaseUrl}/api/rooms/${room.id}/suggestions`);
      const payload = await response.json();
      if (response.ok && Array.isArray(payload)) {
        setSuggestions(payload as AdventureSuggestion[]);
      } else {
        setSuggestions([]);
      }
    } catch {
      setSuggestions([]);
    } finally {
      setIsFetchingSuggestions(false);
      setStatus("");
    }
  };

  const startSession = async (hook?: string, sceneKeyword?: string, adventureTitle?: string) => {
    if (!room || !localPlayer) {
      return;
    }

    const response = await fetch(`${apiBaseUrl}/api/rooms/${room.id}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostPlayerId: localPlayer.id, adventureHook: hook, sceneKeyword, adventureTitle }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setStatus(payload.message ?? "Não foi possível iniciar a sessão.");
      return;
    }

    setSuggestions(null);
    setSelectedSuggestion(null);
    setRoom(payload);
    setPreparationStep("O Mestre convoca a aventura...");
    setStatus("Preparando a sessão. Aguarde enquanto o Mestre organiza o mundo.");
    await refreshRooms();
  };

  const saveNotes = async () => {
    if (!room || !localPlayer) {
      return;
    }

    const response = await fetch(`${apiBaseUrl}/api/rooms/${room.id}/players/${localPlayer.id}/notes`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: notesDraft }),
    });
    const payload = await response.json();
    if (!response.ok) {
      setStatus(payload.message ?? "Não foi possível salvar as anotações.");
      return;
    }

    setRoom((current) => current ? {
      ...current,
      players: current.players.map((entry) => (entry.id === payload.id ? payload : entry)),
    } : current);
    setStatus("Anotações salvas.");
  };

  /**
   * Asks the server to discard the last GM response and re-roll the turn.
   * Host-only — the server enforces this too.
   */
  const applyLevelUp = async (className: string, choices?: { newSkillProficiencies?: string[]; newSpells?: string[] }) => {
    if (!room || !localPlayer) return;
    setStatus(`Aplicando nível de ${className}...`);
    try {
      const response = await fetch(`${apiBaseUrl}/api/rooms/${room.id}/players/${localPlayer.id}/level-up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ className, ...(choices ?? {}) }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setStatus(payload.message ?? "Não foi possível aplicar o nível.");
        return;
      }
      setRoom(payload);
      setStatus(`Nível de ${className} aplicado. Ficha atualizada.`);
    } catch {
      setStatus("Falha de rede ao aplicar nível.");
    }
  };

  const regeneratePortrait = async () => {
    if (!room || !localPlayer) return;
    setStatus("Gerando novo retrato do personagem...");
    try {
      const response = await fetch(`${apiBaseUrl}/api/rooms/${room.id}/players/${localPlayer.id}/regenerate-portrait`, {
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        setStatus(payload.message ?? "Não foi possível regenerar o retrato.");
        return;
      }
      setRoom(payload);
      setStatus("Novo retrato entrou na fila.");
    } catch {
      setStatus("Falha de rede ao regenerar retrato.");
    }
  };

  const handleRegenerate = async () => {
    if (!room || !playerId || !isHost || isRegenerating) return;
    setIsRegenerating(true);
    setStatus("Pedindo ao Mestre para reconsiderar a cena…");
    try {
      const response = await fetch(`${apiBaseUrl}/api/rooms/${room.id}/regenerate-last-gm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestingPlayerId: playerId }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setStatus((payload as { message?: string }).message ?? "Não foi possível regenerar a narração.");
      } else {
        setStatus("Narração regenerada.");
      }
    } catch {
      setStatus("Falha de rede ao regenerar.");
    } finally {
      setIsRegenerating(false);
    }
  };

  const refreshLlmStats = async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/llm-stats?limit=30`);
      if (response.ok) {
        const data = (await response.json()) as LlmStatsResponse;
        setLlmStats(data);
      }
    } catch {
      // best-effort
    }
  };

  const sendChat = async (event: FormEvent) => {
    event.preventDefault();
    if (!room || !playerId || isSending) {
      return;
    }

    if (!canSendChat) {
      setStatus(`Agora é a vez de ${currentTurn?.actorName ?? "outro participante"}.`);
      return;
    }

    const inputSnapshot = chatInput;
    setChatInput(""); // clear immediately for visual feedback
    setIsSending(true);

    try {
      const response = await fetch(`${apiBaseUrl}/api/rooms/${room.id}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId, content: inputSnapshot }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        setChatInput(inputSnapshot); // restore on error so user can retry
        setStatus((payload as { message?: string }).message ?? "Não foi possível enviar a mensagem.");
      }
      // Success: socket events (room:messages, room:scene, etc.) handle all state updates
    } catch {
      setChatInput(inputSnapshot);
      setStatus("Não foi possível enviar a mensagem.");
    } finally {
      setIsSending(false);
    }
  };

  const insertChatPrefix = (prefix: string) => {
    setChatInput((current) => {
      const trimmed = current.trimStart();
      if (!trimmed) {
        return prefix;
      }
      if (["*", "-", '"', "("].some((symbol) => trimmed.startsWith(symbol))) {
        return current;
      }
      return `${prefix}${current}`;
    });
  };

  const chooseSuggestedAction = (content: string) => {
    setChatInput(content);
    setStatus("Ação sugerida colocada na caixa de mensagem. Você pode editar antes de enviar.");
  };

  const clearLocalSession = () => {
    window.sessionStorage.removeItem(sessionKey);
    setPlayerId("");
    setActivePanel(null);
    setStatus("A identidade desta aba foi limpa. Agora você pode entrar como outro jogador.");
  };

  const rollDice = () => {
    if (!room || !playerId) {
      setStatus("Entre na sessão com um personagem para compartilhar rolagens.");
      return;
    }

    const pool = buildDicePool(diceCount, diceSides);
    setDiceRoll({
      status: "rolling",
      label: `Rolando ${diceCount}d${diceSides}...`,
      modifier: diceModifier,
      dice: pool.map((entry) => ({ ...entry, value: randomDieValue(entry.sides), revealed: false })),
    });

    const revealTimeouts = pool.map((die, index) => window.setTimeout(() => {
      setDiceRoll((current) => {
        if (current.status !== "rolling") {
          return current;
        }

        const nextDice = current.dice.map((entry) => entry.id === die.id ? { ...die, revealed: true } : entry);
        const allRevealed = nextDice.every((entry) => entry.revealed);
        if (!allRevealed) {
          return {
            ...current,
            label: `Parando... ${index + 1}/${pool.length}`,
            dice: nextDice,
          };
        }

        const useAdvantage =
          pendingRoll?.advantage &&
          diceSides === 20 &&
          nextDice.length >= 2;
        const subtotal = useAdvantage
          ? pendingRoll.advantage === "disadvantage"
            ? Math.min(...nextDice.map((entry) => entry.value))
            : Math.max(...nextDice.map((entry) => entry.value))
          : nextDice.reduce((sum, entry) => sum + entry.value, 0);
        return {
          ...current,
          status: "revealed",
          label: `Resultado revelado.`,
          dice: nextDice,
          total: subtotal + current.modifier,
        };
      });
    }, 700 + index * 450));

    window.setTimeout(() => {
      setDiceRoll((current) => {
        if (current.status !== "revealed") {
          return current;
        }

        void fetch(`${apiBaseUrl}/api/rooms/${room.id}/rolls`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            playerId,
            count: current.dice.length,
            sides: diceSides,
            modifier: current.modifier,
            results: current.dice.map((entry) => entry.value),
          }),
        }).then(async (response) => {
          if (!response.ok) {
            const payload = await response.json().catch(() => ({ message: "Não foi possível registrar a rolagem." }));
            setStatus((payload as { message?: string }).message ?? "Não foi possível registrar a rolagem.");
            return;
          }
          // Success: socket events handle state updates
          setStatus("Rolagem compartilhada com a mesa.");
        }).catch(() => {
          setStatus("Não foi possível registrar a rolagem.");
        });

        const useAdvantage =
          pendingRoll?.advantage &&
          diceSides === 20 &&
          current.dice.length >= 2;
        const effectiveD20 = useAdvantage
          ? pendingRoll.advantage === "disadvantage"
            ? Math.min(...current.dice.map((entry) => entry.value))
            : Math.max(...current.dice.map((entry) => entry.value))
          : null;
        const advantageLabel = useAdvantage
          ? ` (${pendingRoll.advantage === "disadvantage" ? "menor" : "maior"} d20: ${effectiveD20})`
          : "";
        return {
          ...current,
          label: `${current.dice.map((entry) => entry.value).join(" + ")}${advantageLabel}${current.modifier !== 0 ? ` ${current.modifier > 0 ? "+" : "-"} ${Math.abs(current.modifier)}` : ""} = ${current.total ?? 0}`,
        };
      });
      revealTimeouts.forEach((timeoutId) => window.clearTimeout(timeoutId));
    }, 700 + pool.length * 450 + 350);
  };

  const isActive = room?.status === "active";
  const isPreparing = room?.status === "preparing";

  return (
    <main className={`appShell${isActive ? " appShell-active" : ""}`}>
      <header className="topbar">
        <div className="topbar-title">
          <p className="eyebrow">Local-first AI RPG</p>
          <h1>{isActive ? room.name : "RPG — Lobby"}</h1>
        </div>

        {pendingImageJobs.length > 0 && (
          <span className="imagePendingBadge">
            <span className="loadingDot" aria-hidden="true" />
            {pendingImageJobs.length} imagem{pendingImageJobs.length > 1 ? "ns" : ""}{pendingImageSummary ? ` · ${pendingImageSummary}` : ""}
          </span>
        )}

        <p className="muted" style={{ fontSize: "0.76rem", maxWidth: 300 }}>{status}</p>

        <div className="topbar-sys">
          <span className={`sysDot${integrations?.jan.ok ? " sysDot-ok" : " sysDot-warn"}`}>
            <span style={{ width: 6, height: 6, borderRadius: "999px", background: "currentColor", display: "inline-block" }} />
            Jan
          </span>
          <span className={`sysDot${integrations?.image.ok ? " sysDot-ok" : " sysDot-warn"}`}>
            <span style={{ width: 6, height: 6, borderRadius: "999px", background: "currentColor", display: "inline-block" }} />
            Imagem
          </span>
          <span className={`sysDot${integrations?.memory?.ok ? " sysDot-ok" : " sysDot-warn"}`} title={integrations?.memory?.details}>
            <span style={{ width: 6, height: 6, borderRadius: "999px", background: "currentColor", display: "inline-block" }} />
            Memória
          </span>
        </div>

        <div className="topbar-actions">
          <button type="button" className="btn-ghost" onClick={clearLocalSession}>Limpar aba</button>
        </div>
      </header>

      {!room && (
        <section className="lobbyStage">
          <section className="lobbyCard">
            <h2>
              Nova campanha
              <span className="lobbyCard-step">passo 1</span>
            </h2>
            <p className="lobbyCard-lead">
              Defina a base do mundo. Você poderá ajustar tudo depois que entrar na sala.
            </p>
            <form onSubmit={createRoom} className="stack">
              <fieldset className="formSection">
                <legend>Sessão</legend>
                <div className="formField">
                  <label htmlFor="lobby-room-name">Nome da sessão</label>
                  <input id="lobby-room-name" value={roomName} placeholder="Ex.: A Coroa de Cinzas" onChange={(event) => setRoomName(event.target.value)} />
                </div>
              </fieldset>

              <fieldset className="formSection">
                <legend>Configuração da campanha</legend>
                <div className="formField">
                  <label>Sistema</label>
                  <select value={setupDraft.systemId} onChange={(event) => setSetupDraft((current) => ({ ...current, systemId: event.target.value as SetupDraft["systemId"] }))}>
                    {lobbyOptions?.options.systems.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                  </select>
                </div>
                <div className="formGrid-2">
                  <div className="formField">
                    <label>Nível inicial</label>
                    <select value={setupDraft.startingLevel} onChange={(event) => setSetupDraft((current) => ({ ...current, startingLevel: Number(event.target.value) }))}>
                      {[1, 2, 3, 4, 5].map((level) => <option key={level} value={level}>{level}</option>)}
                    </select>
                  </div>
                  <div className="formField">
                    <label>Companheiros NPC</label>
                    <select value={setupDraft.npcCompanions} onChange={(event) => setSetupDraft((current) => ({ ...current, npcCompanions: Number(event.target.value) }))}>
                      {lobbyOptions?.options.npcCompanions.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                    </select>
                  </div>
                </div>
              </fieldset>

              <fieldset className="formSection">
                <legend>Estilo de combate</legend>
                <div className="formGrid-2">
                  <div className="formField">
                    <label>Dificuldade dos inimigos</label>
                    <select value={setupDraft.enemyDifficulty} onChange={(event) => setSetupDraft((current) => ({ ...current, enemyDifficulty: event.target.value as SetupDraft["enemyDifficulty"] }))}>
                      {lobbyOptions?.options.difficulties.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                    </select>
                  </div>
                  <div className="formField">
                    <label>Intensidade das batalhas</label>
                    <select value={setupDraft.battleIntensity} onChange={(event) => setSetupDraft((current) => ({ ...current, battleIntensity: event.target.value as SetupDraft["battleIntensity"] }))}>
                      {lobbyOptions?.options.battleIntensity.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                    </select>
                  </div>
                </div>
              </fieldset>

              <fieldset className="formSection">
                <legend>Tom do mestre</legend>
                <div className="formField">
                  <label>Bondade do mestre</label>
                  <select value={setupDraft.gmKindness} onChange={(event) => setSetupDraft((current) => ({ ...current, gmKindness: event.target.value as SetupDraft["gmKindness"] }))}>
                    {lobbyOptions?.options.gmKindness.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
                  </select>
                  <p className="formField-hint">Influencia narração, recompensas e o quanto o Mestre "perdoa" erros táticos.</p>
                </div>
              </fieldset>

              <div className="lobbyCard-footer">
                <button type="submit" className="btn-lg btn-block">Criar sessão</button>
              </div>
            </form>
          </section>

          <section className="lobbyCard">
            <h2>Continuar uma sessão</h2>
            <p className="lobbyCard-lead">
              Use o código de uma sala existente ou retome uma das sessões salvas neste navegador.
            </p>
            <form onSubmit={loadRoomByCode} className="stack">
              <div className="formField">
                <label htmlFor="lobby-room-code">Código da sessão</label>
                <input
                  id="lobby-room-code"
                  value={roomCode}
                  placeholder="Ex.: QUMRE8"
                  style={{ fontFamily: "ui-monospace, monospace", letterSpacing: "0.18em" }}
                  onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
                />
              </div>
              <button type="submit" className="btn-lg btn-block">Carregar sala</button>
            </form>

            <div>
              <div className="savedList-header">
                <p className="sectionLabel">
                  Sessões salvas {rooms.length > 0 && <span className="faint" style={{ marginLeft: "0.4rem" }}>({rooms.length})</span>}
                </p>
                <button type="button" className="savedList-refresh" onClick={() => void refreshRooms()}>
                  Atualizar
                </button>
              </div>
              {rooms.length === 0 ? (
                <div className="savedList-empty">
                  Nenhuma sessão local ainda.<br />
                  Crie uma nova ao lado ou carregue por código.
                </div>
              ) : (
                <div className="savedList savedList-scroll">
                  {rooms.map((entry) => {
                    const systemLabel = entry.setup.systemId === "dnd5e-srd" ? "D&D 5e" : entry.setup.systemId;
                    const playersCount = entry.players?.length ?? 0;
                    return (
                      <div key={entry.id} className="savedItem">
                        <button
                          type="button"
                          className="savedItem-main"
                          onClick={() => {
                            setRoom(entry);
                            setRoomCode(entry.code);
                            socket.emit("room:subscribe", entry.id);
                            setStatus(`Sessão ${entry.name} aberta.`);
                          }}
                        >
                          <span className="savedItem-name">{entry.name}</span>
                          <span className="savedItem-code">{entry.code}</span>
                          <span className="savedItem-meta">
                            <span>{systemLabel}</span>
                            <span>nível {entry.setup.startingLevel}</span>
                            {playersCount > 0 && <span>{playersCount} jogador{playersCount > 1 ? "es" : ""}</span>}
                          </span>
                        </button>
                        <button
                          type="button"
                          className="savedItem-delete"
                          title={`Excluir sessão ${entry.name}`}
                          aria-label={`Excluir sessão ${entry.name}`}
                          onClick={() => void deleteSavedRoom(entry)}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </section>
      )}

      {room?.status === "lobby" && (
        <section className="lobbyStage">
          <section className="lobbyCard stack">
            <h2>Lobby — {room.name}</h2>
            <div className="detailCard">
              <p><strong>Código:</strong> {room.code}</p>
              <p><strong>Sistema:</strong> D&D 5e SRD · Nível {room.setup.startingLevel}</p>
              <p><strong>Dificuldade:</strong> {room.setup.enemyDifficulty} · {room.setup.battleIntensity} · mestre {room.setup.gmKindness}</p>
              <p className="faint">Todos os jogadores precisam marcar pronto antes do anfitrião iniciar.</p>
            </div>

            {/* Opening scene picker (shown when host fetched suggestions) */}
            {suggestions !== null && isHost && (
              <div className="stack">
                <p className="sectionLabel">Onde a primeira cena começa?</p>
                <div style={{ overflowY: "auto", maxHeight: "46vh", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                  {suggestions.map((s, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setSelectedSuggestion(s)}
                      style={{ textAlign: "left", padding: "0.55rem 0.75rem", borderRadius: "6px", border: selectedSuggestion === s ? "2px solid var(--gold)" : "1px solid var(--border)", width: "100%" }}
                    >
                      <strong style={{ fontSize: "0.95em" }}>{s.title}</strong>
                      <p style={{ margin: "0.2rem 0 0", fontSize: "0.82em", opacity: 0.85, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{s.hook}</p>
                      <p style={{ margin: "0.15rem 0 0", fontSize: "0.7em", opacity: 0.55 }}>Cena: {s.sceneKeyword} · {s.mood}</p>
                    </button>
                  ))}
                </div>
                <div className="stepActions">
                  <button type="button" className="btn-quiet" onClick={() => { setSuggestions(null); setSelectedSuggestion(null); }}>
                    ← Voltar
                  </button>
                  <span className="stepActions-spacer" />
                  <button
                    type="button"
                    className="btn-lg"
                    disabled={selectedSuggestion === null}
                    onClick={() => { if (selectedSuggestion) void startSession(selectedSuggestion.hook, selectedSuggestion.sceneKeyword, selectedSuggestion.title); }}
                  >
                    Iniciar neste ponto
                  </button>
                </div>
              </div>
            )}

            {suggestions === null && localPlayer && (
              <div className="stack">
                <div className="detailCard">
                  <strong>{localPlayer.characterName}</strong>
                  <p>{localPlayer.className} nível {localPlayer.level}</p>
                </div>
                <button
                  type="button"
                  className={localPlayer.ready ? "btn-ghost btn-block" : "btn-block"}
                  onClick={() => void setReady(!localPlayer.ready)}
                >
                  {localPlayer.ready ? "Marcar não pronto" : "Estou pronto"}
                </button>
                {isHost && (
                  <button
                    type="button"
                    className="btn-lg btn-block"
                    onClick={() => void fetchSuggestions()}
                    disabled={!allReady || isFetchingSuggestions}
                  >
                    {isFetchingSuggestions ? "Consultando o Mestre..." : allReady ? "▶ Iniciar sessão" : "Aguardando todos ficarem prontos…"}
                  </button>
                )}
              </div>
            )}

            {suggestions === null && !localPlayer && (
              <div className="stack">
                {(() => {
                  const hasSpells = (lobbyOptions?.options.classSpellChoices?.[characterDraft.className]?.count ?? 0) > 0;
                  const totalSteps = hasSpells ? 7 : 6;
                  const displayStep = charCreationStep <= 3 ? charCreationStep : (hasSpells ? charCreationStep : charCreationStep - 1);
                  const stepNames = hasSpells
                    ? ["Básico", "Atributos", "Perícias", "Magias", "Equipamento", "Retrato", "História"]
                    : ["Básico", "Atributos", "Perícias", "Equipamento", "Retrato", "História"];
                  const currentName = stepNames[displayStep - 1] ?? "";
                  return (
                    <div>
                      <div className="charStepper-label">
                        <span>Criação de personagem — passo {displayStep} de {totalSteps}</span>
                        <span className="charStepper-title">{currentName}</span>
                      </div>
                      <div className="charStepper" aria-hidden="true">
                        {Array.from({ length: totalSteps }, (_, i) => {
                          const stepNum = i + 1;
                          const cls = stepNum < displayStep ? "is-done" : stepNum === displayStep ? "is-active" : "";
                          return <span key={stepNum} className={`charStepper-pill ${cls}`} />;
                        })}
                      </div>
                    </div>
                  );
                })()}

                {/* Step 1: Basic info */}
                {charCreationStep === 1 && (
                  <div className="stack">
                    <div className="formField">
                      <label>Nome do jogador</label>
                      <input value={characterDraft.name} onChange={(event) => setCharacterDraft((current) => ({ ...current, name: event.target.value }))} />
                    </div>
                    <div className="formField">
                      <label>Nome do personagem</label>
                      <input value={characterDraft.characterName} onChange={(event) => setCharacterDraft((current) => ({ ...current, characterName: event.target.value }))} />
                    </div>
                    <div className="formField">
                      <label>Classe</label>
                      <select value={characterDraft.className} onChange={(event) => { setCharacterDraft((current) => ({ ...current, className: event.target.value, portraitUrl: "" })); setSkillDraft([]); setSpellDraft([]); setEquipChoiceIdx(0); }}>
                        {lobbyOptions?.options.classes.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                      </select>
                    </div>
                    <div className="formField">
                      <label>Espécie</label>
                      <select value={characterDraft.species} onChange={(event) => setCharacterDraft((current) => ({ ...current, species: event.target.value, portraitUrl: "" }))}>
                        {lobbyOptions?.options.species.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                      </select>
                    </div>
                    <div className="formField">
                      <label>Antecedente</label>
                      <select value={characterDraft.background} onChange={(event) => setCharacterDraft((current) => ({ ...current, background: event.target.value }))}>
                        {lobbyOptions?.options.backgrounds.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                      </select>
                    </div>
                    <div className="formField">
                      <label>Gênero</label>
                      <div className="genderPicker">
                        <button type="button" className={`genderBtn${characterDraft.gender === "male" ? " genderBtn-active" : ""}`} onClick={() => setCharacterDraft((current) => ({ ...current, gender: "male", portraitUrl: "" }))}>Masculino</button>
                        <button type="button" className={`genderBtn${characterDraft.gender === "female" ? " genderBtn-active" : ""}`} onClick={() => setCharacterDraft((current) => ({ ...current, gender: "female", portraitUrl: "" }))}>Feminino</button>
                      </div>
                    </div>
                    <div className="stepActions">
                      <span className="stepActions-spacer" />
                      <button type="button" disabled={!characterDraft.name.trim() || !characterDraft.characterName.trim()} onClick={() => setCharCreationStep(2)}>Próximo: Atributos →</button>
                    </div>
                  </div>
                )}

                {/* Step 2: Point-buy attributes */}
                {charCreationStep === 2 && (() => {
                  const pointBuyCosts = lobbyOptions?.options.pointBuyCosts ?? { 8:0,9:1,10:2,11:3,12:4,13:5,14:7,15:9 };
                  const budget = 27;
                  const spent = Object.values(attributeDraft).reduce((sum, v) => sum + (pointBuyCosts[v] ?? 0), 0);
                  const remaining = budget - spent;
                  const attrLabels: Record<string, string> = { strength:"Força", agility:"Agilidade", mind:"Mente", presence:"Presença", constitution:"Constituição", wisdom:"Sabedoria" };
                  const attrKeys = ["strength","agility","mind","presence","constitution","wisdom"];
                  const canIncrease = (key: string) => {
                    const cur = attributeDraft[key] ?? 8;
                    if (cur >= 15) return false;
                    const nextCost = (pointBuyCosts[cur + 1] ?? 999) - (pointBuyCosts[cur] ?? 0);
                    return remaining >= nextCost;
                  };
                  return (
                    <div className="stack">
                      <p className="faint">Distribua {budget} pontos entre os atributos. Restam: <strong>{remaining}</strong></p>
                      <div className="attrGrid">
                        {attrKeys.map((key) => {
                          const val = attributeDraft[key] ?? 8;
                          const mod = Math.floor((val - 10) / 2);
                          return (
                            <div key={key} className="attrRow">
                              <span className="attrLabel">{attrLabels[key]}</span>
                              <button type="button" className="attrBtn" disabled={(attributeDraft[key] ?? 8) <= 8} onClick={() => setAttributeDraft((a) => ({ ...a, [key]: (a[key] ?? 8) - 1 }))}>−</button>
                              <span className="attrVal">{val} <span className="faint">({mod >= 0 ? "+" : ""}{mod})</span></span>
                              <button type="button" className="attrBtn" disabled={!canIncrease(key)} onClick={() => setAttributeDraft((a) => ({ ...a, [key]: (a[key] ?? 8) + 1 }))}>+</button>
                              <span className="faint attrCost">{pointBuyCosts[val] ?? 0}pt</span>
                            </div>
                          );
                        })}
                      </div>
                      <div className="stepActions">
                        <button type="button" className="btn-quiet" onClick={() => setCharCreationStep(1)}>← Voltar</button>
                        <span className="stepActions-spacer" />
                        <button type="button" disabled={remaining !== 0} onClick={() => setCharCreationStep(3)}>Próximo: Perícias →</button>
                      </div>
                    </div>
                  );
                })()}

                {/* Step 3: Skill proficiencies */}
                {charCreationStep === 3 && (() => {
                  const classChoice = lobbyOptions?.options.classSkillChoices[characterDraft.className];
                  const maxSkills = classChoice?.count ?? 2;
                  const skillOptions = classChoice?.options ?? [];
                  return (
                    <div className="stack">
                      <p className="faint">Escolha <strong>{maxSkills}</strong> perícias para {characterDraft.className}. ({skillDraft.length}/{maxSkills} selecionadas)</p>
                      <div className="skillGrid">
                        {skillOptions.map((skill) => {
                          const selected = skillDraft.includes(skill);
                          const disabled = !selected && skillDraft.length >= maxSkills;
                          return (
                            <button
                              type="button"
                              key={skill}
                              className={`skillOption${selected ? " skillOption-selected" : ""}${disabled ? " skillOption-disabled" : ""}`}
                              disabled={disabled}
                              onClick={() => setSkillDraft((current) =>
                                current.includes(skill) ? current.filter((s) => s !== skill) : [...current, skill]
                              )}
                            >
                              {skill}
                            </button>
                          );
                        })}
                      </div>
                      <div className="stepActions">
                        <button type="button" className="btn-quiet" onClick={() => setCharCreationStep(2)}>← Voltar</button>
                        <span className="stepActions-spacer" />
                        <button type="button" disabled={skillDraft.length < maxSkills} onClick={() => {
                          const hasSpells = (lobbyOptions?.options.classSpellChoices?.[characterDraft.className]?.count ?? 0) > 0;
                          setCharCreationStep(hasSpells ? 4 : 5);
                        }}>Próximo: {((lobbyOptions?.options.classSpellChoices?.[characterDraft.className]?.count ?? 0) > 0) ? "Magias →" : "Equipamento →"}</button>
                      </div>
                    </div>
                  );
                })()}

                {/* Step 4: Spell selection (spellcasting classes only) */}
                {charCreationStep === 4 && (() => {
                  const spellData = lobbyOptions?.options.classSpellChoices?.[characterDraft.className];
                  const maxSpells = spellData?.count ?? 0;
                  const spellOptions = spellData?.options ?? [];
                  return (
                    <div className="stack">
                      <p className="faint">Escolha <strong>{maxSpells}</strong> magias iniciais para {characterDraft.className}. ({spellDraft.length}/{maxSpells} selecionadas)</p>
                      <div className="skillGrid">
                        {spellOptions.map((spell) => {
                          const selected = spellDraft.includes(spell);
                          const disabled = !selected && spellDraft.length >= maxSpells;
                          return (
                            <button
                              type="button"
                              key={spell}
                              className={`skillOption${selected ? " skillOption-selected" : ""}${disabled ? " skillOption-disabled" : ""}`}
                              disabled={disabled}
                              onClick={() => setSpellDraft((current) =>
                                current.includes(spell) ? current.filter((s) => s !== spell) : [...current, spell]
                              )}
                            >
                              {spell}
                            </button>
                          );
                        })}
                      </div>
                      <div className="stepActions">
                        <button type="button" className="btn-quiet" onClick={() => setCharCreationStep(3)}>← Voltar</button>
                        <span className="stepActions-spacer" />
                        <button type="button" disabled={spellDraft.length < maxSpells} onClick={() => setCharCreationStep(5)}>Próximo: Equipamento →</button>
                      </div>
                    </div>
                  );
                })()}

                {/* Step 5: Equipment choice */}
                {charCreationStep === 5 && (() => {
                  const equipOptions = lobbyOptions?.options.classEquipmentChoices?.[characterDraft.className] ?? [];
                  return (
                    <div className="stack">
                      <p className="faint">Escolha seu equipamento inicial como {characterDraft.className}.</p>
                      <div className="equipGrid">
                        {equipOptions.map((option, index) => (
                          <button
                            type="button"
                            key={index}
                            className={`equipOption${equipChoiceIdx === index ? " equipOption-selected" : ""}`}
                            onClick={() => setEquipChoiceIdx(index)}
                          >
                            <strong>{option.label}</strong>
                            <span className="faint" style={{ fontSize: "0.78rem" }}>Equipado: {option.equipped.join(", ")}</span>
                            <span className="faint" style={{ fontSize: "0.72rem" }}>Mochila: {option.backpack.join(", ")}</span>
                          </button>
                        ))}
                      </div>
                      <div className="stepActions">
                        <button type="button" className="btn-quiet" onClick={() => {
                          const hasSpells = (lobbyOptions?.options.classSpellChoices?.[characterDraft.className]?.count ?? 0) > 0;
                          setCharCreationStep(hasSpells ? 4 : 3);
                        }}>← Voltar</button>
                        <span className="stepActions-spacer" />
                        <button type="button" onClick={() => setCharCreationStep(6)}>Próximo: Retrato →</button>
                      </div>
                    </div>
                  );
                })()}

                {/* Step 6: Portrait + submit */}
                {charCreationStep === 6 && (() => {
                  return (
                    <form onSubmit={joinRoom} className="stack">
                      <div className="formField">
                        <label>Rosto e cabeça</label>
                        <textarea
                          value={characterDraft.physicalDescription}
                          onChange={(event) => setCharacterDraft((current) => ({ ...current, physicalDescription: event.target.value, portraitUrl: "" }))}
                          placeholder="Ex: rosto quadrado, cabelo castanho curto, barba cheia, olhos verdes, cicatriz fina na sobrancelha"
                          rows={3}
                        />
                      </div>
                      <div className="formField">
                        <label>Roupa ou armadura visível</label>
                        <textarea
                          value={characterDraft.outfitDescription}
                          onChange={(event) => setCharacterDraft((current) => ({ ...current, outfitDescription: event.target.value, portraitUrl: "" }))}
                          placeholder="Ex: cota de malha com ombreiras gastas, couro escuro no peito, gola de tecido vermelho"
                          rows={2}
                        />
                      </div>
                      <div className="formField">
                        <label>Retrato gerado</label>
                        {isGeneratingPortraitPreview ? (
                          <LoadingArtCard title="Gerando retrato" description="O modelo local está pintando sua prévia..." variant="portrait" />
                        ) : characterDraft.portraitUrl ? (
                          <div className="portraitPicker">
                            <button type="button" className="portraitOption portraitOption-selected" onClick={() => setCharacterDraft((current) => ({ ...current, portraitUrl: "" }))}>
                              <img src={toAssetUrl(characterDraft.portraitUrl)} alt="Retrato gerado" />
                              <span className="badge" style={{ position: "absolute", top: 8, left: 8 }}>Selecionado</span>
                            </button>
                          </div>
                        ) : (
                          <p className="faint">Gere uma prévia com os textos acima antes de entrar.</p>
                        )}
                        <button type="button" className="btn-ghost" onClick={generatePortraitPreview} disabled={isGeneratingPortraitPreview}>
                          {characterDraft.portraitUrl ? "Regenerar imagem" : "Gerar imagem"}
                        </button>
                      </div>
                      {!characterDraft.portraitUrl && <p className="faint">Um retrato novo será gerado automaticamente com as descrições acima após entrar.</p>}
                      <div className="stepActions">
                        <button type="button" className="btn-quiet" onClick={() => setCharCreationStep(5)}>← Voltar</button>
                        <span className="stepActions-spacer" />
                        <button type="button" onClick={() => setCharCreationStep(7)}>Próximo: História →</button>
                      </div>
                    </form>
                  );
                })()}

                {charCreationStep === 7 && (
                  <form onSubmit={joinRoom} className="stack">
                    <p className="faint">Crie munição narrativa para o Mestre: de onde o personagem vem, o que ele quer e quais pessoas ou problemas ainda o puxam para a história.</p>
                    <div className="formField">
                      <label>Origem</label>
                      <textarea value={characterDraft.origin} onChange={(event) => setCharacterDraft((current) => ({ ...current, origin: event.target.value }))} placeholder="Ex: nasceu entre estivadores, contrabandistas e velhas superstições de uma cidade portuária." rows={2} />
                    </div>
                    <div className="formField">
                      <label>Motivação</label>
                      <textarea value={characterDraft.motivation} onChange={(event) => setCharacterDraft((current) => ({ ...current, motivation: event.target.value }))} placeholder="Ex: procura dinheiro, vingança, redenção, conhecimento, fama ou alguém desaparecido." rows={2} />
                    </div>
                    <div className="formField">
                      <label>Ponto de virada</label>
                      <textarea value={characterDraft.turningPoint} onChange={(event) => setCharacterDraft((current) => ({ ...current, turningPoint: event.target.value }))} placeholder="Ex: foi traído, perdeu a casa, encontrou uma marca estranha ou foi acusado injustamente." rows={2} />
                    </div>
                    <div className="formField">
                      <label>Conexões</label>
                      <textarea value={characterDraft.connections} onChange={(event) => setCharacterDraft((current) => ({ ...current, connections: event.target.value }))} placeholder="Ex: um amigo em uma guilda, um rival, uma dívida, um parente distante ou alguém que evita encontrar." rows={2} />
                    </div>
                    <div className="formField">
                      <label>Resumo livre</label>
                      <textarea value={characterDraft.backstory} onChange={(event) => setCharacterDraft((current) => ({ ...current, backstory: event.target.value }))} placeholder="Opcional: amarre os pontos acima em uma narrativa curta para o Mestre usar." rows={3} />
                    </div>
                    <div className="stepActions">
                      <button type="button" className="btn-quiet" onClick={() => setCharCreationStep(6)}>← Voltar</button>
                      <span className="stepActions-spacer" />
                      <button type="submit" className="btn-lg">Criar personagem e entrar</button>
                    </div>
                  </form>
                )}
              </div>
            )}
          </section>

          <section className="lobbyCard stack">
            <h2>Jogadores na sala</h2>
            <div className="lobbyPlayerList">
              {room.players.map((entry) => (
                <div key={entry.id} className={`lobbyPlayerCard${entry.id === playerId ? " lobbyPlayerCard-local" : ""}${entry.ready ? " lobbyPlayerCard-ready" : ""}`}>
                  <div style={{ flex: 1 }}>
                    <strong>{entry.characterName}</strong>
                    <p className="faint">{entry.className} nível {entry.level} · {entry.species}</p>
                  </div>
                  {entry.ready && <span className="readyBadge">Pronto</span>}
                  {room.setup.hostPlayerId === entry.id && <span className="badge">Host</span>}
                </div>
              ))}
            </div>
            {room.messages.length > 0 && (
              <div className="msgFeed" style={{ maxHeight: 200, marginTop: "0.5rem" }}>
                {room.messages.slice(-8).map((message) => <ChatCard key={message.id} message={message} jobs={jobsByMessage.get(message.id)} audioClips={audioClips.filter((clip) => clip.messageId === message.id)} />)}
              </div>
            )}
          </section>
        </section>
      )}

      {room?.status === "preparing" && (
        <PreparationScreen
          roomName={room.name}
          step={preparationStep}
          progress={preparationProgress}
          players={room.players}
        />
      )}

      {room?.status === "active" && (
        <section className="gameViewport">
          <aside className="gamePane">
            <div className="paneHead">
              <h2>{room.name}</h2>
              <span className="badge">{room.code}</span>
            </div>
            <div className="paneScroll">
              <PartySummary players={room.players} localPlayerId={playerId} room={room} />
              <CombatTracker combat={room.combat} />
            </div>
          </aside>

          <section className="gamePane stagePane">
            <div className="stageSplit">
              <div className="storyFeed">
                <div className="storyFeedHead">
                  <h2>{room.scene.title}</h2>
                </div>
                {room.scene.pendingRollRequest && (
                  <div className="rollRequestBanner">
                    <span className="rollRequestIcon">🎲</span>
                    <div className="rollRequestBody">
                      <strong>{room.scene.pendingRollRequest.description}</strong>
                      <span className="faint">
                        Role {room.scene.pendingRollRequest.advantage ? `2${room.scene.pendingRollRequest.die}` : `${room.scene.pendingRollRequest.diceCount ?? room.scene.pendingRollRequest.damageDiceCount ?? 1}${room.scene.pendingRollRequest.die}`}
                        {room.scene.pendingRollRequest.modifier !== 0 ? ` ${room.scene.pendingRollRequest.modifier > 0 ? "+" : ""}${room.scene.pendingRollRequest.modifier}` : ""}
                        {" "}· CD {room.scene.pendingRollRequest.difficulty} · {room.scene.pendingRollRequest.skill}
                        {room.scene.pendingRollRequest.advantage === "advantage" ? " · vantagem: use o maior d20" : ""}
                        {room.scene.pendingRollRequest.advantage === "disadvantage" ? " · desvantagem: use o menor d20" : ""}
                      </span>
                    </div>
                  </div>
                )}
                <div className="prefixBar">
                  <button type="button" onClick={() => insertChatPrefix("*")}>* Ação</button>
                  <button type="button" onClick={() => insertChatPrefix("-")}>- Fala</button>
                  <button type="button" onClick={() => insertChatPrefix('"')}>" Sussurro</button>
                  <button type="button" onClick={() => insertChatPrefix("(")}>(?) Pergunta</button>
                </div>
                <div className="msgFeed">
                  {recentMessages.map((message) => <ChatCard key={message.id} message={message} jobs={jobsByMessage.get(message.id)} audioClips={audioClips.filter((clip) => clip.messageId === message.id)} />)}
                  {streamingEntries.map(([streamId, narration]) => (
                    <StreamingGmCard key={streamId} narration={narration} audioClips={audioClips.filter((clip) => !clip.messageId && clip.streamId === streamId)} />
                  ))}
                </div>
              </div>
              <div className="sceneRail">
                <SceneCard room={room} />
              </div>
            </div>
            <form onSubmit={sendChat} className="inputDock">
              <div className="inputDockHint">
                {room.combat.active
                  ? `Turno atual: ${currentTurn?.actorName ?? "desconhecido"}`
                  : `Tipo detectado: ${messagePrefix[localInputKind]}`}
              </div>
              <textarea
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                rows={3}
                placeholder={'*avanço com o escudo | - Segurem a linha! | "acho que há uma emboscada | (vejo símbolos nas ruínas?)'}
              />
              <div className="inputDockButtons">
                <button type="submit" disabled={!canSendChat || isSending}>
                  {isSending ? "Enviando…" : "Enviar"}
                </button>
                {isHost && (
                  <button
                    type="button"
                    className="ghostButton"
                    onClick={handleRegenerate}
                    disabled={isRegenerating || isSending}
                    title="Descartar a última narração do Mestre e gerar de novo (apenas host)"
                  >
                    {isRegenerating ? "Regenerando…" : "🔄 Regenerar narração"}
                  </button>
                )}
              </div>
            </form>
          </section>

          <aside className={`gamePane${activePanel === "sheet" ? " sheetPane" : ""}`}>
            <div className="paneHead">
              <h2>{localPlayer?.characterName ?? "Mesa pessoal"}</h2>
            </div>
            <div className="paneScroll">
              <div className="hostBlock">
                {/*
                  Elemento de áudio invisível usado pela fila de TTS. Fica fora de qualquer
                  gate de visibilidade pra que o ref seja anexado assim que o painel monta.
                */}
                <audio ref={audioElementRef} style={{ display: "none" }} preload="auto" />
                <button
                  type="button"
                  className={`ghostButton ghostButton-block${ttsEnabled ? " ghostButton-active" : ""}`}
                  onClick={() => {
                    // Política de autoplay: precisamos de um "primeiro toque" no áudio.
                    // O primeiro click serve como gesture; depois disso o navegador deixa tocar.
                    const audio = audioElementRef.current;
                    if (audio && !ttsEnabled) {
                      audio.muted = true;
                      audio.src = silentAudioDataUri;
                      void audio.play().catch(() => undefined).finally(() => {
                        audio.pause();
                        audio.removeAttribute("src");
                        audio.load();
                        audio.muted = false;
                      });
                    }
                    setTtsEnabled((current) => !current);
                  }}
                  title="Liga/desliga a narração falada pelo Mestre IA"
                >
                  {ttsEnabled ? "🔊 Narração ativa" : "🔈 Ativar narração"}
                </button>
                {isHost && (
                  <button
                    type="button"
                    className="ghostButton ghostButton-block"
                    onClick={() => {
                      const next = !llmStatsOpen;
                      setLlmStatsOpen(next);
                      if (next) void refreshLlmStats();
                    }}
                  >
                    {llmStatsOpen ? "▼" : "▶"} Estatísticas do Mestre IA
                  </button>
                )}
                {isHost && llmStatsOpen && (
                  <LlmStatsPanel stats={llmStats} onRefresh={refreshLlmStats} />
                )}
              </div>
              {localPlayer && (
                <div className="heroCard">
                  {localPlayer.portraitAssetUrl
                    ? <img className="heroPortrait" src={toAssetUrl(localPlayer.portraitAssetUrl)} alt={localPlayer.characterName} />
                    : findPendingPortraitJob(room, localPlayer)
                      ? <LoadingArtCard title="" description="Pintando retrato..." variant="portrait" />
                      : <div className="heroPortraitPlaceholder"><span className="faint">?</span></div>}
                  <div className="heroStats">
                    <strong>{localPlayer.characterName}</strong>
                    <span className="muted">{localPlayer.className} nível {localPlayer.level} · {localPlayer.species}</span>
                    <span className="muted">{formatXpProgress(localPlayer)}</span>
                    <div className="vitalRow">
                      <span className="vitalPill vitalPill-hp">
                        <strong>{localPlayer.hitPoints}/{localPlayer.maxHitPoints}</strong>
                        <span>HP</span>
                      </span>
                      <span className="vitalPill vitalPill-ac">
                        <strong>{localPlayer.armorClass}</strong>
                        <span>AC</span>
                      </span>
                    </div>
                    <button type="button" className="btn-ghost" onClick={regeneratePortrait}>
                      Regenerar retrato
                    </button>
                  </div>
                </div>
              )}
              {localPlayer && localPlayer.pendingLevelUps > 0 && (
                <LevelUpPanel
                  player={localPlayer}
                  classes={lobbyOptions?.options.classes ?? []}
                  skillChoices={lobbyOptions?.options.classSkillChoices ?? {}}
                  spellChoices={lobbyOptions?.options.classSpellChoices ?? {}}
                  onApply={applyLevelUp}
                />
              )}
              {localPlayer && (
                <div className="tabBar playerPanelTabs">
                  <button type="button" className={activePanel === "sheet" ? "tabBar-active" : ""} onClick={() => setActivePanel(activePanel === "sheet" ? null : "sheet")}>Ficha</button>
                  <button type="button" className={activePanel === "inventory" ? "tabBar-active" : ""} onClick={() => setActivePanel(activePanel === "inventory" ? null : "inventory")}>Inv.</button>
                  <button type="button" className={activePanel === "lore" ? "tabBar-active" : ""} onClick={() => setActivePanel(activePanel === "lore" ? null : "lore")}>Lore</button>
                  <button type="button" className={activePanel === "notes" ? "tabBar-active" : ""} onClick={() => setActivePanel(activePanel === "notes" ? null : "notes")}>Notas</button>
                </div>
              )}
              {localPlayer && <SuggestedActions player={localPlayer} room={room} onPick={chooseSuggestedAction} />}
              {localPlayer && (
                <>
                  {activePanel === "sheet" && <PaperSheetView player={localPlayer} />}
                  {activePanel === "inventory" && <InventoryView player={localPlayer} />}
                  {activePanel === "lore" && <PlayerLoreView player={localPlayer} />}
                  {activePanel === "notes" && <NotesView notesDraft={notesDraft} setNotesDraft={setNotesDraft} onSave={saveNotes} />}
                  {!activePanel && (
                    <div className="detailCard">
                      <p><strong>Visual:</strong> {localPlayer.physicalDescription}</p>
                      <p><strong>Arma:</strong> {localPlayer.weaponDescription}</p>
                      <p><strong>Traje:</strong> {localPlayer.outfitDescription}</p>
                    </div>
                  )}
                </>
              )}
              <DiceTable
                diceCount={diceCount}
                diceSides={diceSides}
                diceModifier={diceModifier}
                diceRoll={diceRoll}
                setDiceCount={setDiceCount}
                setDiceSides={setDiceSides}
                setDiceModifier={setDiceModifier}
                onRoll={rollDice}
              />
              {orphanImageJobs.length > 0 && (
                <div className="galleryGrid">
                  {orphanImageJobs.map((job) => (
                    <div key={job.id} className="galleryItem">
                      {job.assetUrl && job.status === "done"
                        ? <img src={toAssetUrl(job.assetUrl)} alt={job.profile} />
                        : <LoadingArtCard title="Gerando arte" description="Aguarde a composição final." variant="gallery" />}
                      <span className="badge">{job.profile}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
        </section>
      )}
    </main>
  );
}

const PREPARATION_STEPS = [
  "O Mestre estuda o cenário e os seus segredos...",
  "O Mestre concebe inimigos, aliados e missões para a aventura...",
  "Registrando lore e memórias do mundo...",
  "O Mestre narra a cena de abertura...",
  "Pintando a cena de abertura...",
  "Tudo pronto! A aventura começa...",
];

function PreparationScreen({ roomName, step, progress, players }: { roomName: string; step: string; progress: number; players: Player[] }) {
  const currentIndex = PREPARATION_STEPS.indexOf(step);
  const clampedProgress = Math.min(100, Math.max(0, progress));
  return (
    <section className="preparationScreen">
      <div className="preparationCard">
        <p className="eyebrow">Preparando a sessão</p>
        <h2 className="preparationTitle">{roomName}</h2>
        <div className="preparationOrb" aria-hidden="true">
          <span className="preparationOrbRing" />
          <span className="preparationOrbCore" />
        </div>
        <div className="preparationProgressBar" role="progressbar" aria-valuenow={clampedProgress} aria-valuemin={0} aria-valuemax={100}>
          <div className="preparationProgressFill" style={{ width: `${clampedProgress}%` }} />
          <span className="preparationProgressLabel">{clampedProgress}%</span>
        </div>
        <div className="preparationSteps">
          {PREPARATION_STEPS.map((label, index) => {
            const isDone = index < currentIndex;
            const isActive = index === currentIndex;
            return (
              <div
                key={label}
                className={`preparationStep${isDone ? " preparationStep-done" : ""}${isActive ? " preparationStep-active" : ""}`}
              >
                <span className="preparationStepDot" />
                <span className="preparationStepLabel">{label}</span>
              </div>
            );
          })}
        </div>
        {players.length > 0 && (
          <div className="preparationParty">
            {players.map((p) => (
              <span key={p.id} className="preparationPartyMember">
                {p.portraitAssetUrl
                  ? <img src={p.portraitAssetUrl.startsWith("http") ? p.portraitAssetUrl : `${(import.meta.env.VITE_API_BASE_URL ?? "").trim() || (import.meta.env.DEV ? "http://127.0.0.1:8787" : window.location.origin)}${p.portraitAssetUrl}`} alt={p.characterName} />
                  : <span className="preparationPartyAvatar">{p.characterName[0]}</span>}
                <span>{p.characterName}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function SceneCard({ room }: { room: RoomState }) {
  const sceneImage = room.imageJobs.find((job) => job.profile === "scene" && job.status === "done" && job.assetUrl);
  const pendingScene = room.imageJobs.some((job) => job.profile === "scene" && job.status === "queued");
  return (
    <div className="stack">
      <p className="sectionLabel">Panorama</p>
      {sceneImage?.assetUrl
        ? (
          <div className="sceneImageFrame">
            <img className="sceneImg" src={toAssetUrl(sceneImage.assetUrl)} alt={room.scene.title} />
            {pendingScene && (
              <div className="imageGenerationOverlay">
                <div className="loadingDot" aria-hidden="true" />
                <span>Nova imagem sendo gerada</span>
              </div>
            )}
          </div>
        )
        : pendingScene
          ? <LoadingArtCard title="Imagem em geração" description="O modelo local começou a pintar este cenário." variant="scene" />
          : null}
      {room.scene.summary && (
        <div className="sceneInfo">
          <strong>{room.scene.title}</strong>
          <p>{room.scene.summary}</p>
        </div>
      )}
    </div>
  );
}

function PartySummary({ players, localPlayerId, room }: { players: Player[]; localPlayerId: string; room: RoomState }) {
  const sceneNpcs: SceneNpc[] = room.scene.activeNpcs ?? [];
  const activeNpcs = sceneNpcs.filter((npc) => npc.relation === "companion");
  const nearbyNpcs = sceneNpcs.filter((npc) => npc.relation !== "companion");
  return (
    <div className="partyBlock">
      <p className="sectionLabel">Grupo</p>
      {players.map((entry) => {
        const hpPct = entry.maxHitPoints > 0 ? Math.max(0, Math.min(100, (entry.hitPoints / entry.maxHitPoints) * 100)) : 0;
        return (
          <article key={entry.id} className={`partyMember${entry.id === localPlayerId ? " partyMember-self" : ""}`}>
            {entry.portraitAssetUrl
              ? <img className="partyThumb" src={toAssetUrl(entry.portraitAssetUrl)} alt={entry.characterName} />
              : room.imageJobs.some((j) => j.profile === "portrait" && j.status === "queued" && j.subjectName === entry.characterName)
                ? <div className="partyThumbPlaceholder"><div className="loadingDot" /></div>
                : <div className="partyThumbPlaceholder"><span className="faint">?</span></div>}
            <div className="partyInfo">
              <strong>{entry.characterName}</strong>
              <span className="muted">{entry.className} {entry.level}</span>
              <div className="hpBar"><div className="hpBar-fill" style={{ width: `${hpPct}%` }} /></div>
              <span className="faint">HP {entry.hitPoints}/{entry.maxHitPoints} · AC {entry.armorClass}</span>
            </div>
          </article>
        );
      })}
      {activeNpcs.map((npc) => {
        const npcJob = room.imageJobs.find((j) => (j.profile === "npc" || j.profile === "portrait") && j.subjectName === npc.name);
        const portraitUrl = npc.portraitAssetUrl ?? (npcJob?.status === "done" ? npcJob.assetUrl : undefined);
        const isPending = !portraitUrl && npcJob?.status === "queued";
        const isUnconscious = npc.status === "unconscious";
        const isDead = npc.status === "dead";
        const statusLabel = isDead ? "morto" : isUnconscious ? "inconsciente" : null;
        return (
          <article key={npc.name} className={`partyMember partyMember-npc${isUnconscious ? " partyMember-unconscious" : ""}${isDead ? " partyMember-dead" : ""}`}>
            {portraitUrl
              ? <img className="partyThumb" src={toAssetUrl(portraitUrl)} alt={npc.name} style={isUnconscious || isDead ? { filter: "grayscale(0.8) opacity(0.6)" } : undefined} />
              : isPending
                ? <div className="partyThumbPlaceholder"><div className="loadingDot" /></div>
                : <div className="partyThumbPlaceholder"><span className="faint">N</span></div>}
            <div className="partyInfo">
              <strong>
                {npc.name}{" "}
                <span className="badge" style={{ fontSize: "0.65rem" }}>NPC</span>
                {statusLabel && <span className="badge" style={{ fontSize: "0.62rem", background: isDead ? "rgba(120,30,30,0.5)" : "rgba(80,80,80,0.5)", marginLeft: "0.25rem" }}>{statusLabel}</span>}
              </strong>
              <span className="muted">{npc.className ?? npc.role}{npc.level ? ` ${npc.level}` : ""}{npc.race ? ` · ${npc.race}` : ""}</span>
              {npc.maxHitPoints !== undefined && npc.hitPoints !== undefined && (
                <>
                  <div className="hpBar"><div className="hpBar-fill" style={{ width: `${Math.max(0, Math.min(100, (npc.hitPoints / npc.maxHitPoints) * 100))}%` }} /></div>
                  <span className="faint">HP {npc.hitPoints}/{npc.maxHitPoints}{npc.armorClass !== undefined ? ` · AC ${npc.armorClass}` : ""}</span>
                </>
              )}
            </div>
          </article>
        );
      })}
      {nearbyNpcs.length > 0 && (
        <>
          <p className="sectionLabel">NPCs na cena</p>
          {nearbyNpcs.map((npc) => {
            const npcJob = room.imageJobs.find((j) => (j.profile === "npc" || j.profile === "portrait") && j.subjectName === npc.name);
            const portraitUrl = npc.portraitAssetUrl ?? (npcJob?.status === "done" ? npcJob.assetUrl : undefined);
            const isPending = !portraitUrl && npcJob?.status === "queued";
            return (
              <article key={npc.name} className="partyMember partyMember-npc">
                {portraitUrl
                  ? <img className="partyThumb" src={toAssetUrl(portraitUrl)} alt={npc.name} />
                  : isPending
                    ? <div className="partyThumbPlaceholder"><div className="loadingDot" /></div>
                    : <div className="partyThumbPlaceholder"><span className="faint">N</span></div>}
                <div className="partyInfo">
                  <strong>{npc.name} <span className="badge" style={{ fontSize: "0.65rem" }}>Cena</span></strong>
                  <span className="muted">{npc.className ?? npc.role}</span>
                  <span className="faint">Presente na cena. Ainda não faz parte do grupo.</span>
                </div>
              </article>
            );
          })}
        </>
      )}
    </div>
  );
}

function LlmStatsPanel({ stats, onRefresh }: { stats: LlmStatsResponse | null; onRefresh: () => void }) {
  if (!stats) {
    return <p className="faint">Carregando estatísticas…</p>;
  }
  const labels = Object.entries(stats.stats.byLabel).sort((a, b) => b[1].count - a[1].count);
  return (
    <div className="llmStatsPanel">
      <div className="llmStatsHeader">
        <span className="sectionLabel">Latência e fallbacks por chamada</span>
        <button type="button" className="ghostButton ghostButton-tiny" onClick={onRefresh}>↻ Atualizar</button>
      </div>
      {labels.length === 0
        ? <p className="faint">Sem chamadas registradas ainda.</p>
        : (
          <table className="llmStatsTable">
            <thead>
              <tr><th>Label</th><th>#</th><th>Latência (ms)</th><th>Falha</th><th>Fallback</th></tr>
            </thead>
            <tbody>
              {labels.map(([label, agg]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td>{agg.count}</td>
                  <td>{agg.avgLatency}</td>
                  <td className={agg.failureRate > 0.1 ? "warn" : ""}>{(agg.failureRate * 100).toFixed(1)}%</td>
                  <td className={agg.fallbackRate > 0.1 ? "warn" : ""}>{(agg.fallbackRate * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      <details className="llmRecent">
        <summary>Últimas {stats.recent.length} chamadas</summary>
        <ul>
          {stats.recent.slice(0, 12).map((call) => (
            <li key={call.id} className={call.ok ? "" : "warn"}>
              <span className="muted">{new Date(call.createdAt).toLocaleTimeString()}</span>{" "}
              <strong>{call.label}</strong> · {call.model} · {call.latencyMs}ms
              {!call.ok && call.error ? ` · ${call.error}` : ""}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function CombatTracker({ combat }: { combat: CombatState }) {
  if (!combat.active) {
    return (
      <div className="combatBlock">
        <p className="sectionLabel">Iniciativa</p>
        <p className="faint">Sem combate ativo.</p>
      </div>
    );
  }
  return (
    <div className="combatBlock">
      <p className="sectionLabel">Iniciativa — Rodada {combat.round}</p>
      {combat.enemies.length > 0 && (
        <div className="enemyList">
          {combat.enemies.map((enemy) => (
            <div key={enemy.id} className={`enemySummary${enemy.hitPoints <= 0 ? " enemyDown" : ""}`}>
              <p className="muted">
                {enemy.name} · CA {enemy.armorClass} · {enemy.hitPoints}/{enemy.maxHitPoints} HP · {enemy.xpValue} XP{enemy.challengeRating ? ` · CR ${enemy.challengeRating}` : ""}{enemy.hitPoints <= 0 ? " · derrotado" : ""}
              </p>
              {enemy.traits?.length ? <p className="faint">{enemy.traits.slice(0, 2).join(" · ")}</p> : null}
            </div>
          ))}
        </div>
      )}
      {combat.order.map((entry, index) => (
        <div key={entry.id} className={`initiativeRow${index === combat.currentTurnIndex ? " initiativeRow-active" : ""}`}>
          <strong>{entry.actorName}</strong>
          <span className="initiativeSide">{entry.side} · {entry.initiative}</span>
        </div>
      ))}
      {combat.lastOutcome && <p className="faint">{combat.lastOutcome}</p>}
    </div>
  );
}

function CampaignMemoryPanel({ summary, entries }: { summary: string; entries: CampaignMemoryEntry[] }) {
  return (
    <div className="memoryBlock">
      <p className="sectionLabel">Canon da campanha</p>
      {summary && <p className="muted" style={{ fontSize: "0.82rem" }}>{summary}</p>}
      {entries.map((entry) => (
        <div key={entry.id} className="memoryEntry">
          <strong>{entry.title}</strong>
          <p>{entry.content}</p>
        </div>
      ))}
      {entries.length === 0 && <p className="faint">Nenhuma memória registrada ainda.</p>}
    </div>
  );
}

function DiceTable({
  diceCount,
  diceSides,
  diceModifier,
  diceRoll,
  setDiceCount,
  setDiceSides,
  setDiceModifier,
  onRoll,
}: {
  diceCount: number;
  diceSides: DieKind;
  diceModifier: number;
  diceRoll: DiceRollState;
  setDiceCount: (value: number) => void;
  setDiceSides: (value: DieKind) => void;
  setDiceModifier: (value: number) => void;
  onRoll: () => void;
}) {
  return (
    <section className="diceSection">
      <p className="sectionLabel">Mesa de dados</p>
      <div className="diceControls">
        <label>
          Qtd
          <input type="number" min={1} max={6} value={diceCount} onChange={(event) => setDiceCount(Math.max(1, Math.min(6, Number(event.target.value) || 1)))} />
        </label>
        <label>
          Dado
          <select value={diceSides} onChange={(event) => setDiceSides(Number(event.target.value) as DieKind)}>
            {commonDice.map((entry) => <option key={entry} value={entry}>d{entry}</option>)}
          </select>
        </label>
        <label>
          Mod
          <input type="number" min={-10} max={20} value={diceModifier} onChange={(event) => setDiceModifier(Number(event.target.value) || 0)} />
        </label>
      </div>
      <button type="button" className="diceRollBtn" onClick={onRoll} disabled={diceRoll.status === "rolling"}>Rolar {diceCount}d{diceSides}</button>
      {diceRoll.dice.length > 0 && (
        <div className="dicePool">
          {diceRoll.dice.map((die) => (
            <div key={die.id} className={`dieFace${diceRoll.status === "rolling" ? " dieFace-rolling" : ""}`}>
              <span>d{die.sides}</span>
              <strong>{diceRoll.status === "rolling" ? "?" : die.value}</strong>
            </div>
          ))}
        </div>
      )}
      {diceRoll.status !== "idle" && (
        <p className="diceResult">
          {diceRoll.status === "revealed"
            ? `Total: ${diceRoll.total}${diceModifier !== 0 ? ` (mod ${diceModifier > 0 ? "+" : ""}${diceModifier})` : ""}`
            : diceRoll.label}
        </p>
      )}
    </section>
  );
}

function ChatCard({ message, jobs, audioClips = [] }: { message: ChatMessage; jobs?: ImageJob[]; audioClips?: VisibleAudioClip[] }) {
  const hasImages = jobs && jobs.length > 0;
  return (
    <article className={`msg msg-${message.role}`}>
      <div className="msgHeader">
        <strong>{message.authorName}</strong>
        <span className="msgKind">{messagePrefix[message.kind]}</span>
      </div>
      <p>{message.content}</p>
      {audioClips.length > 0 && <NarrationAudioList clips={audioClips} />}
      {hasImages && (
        <div className="inlineMsgImages">
          {jobs.map((job) => (
            job.assetUrl && job.status === "done"
              ? <img key={job.id} src={toAssetUrl(job.assetUrl)} alt={job.profile} className="inlineMsgImg" />
              : <div key={job.id} className="inlineMsgImgPlaceholder"><LoadingArtCard title="Imagem em geração" description={imageJobLoadingText(job)} variant="gallery" /></div>
          ))}
        </div>
      )}
    </article>
  );
}

function NarrationAudioList({ clips }: { clips: VisibleAudioClip[] }) {
  const ordered = [...clips].sort((a, b) => a.sequence - b.sequence);
  return (
    <div className="narrationAudioList">
      {ordered.map((clip) => (
        <div key={clip.audioId} className="narrationAudioBubble">
          <span className="narrationAudioMeta">{clip.speaker} · {Math.max(1, Math.round(clip.durationMs / 1000))}s · expira em 2 min</span>
          <audio controls preload="none" src={`${apiBaseUrl}${clip.audioUrl}`} />
        </div>
      ))}
    </div>
  );
}

function imageJobLoadingText(job: ImageJob): string {
  if (job.profile === "scene") return "O cenário entrou na fila do modelo local.";
  if (job.profile === "creature") return "O token do inimigo entrou na fila.";
  if (job.profile === "portrait" || job.profile === "npc") return "O token do personagem entrou na fila.";
  if (job.profile === "item") return "O item entrou na fila de arte.";
  return "A arte entrou na fila.";
}

function StreamingGmCard({ narration, audioClips = [] }: { narration: string; audioClips?: VisibleAudioClip[] }) {
  return (
    <article className="msg msg-gm msg-streaming">
      <div className="msgHeader">
        <strong>Game Master</strong>
        <span className="msgKind">Mestre</span>
      </div>
      <p>
        {narration || "O Mestre está narrando..."}
        <span className="streamCursor" aria-hidden="true" />
      </p>
      {audioClips.length > 0 && <NarrationAudioList clips={audioClips} />}
    </article>
  );
}

const ATTR_LABELS: Record<string, string> = {
  strength: "Força", agility: "Agilidade", mind: "Mente",
  presence: "Presença", constitution: "Constituição", wisdom: "Sabedoria",
};
const ATTR_DESCRIPTIONS: Record<string, string> = {
  strength: "Força física. Role 1d20 + mod. de Força para escalar, empurrar, quebrar objetos e ataques corpo-a-corpo.",
  agility: "Destreza e velocidade. Role 1d20 + mod. de Agilidade para furtividade, acrobacia, ataques à distância e CA sem armadura.",
  mind: "Inteligência. Role 1d20 + mod. de Mente para investigação, arcanismo, história e magias de Mago.",
  presence: "Presença/Carisma. Role 1d20 + mod. de Presença para persuasão, enganação, intimidação e magias de Bardo/Paladino.",
  constitution: "Resistência física. Afeta HP máximo (dado de vida + modificador por nível) e manutenção de concentração em magias.",
  wisdom: "Sabedoria e percepção. Role 1d20 + mod. de Sabedoria para percepção, medicina, intuição e magias de Clérigo/Druida.",
};
const SKILL_DESCRIPTIONS: Record<string, string> = {
  athletics: "Atletismo (Força): Escalar, nadar, pular ou manter-se firme em situações físicas extremas. Role 1d20 + mod. de Força.",
  acrobatics: "Acrobacia (Agilidade): Manobras aéreas, equilíbrio e escapar de agarrões. Role 1d20 + mod. de Agilidade.",
  stealth: "Furtividade (Agilidade): Mover-se sem ser detectado. Role 1d20 + mod. de Agilidade contra Percepção passiva do oponente.",
  investigation: "Investigação (Mente): Procurar pistas, deduzir o que aconteceu e examinar objetos em detalhe. Role 1d20 + mod. de Mente.",
  awareness: "Percepção (Sabedoria): Notar presenças ocultas, sons suspeitos e detalhes do ambiente. Role 1d20 + mod. de Sabedoria.",
  persuasion: "Persuasão (Presença): Convencer NPCs com argumentos diplomáticos. Role 1d20 + mod. de Presença.",
  deception: "Enganação (Presença): Mentir de forma convincente e disfarçar intenções. Role 1d20 + mod. de Presença.",
  intimidation: "Intimidação (Presença): Coagir NPCs por ameaças ou postura dominante. Role 1d20 + mod. de Presença.",
  melee: "Combate Corpo-a-Corpo (Força/Agilidade): Ataques com espadas, machados e lanças. Role 1d20 + mod. de ataque.",
  ranged: "Combate à Distância (Agilidade): Ataques com arco, besta e projéteis. Role 1d20 + mod. de Agilidade.",
  medicine: "Medicina (Sabedoria): Estabilizar aliados morrendo (CD 10) e diagnosticar doenças. Role 1d20 + mod. de Sabedoria.",
  arcana: "Arcanismo (Mente): Identificar magias, criaturas mágicas e objetos arcanos. Role 1d20 + mod. de Mente.",
  history: "História (Mente): Recordar eventos, lendas e informações sobre civilizações. Role 1d20 + mod. de Mente.",
  nature: "Natureza (Mente): Identificar plantas, criaturas, clima e paisagens. Role 1d20 + mod. de Mente.",
  religion: "Religião (Sabedoria): Reconhecer símbolos divinos, rituais e planos divinos. Role 1d20 + mod. de Sabedoria.",
  survival: "Sobrevivência (Sabedoria): Rastrear criaturas, navegar em terrenos e encontrar comida. Role 1d20 + mod. de Sabedoria.",
  sleight_of_hand: "Prestidigitação (Agilidade): Furtar, bater carteira e manipular objetos discretamente. Role 1d20 + mod. de Agilidade.",
  performance: "Performance (Presença): Cantar, atuar ou tocar para uma audiência. Role 1d20 + mod. de Presença.",
  insight: "Intuição (Sabedoria): Detectar mentiras, ler emoções e intenções ocultas. Role 1d20 + mod. de Sabedoria.",
  animal_handling: "Adestramento (Sabedoria): Acalmar, controlar ou treinar animais. Role 1d20 + mod. de Sabedoria.",
  lockpicking: "Arrombamento (Agilidade): Abrir fechaduras sem a chave usando ferramentas de ladrão. Role 1d20 + mod. de Agilidade.",
};
const FEATURE_DESCRIPTIONS: Record<string, string> = {
  "Sneak Attack": "Dano extra quando atacar com vantagem ou com aliado adjacente ao alvo: 1d6 (escala por nível de Ladino). Apenas armas finesse ou à distância.",
  "Cunning Action": "Ação bônus: Disparada (dobrar movimento), Desengajamento (sem ataques de oportunidade) ou Esconder.",
  "Thieves' Cant": "Linguagem secreta dos ladrões. Passa mensagens ocultas em conversas comuns; decifrável apenas por outros Ladinos.",
  "Second Wind": "Ação bônus: recupere 1d10 + nível de Guerreiro em HP. Recarrega no descanso curto ou longo.",
  "Action Surge": "Use duas ações de ataque em um turno. Uma vez por descanso curto ou longo.",
  "Fighting Style": "Bônus passivo de combate (Defesa: +1 CA; Duelo: +2 dano; Armas de duas mãos: rerrole dados de dano 1 ou 2).",
  "Divine Sense": "Detecte criaturas celestiais, infernais ou mortos-vivos a 60 pés. Usos = 1 + mod. de Presença por longo descanso.",
  "Lay on Hands": "Toque para curar HP de um pool diário de 5 × nível de Paladino. Ou gaste 5 pts para curar doença/veneno.",
  "Spellcasting": "Conjure magias usando slots de magia. Cada slot gasto usa uma magia preparada ou potencializa conforme nível.",
  "Wild Shape": "Transforme-se em besta conhecida. CR máximo = nível ÷ 4 (mín. CR ⅛). 2 usos por descanso curto.",
  "Bardic Inspiration": "Ação bônus: dê 1d6 de Inspiração a um aliado para ele somar em ataque, teste ou resistência futura.",
  "Favored Enemy": "Vantagem em Sobrevivência para rastrear e em Inteligência para lembrar informações sobre o tipo de inimigo eleito.",
  "Natural Explorer": "Em terreno de predileção: sem penalidade de terreno difícil, alerta ao forrageio, passagem silenciosa e bônus em navegação.",
  "Channel Divinity": "Efeito divino poderoso baseado na divindade escolhida. Recarrega no descanso curto ou longo.",
  "Turn Undead": "Canal Divino: mortos-vivos que falharem no teste de Sabedoria (CD = 8 + proficiência + mod. Sabedoria) fogem por 1 min.",
  "Divine Health": "Imunidade a doenças graças ao poder divino.",
};
const SPELL_DESCRIPTIONS: Record<string, string> = {
  "Fire Bolt": "Cantrip. Ataque à distância (120 pés): 1d10 de dano de fogo. Inflama objetos inflamáveis.",
  "Mage Hand": "Cantrip. Mão espectral move objetos de até 10 lbs e abre portas a 30 pés. Não ataca.",
  "Prestidigitation": "Cantrip. Pequenos truques mágicos: acender velas, limpar roupas, criar sons suaves ou mudar a cor de um objeto.",
  "Ray of Frost": "Cantrip. Raio de gelo (60 pés): 1d8 de dano frio. Reduz velocidade do alvo em 10 pés.",
  "Light": "Cantrip. Objeto emite luz brilhante (20 pés) e penumbra (+20 pés) por 1 hora.",
  "Sacred Flame": "Cantrip. Chama celestial (60 pés): 1d8 de dano radiante. Sem benefício de cobertura para o alvo.",
  "Guidance": "Cantrip. Concentração. Toque num aliado: ele adiciona 1d4 em um teste de habilidade antes de 1 min.",
  "Spare the Dying": "Cantrip. Toque: estabiliza criatura com 0 HP, ela para de morrer.",
  "Cure Wounds": "1º nível. Toque: recupere 1d8 + mod. de conjuração em HP.",
  "Healing Word": "1º nível. Ação bônus. 60 pés: recupere 1d4 + mod. de conjuração em HP.",
  "Bless": "1º nível. Concentração, 1 min. 3 criaturas: adicionam 1d4 em ataques e testes de resistência.",
  "Guiding Bolt": "1º nível. Bola de luz (120 pés): 4d6 de dano radiante. Próximo ataque ao alvo tem vantagem.",
  "Shield of Faith": "1º nível. Concentração, 10 min. Criatura toque: +2 de CA.",
  "Thunderwave": "1º nível. Cubo de 15 pés: 2d8 de dano trovejante + empurra 10 pés. CD Constituição para metade.",
  "Burning Hands": "1º nível. Cone de 15 pés: 3d6 de dano de fogo. CD Destreza para metade.",
  "Magic Missile": "1º nível. 3 dardos garantidos sem teste de ataque: cada um causa 1d4+1 de dano de força.",
  "Sleep": "1º nível. Área: 5d8 HP de criaturas adormecem, da menor HP para a maior. Imune: mortos-vivos e construtos.",
  "Detect Magic": "1º nível. Ritual ou concentração. Sente aura mágica de objetos e locais a 30 pés.",
  "Charm Person": "1º nível. Humanoide (60 pés) fica amigável por 1 hora ou até ser atacado. CD Sabedoria.",
  "Faerie Fire": "1º nível. Concentração. Cubo 20 pés: criaturas que falharem (CD Destreza) ficam iluminadas; ataques a elas têm vantagem.",
  "Entangle": "1º nível. Concentração. Terreno de 20 pés: vegetação prende criaturas que falharem em CD Força.",
  "Goodberry": "1º nível. Cria até 10 frutinhas: cada uma cura 1 HP e alimenta por um dia.",
  "Hunter's Mark": "1º nível. Concentração. Marque um alvo (90 pés): +1d6 de dano em cada acerto e vantagem em rastreá-lo.",
  "Divine Smite": "Paladino: ao acertar corpo-a-corpo, consuma um slot: +2d8 de dano radiante (+ 1d8 por nível do slot acima de 1°).",
  "Heroism": "1º nível. Concentração. Aliado fica imune a medo e ganha HP temporários (= mod. Presença) por turno.",
  "Vicious Mockery": "Cantrip. Insulto mágico (60 pés): 1d4 de dano psíquico + desvantagem no próximo ataque. CD Sabedoria.",
  "Dissonant Whispers": "1º nível. Sussurros torturantes (60 pés): 3d6 dano psíquico + alvo usa reação para fugir. CD Sabedoria.",
  "Thunderclap": "Cantrip. Criaturas a 5 pés testam CD Constituição ou tomam 1d6 de dano trovejante. Audível a 100 pés.",
  "Shillelagh": "Cantrip. Concentração, 1 min. Cajado/clava: ataques usam Sabedoria e causam 1d8 de dano.",
  "Produce Flame": "Cantrip. Chama na mão ilumina 10 pés. Pode arremessá-la (30 pés): 1d8 de dano fogo.",
  "Thorn Whip": "Cantrip. Chicote espinhoso (30 pés): 1d6 de dano perfurante + puxa o alvo 10 pés em sua direção.",
};

function Tip({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <span className="tipWrap">
      {children}
      <span className="tipBox">{text}</span>
    </span>
  );
}

function SheetView({ player }: { player: Player }) {
  const attrKeys = ["strength", "agility", "mind", "presence", "constitution", "wisdom"];
  return (
    <div className="detailCard stack">
      <p className="sectionLabel">Ficha · {player.characterName}</p>
      <p className="faint">{player.className} Nível {player.level} · HP {player.hitPoints}/{player.maxHitPoints} · AC {player.armorClass} · Prof +{player.proficiencyBonus}</p>

      {Object.keys(player.attributes).length > 0 && (
        <>
          <p className="sectionLabel" style={{ marginTop: "0.3rem" }}>Atributos</p>
          <div className="statsGrid">
            {attrKeys.filter((k) => player.attributes[k] !== undefined).map((key) => {
              const val = player.attributes[key] ?? 10;
              const mod = Math.floor((val - 10) / 2);
              return (
                <Tip key={key} text={ATTR_DESCRIPTIONS[key] ?? key}>
                  <div className="statCell" style={{ width: "100%" }}>
                    <span>{ATTR_LABELS[key] ?? key}</span>
                    <strong>{val}</strong>
                    <span style={{ fontSize: "0.7rem", color: "var(--gold)" }}>{mod >= 0 ? "+" : ""}{mod}</span>
                  </div>
                </Tip>
              );
            })}
          </div>
        </>
      )}

      {Object.keys(player.skills).length > 0 && (
        <>
          <p className="sectionLabel" style={{ marginTop: "0.3rem" }}>Perícias</p>
          <div className="skillList">
            {Object.entries(player.skills).map(([skill, bonus]) => (
              <Tip key={skill} text={SKILL_DESCRIPTIONS[skill] ?? `${skill}: bônus +${bonus}`}>
                <div className="skillRow" style={{ width: "100%" }}>
                  <span className="skillRow-name">{skill.charAt(0).toUpperCase() + skill.slice(1)}</span>
                  <span className="skillRow-val">{bonus >= 0 ? "+" : ""}{bonus}</span>
                </div>
              </Tip>
            ))}
          </div>
        </>
      )}

      {player.features.length > 0 && (
        <>
          <p className="sectionLabel" style={{ marginTop: "0.3rem" }}>Características</p>
          <div className="featureList">
            {player.features.map((entry) => (
              <Tip key={entry} text={FEATURE_DESCRIPTIONS[entry] ?? `Característica de classe: ${entry}`}>
                <div className="featureItem" style={{ width: "100%", cursor: "help" }}>{entry}</div>
              </Tip>
            ))}
          </div>
        </>
      )}

      {player.spells.length > 0 && (
        <>
          <p className="sectionLabel" style={{ marginTop: "0.3rem" }}>Magias</p>
          <div className="featureList">
            {player.spells.map((entry) => (
              <Tip key={entry} text={SPELL_DESCRIPTIONS[entry] ?? `Magia: ${entry}`}>
                <div className="featureItem" style={{ width: "100%", cursor: "help" }}>{entry}</div>
              </Tip>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const levelXpFloor = (level: number): number => {
  const table: Record<number, number> = {
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
  return table[level] ?? 0;
};

const formatXpProgress = (player: Player): string => {
  const current = player.experiencePoints ?? levelXpFloor(player.level);
  if (!player.nextLevelExperience) return `${current} XP`;
  return `${current}/${player.nextLevelExperience} XP`;
};

const formatClassLevels = (player: Player): string => Object.entries(player.classLevels ?? { [player.className]: player.level })
  .filter(([, level]) => level > 0)
  .map(([className, level]) => `${className} ${level}`)
  .join(" / ");

const speciesAbilityBonuses: Record<string, Record<string, number>> = {
  Human: { strength: 1, agility: 1, mind: 1, presence: 1, constitution: 1, wisdom: 1 },
  Elf: { agility: 2, mind: 1 },
  Dwarf: { constitution: 2, wisdom: 1 },
  Halfling: { agility: 2, presence: 1 },
};

const abilityModifier = (value: number): number => Math.floor((value - 10) / 2);

const buildAttributeBreakdown = (player: Player, key: string): string => {
  const total = player.attributes[key] ?? 10;
  const ancestryBonus = speciesAbilityBonuses[player.species]?.[key] ?? 0;
  const base = total - ancestryBonus;
  const modifier = abilityModifier(total);
  return [
    `${ATTR_LABELS[key] ?? key}: ${total} (${modifier >= 0 ? "+" : ""}${modifier}).`,
    `Base alocada: ${base}.`,
    ancestryBonus ? `Bônus racial de ${player.species}: +${ancestryBonus}.` : `Sem bônus racial de ${player.species} nesse atributo.`,
    `Total: ${base}${ancestryBonus ? ` + ${ancestryBonus}` : ""} = ${total}.`,
  ].join(" ");
};

const armorClassBreakdown = (player: Player): { total: number; text: string } => {
  const equipped = player.inventory.equipped.join(" | ").toLowerCase();
  const agilityMod = abilityModifier(player.attributes.agility ?? 10);
  const shield = /\bshield\b|escudo/.test(equipped) ? 2 : 0;
  let armorName = "sem armadura";
  let base = 10;
  let dexApplied = agilityMod;
  let capText = "mod. Agilidade completo";

  if (/plate mail|armadura de placas/.test(equipped)) {
    armorName = "Plate Mail / Armadura de placas";
    base = 18;
    dexApplied = 0;
    capText = "armadura pesada: não soma Agilidade";
  } else if (/chain mail|cota de malha/.test(equipped)) {
    armorName = "Chain Mail / Cota de malha";
    base = 16;
    dexApplied = 0;
    capText = "armadura pesada: não soma Agilidade";
  } else if (/scale mail|cota de escamas/.test(equipped)) {
    armorName = "Scale Mail / Cota de escamas";
    base = 14;
    dexApplied = Math.min(agilityMod, 2);
    capText = "armadura média: Agilidade máx. +2";
  } else if (/chain shirt|camisola de cota/.test(equipped)) {
    armorName = "Chain Shirt / Camisola de cota";
    base = 13;
    dexApplied = Math.min(agilityMod, 2);
    capText = "armadura média: Agilidade máx. +2";
  } else if (/studded leather|couro cravejado/.test(equipped)) {
    armorName = "Studded Leather / Couro cravejado";
    base = 12;
  } else if (/leather armor|armadura de couro|\bcouro\b/.test(equipped)) {
    armorName = "Leather Armor / Armadura de couro";
    base = 11;
  }

  const total = base + dexApplied + shield;
  return {
    total,
    text: [
      `CA calculada: ${total}.`,
      `${armorName}: base ${base}.`,
      `Agilidade ${player.attributes.agility ?? 10}: modificador ${agilityMod >= 0 ? "+" : ""}${agilityMod}; aplicado ${dexApplied >= 0 ? "+" : ""}${dexApplied} (${capText}).`,
      shield ? "Escudo equipado: +2." : "Sem escudo equipado.",
      `Fórmula: ${base} ${dexApplied >= 0 ? "+" : "-"} ${Math.abs(dexApplied)}${shield ? " + 2" : ""} = ${total}.`,
    ].join(" "),
  };
};

const hitPointBreakdown = (player: Player): string => {
  const constitutionMod = abilityModifier(player.attributes.constitution ?? 10);
  return [
    `HP atual: ${player.hitPoints}/${player.maxHitPoints}.`,
    `Constituição ${player.attributes.constitution ?? 10}: modificador ${constitutionMod >= 0 ? "+" : ""}${constitutionMod}.`,
    "No nível 1, D&D usa o dado de vida cheio da classe + modificador de Constituição. Em níveis seguintes, o sistema soma o ganho de HP da classe escolhida no level up.",
  ].join(" ");
};

const xpProgressPercent = (player: Player): number => {
  const current = player.experiencePoints ?? levelXpFloor(player.level);
  const next = player.nextLevelExperience;
  if (!next) return 100;
  const floor = levelXpFloor(player.level);
  return Math.max(0, Math.min(100, ((current - floor) / Math.max(1, next - floor)) * 100));
};
function LevelUpPanel({
  player,
  classes,
  skillChoices,
  spellChoices,
  onApply,
}: {
  player: Player;
  classes: string[];
  skillChoices: Record<string, { count: number; options: string[] }>;
  spellChoices: Record<string, { count: number; options: string[] }>;
  onApply: (className: string, choices?: { newSkillProficiencies?: string[]; newSpells?: string[] }) => void;
}) {
  const currentClasses = Object.keys(player.classLevels ?? {});
  const availableClasses = classes.filter((className) => currentClasses.includes(className) || currentClasses.length < 2);
  const [selectedClass, setSelectedClass] = useState(availableClasses[0] ?? player.className);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [selectedSpells, setSelectedSpells] = useState<string[]>([]);
  const classLevel = (player.classLevels?.[selectedClass] ?? 0) + 1;
  const skillLimit = player.classLevels?.[selectedClass] ? 1 : Math.min(2, skillChoices[selectedClass]?.count ?? 0);
  const spellLimit = (spellChoices[selectedClass]?.count ?? 0) > 0 ? (classLevel === 1 ? spellChoices[selectedClass].count : 2) : 0;
  const skillOptions = (skillChoices[selectedClass]?.options ?? []).filter((skill) => player.skills[skill.toLowerCase()] === undefined);
  const spellOptions = (spellChoices[selectedClass]?.options ?? []).filter((spell) => !player.spells.includes(spell));
  const toggle = (value: string, selected: string[], setSelected: (next: string[]) => void, limit: number) => {
    if (selected.includes(value)) {
      setSelected(selected.filter((entry) => entry !== value));
      return;
    }
    if (selected.length < limit) setSelected([...selected, value]);
  };

  return (
    <div className="detailCard stack">
      <p className="sectionLabel">Nivel disponivel</p>
      <p className="faint">
        {player.characterName} tem {player.pendingLevelUps} nivel(is) para aplicar. Multiclasse limitada a 2 classes.
      </p>
      <div className="featureList">
        {availableClasses.map((className) => (
          <button key={className} type="button" className={className === selectedClass ? "btn-primary" : "btn-ghost"} onClick={() => {
            setSelectedClass(className);
            setSelectedSkills([]);
            setSelectedSpells([]);
          }}>
            Subir {className} para nivel {(player.classLevels?.[className] ?? 0) + 1}
          </button>
        ))}
      </div>
      {skillLimit > 0 && skillOptions.length > 0 && (
        <>
          <p className="sectionLabel">Pericias novas ({selectedSkills.length}/{skillLimit})</p>
          <div className="choiceGrid">
            {skillOptions.map((skill) => (
              <button key={skill} type="button" className={selectedSkills.includes(skill) ? "choicePill choicePill-active" : "choicePill"} onClick={() => toggle(skill, selectedSkills, setSelectedSkills, skillLimit)}>
                {skill}
              </button>
            ))}
          </div>
        </>
      )}
      {spellLimit > 0 && spellOptions.length > 0 && (
        <>
          <p className="sectionLabel">Magias novas ({selectedSpells.length}/{spellLimit})</p>
          <div className="choiceGrid">
            {spellOptions.map((spell) => (
              <button key={spell} type="button" className={selectedSpells.includes(spell) ? "choicePill choicePill-active" : "choicePill"} onClick={() => toggle(spell, selectedSpells, setSelectedSpells, spellLimit)}>
                {spell}
              </button>
            ))}
          </div>
        </>
      )}
      <button type="button" className="btn-primary" onClick={() => onApply(selectedClass, { newSkillProficiencies: selectedSkills, newSpells: selectedSpells })}>
        Confirmar level up em {selectedClass}
      </button>
    </div>
  );
}

type SuggestedAction = {
  label: string;
  content: string;
  hint: string;
};

const inventoryItems = (player: Player): string[] => [...player.inventory.equipped, ...player.inventory.backpack];

const playerHasItem = (player: Player, matcher: RegExp): boolean =>
  inventoryItems(player).some((item) => matcher.test(item));

const firstMatchingItem = (player: Player, matcher: RegExp): string | null =>
  inventoryItems(player).find((item) => matcher.test(item)) ?? null;

function buildSuggestedActions(player: Player, room: RoomState): SuggestedAction[] {
  const actions: SuggestedAction[] = [];
  const weapon = firstMatchingItem(player, /sword|axe|bow|rapier|dagger|staff|mace|warhammer|espada|machado|arco|adaga/i);
  const secondWind = player.resources?.limited?.second_wind;
  const actionSurge = player.resources?.limited?.action_surge;

  if (room.combat.active) {
    if (weapon) actions.push({ label: `Atacar com ${weapon}`, content: `*ataco com ${weapon} mirando o inimigo mais ameaçador`, hint: getEquipmentInfo(weapon).summary });
    if (playerHasItem(player, /shield|escudo/i)) actions.push({ label: "Postura defensiva", content: "*levanto o escudo e assumo uma postura defensiva, protegendo meu espaço", hint: "Usa escudo/cobertura e deixa a intenção clara ao Mestre." });
    if (secondWind && secondWind.used < secondWind.max) actions.push({ label: "Usar Second Wind", content: "*uso Second Wind para recuperar o fôlego em meio ao combate", hint: `${secondWind.max - secondWind.used}/${secondWind.max} uso(s) restante(s).` });
    if (actionSurge && actionSurge.used < actionSurge.max) actions.push({ label: "Usar Action Surge", content: "*uso Action Surge para criar uma abertura tática imediata", hint: `${actionSurge.max - actionSurge.used}/${actionSurge.max} uso(s) restante(s).` });
    actions.push({ label: "Ajudar aliado", content: "*ajudo o aliado mais próximo a ganhar vantagem na próxima ação", hint: "Boa opção quando atacar não é a melhor escolha." });
  } else {
    actions.push({ label: "Observar cena", content: "*observo o ambiente com calma procurando ameaças, pistas e rotas seguras", hint: "Costuma pedir Percepção/Investigação se houver risco." });
    if (weapon) actions.push({ label: "Preparar arma", content: `*mantenho ${weapon} pronto, mas avanço com cautela sem iniciar combate`, hint: "Mostra preparo sem forçar luta." });
    if (playerHasItem(player, /torch|torches|tocha/i)) actions.push({ label: "Acender tocha", content: "*acendo uma tocha para iluminar melhor o caminho e revelar detalhes escondidos", hint: getEquipmentInfo("Torch").summary });
    if (playerHasItem(player, /rope|corda/i)) actions.push({ label: "Usar corda", content: "*uso minha corda para criar uma passagem segura e prender um ponto de apoio", hint: getEquipmentInfo("Rope").summary });
    if (playerHasItem(player, /lockpicks|gazua|ladrao|ladrão/i)) actions.push({ label: "Usar gazuas", content: "*examino a fechadura ou mecanismo e uso minhas gazuas com cuidado", hint: getEquipmentInfo("Lockpicks").summary });
    if (playerHasItem(player, /healer|curandeiro/i)) actions.push({ label: "Primeiros socorros", content: "*uso o kit de curandeiro para avaliar ferimentos e estabilizar quem precisar", hint: getEquipmentInfo("Healer's Kit").summary });
    actions.push({ label: "Falar com cautela", content: "- tento conversar com calma, deixando claro que não procuro conflito", hint: "Ajuda o Mestre a resolver socialmente antes de puxar combate." });
  }

  actions.push({ label: "Perguntar opções", content: "(com base na minha ficha e na cena, quais são minhas opções mais razoáveis agora?)", hint: "Pergunta OOC para o Mestre orientar como numa mesa real." });
  return actions.slice(0, 7);
}

function SuggestedActions({ player, room, onPick }: { player: Player; room: RoomState; onPick: (content: string) => void }) {
  const actions = buildSuggestedActions(player, room);
  return (
    <section className="suggestedActions">
      <div className="suggestedActionsHead">
        <strong>O que posso fazer agora?</strong>
        <span>{room.combat.active ? "Combate" : "Cena"}</span>
      </div>
      <div className="suggestedActionGrid">
        {actions.map((action) => (
          <button key={action.label} type="button" className="suggestedActionBtn" onClick={() => onPick(action.content)} title={action.hint}>
            <span>{action.label}</span>
            <em>{action.hint}</em>
          </button>
        ))}
      </div>
    </section>
  );
}

function PaperSheetView({ player }: { player: Player }) {
  const attrKeys = ["strength", "agility", "mind", "presence", "constitution", "wisdom"];
  const resourceList = Object.values(player.resources?.limited ?? {});
  const hpPct = player.maxHitPoints > 0 ? Math.max(0, Math.min(100, (player.hitPoints / player.maxHitPoints) * 100)) : 0;
  const xpPct = xpProgressPercent(player);
  const equippedWeapons = player.inventory.equipped.filter((item) => /sword|axe|bow|rapier|dagger|staff|mace|crossbow|espada|machado|arco|adaga/i.test(item));
  const abilityMod = abilityModifier;
  const fmt = (value: number) => `${value >= 0 ? "+" : ""}${value}`;
  const classLine = formatClassLevels(player);
  const acBreakdown = armorClassBreakdown(player);

  return (
    <div className="paperSheet">
      <header className="paperSheetHeader">
        <div>
          <span className="paperKicker">Ficha de personagem</span>
          <h3>{player.characterName}</h3>
        </div>
        <div className="paperIdentity">
          <span>{classLine || `${player.className} ${player.level}`}</span>
          <span>{player.species}</span>
          <span>{player.background}</span>
        </div>
      </header>

      <section className="paperVitals">
        <div className="paperVital paperVital-wide">
          <span>HP</span>
          <strong>{player.hitPoints}/{player.maxHitPoints}</strong>
          <InfoButton text={hitPointBreakdown(player)} />
          <div className="paperMeter"><i style={{ width: `${hpPct}%` }} /></div>
        </div>
        <div className="paperVital"><span>AC</span><strong>{player.armorClass}</strong><InfoButton text={acBreakdown.text} /></div>
        <div className="paperVital"><span>Prof.</span><strong>+{player.proficiencyBonus}</strong><InfoButton text={`Bônus de proficiência por nível total ${player.level}: +${player.proficiencyBonus}. Em D&D 5e, níveis 1-4 usam +2; níveis 5-8 usam +3.`} /></div>
        <div className="paperVital"><span>Ouro</span><strong>{player.inventory.gold}</strong></div>
        <div className="paperVital paperVital-wide">
          <span>XP</span>
          <strong>{formatXpProgress(player)}</strong>
          <div className="paperMeter"><i style={{ width: `${xpPct}%` }} /></div>
        </div>
      </section>

      {resourceList.length > 0 && (
        <section className="paperBox">
          <h4>Recursos</h4>
          <div className="resourceGrid">
            {resourceList.map((resource) => (
              <div key={resource.label} className="resourceChip">
                <span>{resource.label}</span>
                <strong>{Math.max(0, resource.max - resource.used)}/{resource.max}</strong>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="paperColumns">
        <div className="paperBox">
          <h4>Atributos</h4>
          <div className="abilityGrid">
            {attrKeys.filter((key) => player.attributes[key] !== undefined).map((key) => {
              const value = player.attributes[key] ?? 10;
              return (
                <div key={key} className="abilityCard">
                  <span>{ATTR_LABELS[key] ?? key}</span>
                  <strong>{fmt(abilityMod(value))}</strong>
                  <em>{value}</em>
                  <InfoButton text={`${ATTR_DESCRIPTIONS[key] ?? key} ${buildAttributeBreakdown(player, key)}`} />
                </div>
              );
            })}
          </div>
        </div>

        <div className="paperBox">
          <h4>Pericias</h4>
          <div className="paperSkillList">
            {Object.entries(player.skills).sort(([a], [b]) => a.localeCompare(b)).map(([skill, bonus]) => (
              <div key={skill} className="paperSkillRow">
                <span>{skill.charAt(0).toUpperCase() + skill.slice(1)}</span>
                <strong>{fmt(bonus)}</strong>
                <InfoButton text={SKILL_DESCRIPTIONS[skill] ?? `${skill}: bonus ${fmt(bonus)}.`} />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="paperBox">
        <h4>Habilidades</h4>
        <div className="paperFeatureList">
          {player.features.length > 0 ? player.features.map((entry) => (
            <InfoLine key={entry} label={entry} text={FEATURE_DESCRIPTIONS[entry] ?? `Caracteristica de classe: ${entry}.`} />
          )) : <span className="paperEmpty">Nenhuma habilidade registrada.</span>}
        </div>
      </section>

      <section className="paperBox">
        <h4>Magias</h4>
        <div className="paperFeatureList">
          {player.spells.length > 0 ? player.spells.map((entry) => (
            <InfoLine key={entry} label={entry} text={SPELL_DESCRIPTIONS[entry] ?? `Magia: ${entry}.`} />
          )) : <span className="paperEmpty">Nenhuma magia conhecida/preparada.</span>}
        </div>
      </section>

      <section className="paperBox">
        <h4>Equipamento</h4>
        <div className="paperEquipment">
          <div>
            <strong>Equipado</strong>
            {player.inventory.equipped.map((entry) => {
              const info = getEquipmentInfo(entry);
              return <InfoLine key={entry} label={entry} meta={info.summary} text={info.details} compact />;
            })}
          </div>
          <div>
            <strong>Mochila</strong>
            {player.inventory.backpack.map((entry) => {
              const info = getEquipmentInfo(entry);
              return <InfoLine key={entry} label={entry} meta={info.summary} text={info.details} compact />;
            })}
          </div>
        </div>
      </section>

      <section className="paperBox">
        <h4>Ataques</h4>
        <div className="attackRows">
          {(equippedWeapons.length > 0 ? equippedWeapons : player.inventory.equipped).slice(0, 4).map((item) => (
            <div key={item} className="attackRow">
              <span>{item}</span>
              <strong>{fmt(player.skills.melee ?? player.proficiencyBonus)}</strong>
              <em>{/bow|arco|crossbow/i.test(item) ? "distancia" : "corpo a corpo"}</em>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

const loreCategoryLabels: Record<string, string> = {
  origin: "Origem",
  motivation: "Motivacao",
  turning_point: "Ponto de virada",
  connection: "Conexao",
  reputation: "Reputacao",
  favor: "Favor",
  crime: "Crime",
  bond: "Vinculo",
  title: "Titulo",
  achievement: "Feito",
  enemy: "Inimizade",
  promise: "Promessa",
  consequence: "Consequencia",
};

const moralAxisLabels: Record<string, string> = {
  compassion: "Compaixao",
  cruelty: "Crueldade",
  honesty: "Honestidade",
  deceit: "Engano",
  lawfulness: "Ordem",
  chaos: "Caos",
  courage: "Coragem",
  selfishness: "Egoismo",
};

function PlayerLoreView({ player }: { player: Player }) {
  const loreEvents = [...(player.loreEvents ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const moralProfile = player.moralProfile;
  const moralEntries = moralProfile
    ? Object.entries(moralProfile)
      .filter(([key, value]) => key !== "label" && typeof value === "number" && value !== 0)
      .sort(([, a], [, b]) => Math.abs(Number(b)) - Math.abs(Number(a)))
      .slice(0, 6)
    : [];

  return (
    <div className="paperSheet loreSheet">
      <header className="paperSheetHeader">
        <div>
          <span className="paperKicker">Cronica pessoal</span>
          <h3>{player.characterName}</h3>
        </div>
        <div className="paperIdentity">
          <span>Bussola moral</span>
          <span>{moralProfile?.label ?? "em formacao"}</span>
          <span>{loreEvents.length} registro(s)</span>
        </div>
      </header>

      <section className="paperBox">
        <h4>Bussola moral</h4>
        {moralEntries.length > 0 ? (
          <div className="moralGrid">
            {moralEntries.map(([axis, value]) => (
              <div key={axis} className="moralAxis">
                <span>{moralAxisLabels[axis] ?? axis}</span>
                <strong>{Number(value) > 0 ? "+" : ""}{Number(value)}</strong>
              </div>
            ))}
          </div>
        ) : (
          <span className="paperEmpty">O mundo ainda esta formando uma opiniao sobre este personagem.</span>
        )}
      </section>

      <section className="paperBox">
        <h4>Feitos, dividas e consequencias</h4>
        <div className="loreTimeline">
          {loreEvents.length > 0 ? loreEvents.map((event) => (
            <article key={event.id} className={`loreEvent loreEvent-${event.importance}`}>
              <div className="loreEventHead">
                <strong>{event.title}</strong>
                <span>{loreCategoryLabels[event.category] ?? event.category} · {event.importance}</span>
              </div>
              <p>{event.summary}</p>
              {(event.location || event.peopleInvolved?.length) && (
                <em>
                  {event.location ? `Local: ${event.location}` : ""}
                  {event.location && event.peopleInvolved?.length ? " · " : ""}
                  {event.peopleInvolved?.length ? `Pessoas: ${event.peopleInvolved.join(", ")}` : ""}
                </em>
              )}
            </article>
          )) : (
            <span className="paperEmpty">Sem feitos importantes registrados ainda. Acoes comuns ficam fora daqui para manter o lore limpo.</span>
          )}
        </div>
      </section>
    </div>
  );
}

function InfoButton({ text }: { text: string }) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const summaryRect = buttonRef.current.getBoundingClientRect();
    const sheetRect = buttonRef.current.closest(".paperSheet")?.getBoundingClientRect();
    const width = Math.min(280, Math.max(220, (sheetRect?.width ?? window.innerWidth) - 24));
    const minLeft = (sheetRect?.left ?? 8) + 8;
    const maxLeft = Math.max(minLeft, (sheetRect?.right ?? window.innerWidth - 8) - width - 8);
    const desiredLeft = summaryRect.left + summaryRect.width / 2 - width / 2;
    const left = Math.min(maxLeft, Math.max(minLeft, desiredLeft));
    const preferredTop = summaryRect.bottom + 8;
    const sheetBottom = sheetRect?.bottom ?? window.innerHeight - 8;
    const top = preferredTop > sheetBottom - 120
      ? Math.max((sheetRect?.top ?? 8) + 8, Math.min(summaryRect.top - 8, window.innerHeight - 140))
      : preferredTop;
    setPopoverStyle({ left, top, width });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", () => setOpen(false), { once: true });
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`infoPopoverButton${open ? " infoPopoverButton-open" : ""}`}
        aria-label="Mais informacoes"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        i
      </button>
      {open && createPortal(
        <div className="infoPopoverPanel" style={popoverStyle}>{text}</div>,
        document.body,
      )}
    </>
  );
}

function InfoLine({ label, text, meta, compact = false }: { label: string; text: string; meta?: string; compact?: boolean }) {
  return (
    <div className={`paperInfoLine${compact ? " paperInfoLine-compact" : ""}`}>
      <span>
        {label}
        {meta && <em className="paperInfoMeta">{meta}</em>}
      </span>
      <InfoButton text={text} />
    </div>
  );
}

function InventoryView({ player }: { player: Player }) {
  return (
    <div className="paperSheet inventorySheet">
      <header className="paperSheetHeader">
        <div>
          <span className="paperKicker">Inventário</span>
          <h3>{player.characterName}</h3>
        </div>
        <div className="paperIdentity">
          <span>Ouro {player.inventory.gold}</span>
          <span>{player.inventory.equipped.length} equipado(s)</span>
          <span>{player.inventory.backpack.length} na mochila</span>
        </div>
      </header>

      <section className="paperColumns">
        <div className="paperBox">
          <h4>Equipado</h4>
          <div className="paperFeatureList">
            {player.inventory.equipped.length > 0 ? player.inventory.equipped.map((entry) => {
              const info = getEquipmentInfo(entry);
              return <InfoLine key={entry} label={entry} meta={info.summary} text={info.details} />;
            }) : <span className="paperEmpty">Nada equipado.</span>}
          </div>
        </div>

        <div className="paperBox">
          <h4>Mochila</h4>
          <div className="paperFeatureList">
            {player.inventory.backpack.length > 0 ? player.inventory.backpack.map((entry) => {
              const info = getEquipmentInfo(entry);
              return <InfoLine key={entry} label={entry} meta={info.summary} text={info.details} />;
            }) : <span className="paperEmpty">Mochila vazia.</span>}
          </div>
        </div>
      </section>
    </div>
  );
}

function NotesView({ notesDraft, setNotesDraft, onSave }: { notesDraft: string; setNotesDraft: (value: string) => void; onSave: () => void }) {
  return (
    <div className="paperSheet notesSheet">
      <header className="paperSheetHeader">
        <div>
          <span className="paperKicker">Notas de mesa</span>
          <h3>Anotações</h3>
        </div>
        <div className="paperIdentity">
          <span>Privado da aba</span>
          <span>Salvo na ficha</span>
        </div>
      </header>
      <section className="paperBox">
        <h4>Registro do jogador</h4>
        <textarea
          className="paperTextarea"
          value={notesDraft}
          onChange={(event) => setNotesDraft(event.target.value)}
          rows={12}
          placeholder="Pistas, suspeitos, promessas, dívidas, mapas mentais..."
        />
        <button type="button" className="btn-primary" onClick={onSave}>Salvar anotações</button>
      </section>
    </div>
  );
}

function LoadingArtCard({
  title,
  description,
  variant,
}: {
  title: string;
  description: string;
  variant: "scene" | "portrait" | "gallery";
}) {
  return (
    <div className={`loadingArtCard loadingArtCard-${variant}`}>
      <div className="loadingDot" aria-hidden="true" />
      {title && <strong>{title}</strong>}
      {description && <p>{description}</p>}
    </div>
  );
}
