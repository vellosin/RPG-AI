import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useLayoutEffect, useRef, useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { io } from "socket.io-client";
import { getEquipmentInfo } from "./equipmentCatalog";
const configuredApiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").trim();
const apiBaseUrl = configuredApiBaseUrl || (import.meta.env.DEV ? "http://127.0.0.1:8787" : window.location.origin);
const sessionKey = "local-rpg-ai-client";
const silentAudioDataUri = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQQAAAAAAA==";
const visibleAudioTtlMs = 120_000;
const socket = io(apiBaseUrl, {
    autoConnect: true,
});
const readSession = () => {
    const raw = window.sessionStorage.getItem(sessionKey);
    if (!raw) {
        return null;
    }
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
};
const deriveInputKind = (value) => {
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
const messagePrefix = {
    system: "Sistema",
    action: "Ação",
    speech: "Fala",
    whisper: "Sussurro",
    question: "Pergunta",
    gm: "Mestre",
    roll: "Rolagem",
};
const commonDice = [4, 6, 8, 10, 12, 20];
const randomDieValue = (sides) => Math.max(1, Math.floor(Math.random() * sides) + 1);
const buildDicePool = (count, sides) => Array.from({ length: count }, (_, index) => ({
    id: `${sides}-${index}-${crypto.randomUUID()}`,
    sides,
    value: randomDieValue(sides),
    revealed: false,
}));
const toAssetUrl = (assetUrl) => assetUrl.startsWith("http") ? assetUrl : `${apiBaseUrl}${assetUrl}`;
const findPendingPortraitJob = (room, player) => room.imageJobs.find((job) => job.profile === "portrait" && job.status === "queued" && job.subjectName === player.characterName);
const summarizePendingImages = (jobs) => {
    if (jobs.length === 0) {
        return "";
    }
    const labels = jobs.reduce((counts, job) => {
        counts[job.profile] = (counts[job.profile] ?? 0) + 1;
        return counts;
    }, {});
    return Object.entries(labels)
        .map(([profile, count]) => `${count} ${profile}`)
        .join(" · ");
};
export function App() {
    const initialSession = readSession();
    const [room, setRoom] = useState(null);
    const [rooms, setRooms] = useState([]);
    const [playerId, setPlayerId] = useState(initialSession?.playerId ?? "");
    const [roomCode, setRoomCode] = useState(initialSession?.roomCode ?? "");
    const [status, setStatus] = useState("Crie uma sessão ou carregue uma existente.");
    const [integrations, setIntegrations] = useState(null);
    const [lobbyOptions, setLobbyOptions] = useState(null);
    const [setupDraft, setSetupDraft] = useState({
        systemId: "dnd5e-srd",
        startingLevel: 1,
        npcCompanions: 0,
        enemyDifficulty: "standard",
        battleIntensity: "medium",
        gmKindness: "balanced",
    });
    const [roomName, setRoomName] = useState("");
    const [isGeneratingPortraitPreview, setIsGeneratingPortraitPreview] = useState(false);
    const [characterDraft, setCharacterDraft] = useState({
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
    const [activePanel, setActivePanel] = useState(null);
    const [notesDraft, setNotesDraft] = useState("");
    const [diceCount, setDiceCount] = useState(1);
    const [diceSides, setDiceSides] = useState(20);
    const [diceModifier, setDiceModifier] = useState(0);
    const [diceRoll, setDiceRoll] = useState({
        status: "idle",
        label: "Pronto para rolar",
        modifier: 0,
        dice: [],
    });
    const [isSending, setIsSending] = useState(false);
    const [isRegenerating, setIsRegenerating] = useState(false);
    const [llmStatsOpen, setLlmStatsOpen] = useState(false);
    const [llmStats, setLlmStats] = useState(null);
    const [streamingNarrations, setStreamingNarrations] = useState({});
    // TTS: o usuário precisa habilitar uma vez (autoplay policy do browser) e depois
    // todos os eventos `room:gmAudio` entram numa fila tocada sequencialmente.
    const [ttsEnabled, setTtsEnabled] = useState(true);
    const [audioClips, setAudioClips] = useState([]);
    const audioQueueRef = useRef([]);
    const audioElementRef = useRef(null);
    const isPlayingRef = useRef(false);
    const [preparationStep, setPreparationStep] = useState("");
    const [preparationProgress, setPreparationProgress] = useState(0);
    const [suggestions, setSuggestions] = useState(null);
    const [selectedSuggestion, setSelectedSuggestion] = useState(null);
    const [isFetchingSuggestions, setIsFetchingSuggestions] = useState(false);
    const [charCreationStep, setCharCreationStep] = useState(1);
    const [attributeDraft, setAttributeDraft] = useState({
        strength: 8, agility: 8, mind: 8, presence: 8, constitution: 8, wisdom: 8,
    });
    const [skillDraft, setSkillDraft] = useState([]);
    const [spellDraft, setSpellDraft] = useState([]);
    const [equipChoiceIdx, setEquipChoiceIdx] = useState(0);
    useEffect(() => {
        const handleSnapshot = (snapshot) => {
            setRoom(snapshot);
            const localPlayer = snapshot.players.find((entry) => entry.id === playerId);
            setNotesDraft(localPlayer?.notes ?? "");
        };
        const handleMessages = (incoming) => {
            setRoom((current) => current ? { ...current, messages: [...current.messages, ...incoming] } : current);
            const finalGmMessage = incoming.find((message) => message.role === "gm" && message.authorName === "Game Master");
            if (finalGmMessage) {
                setAudioClips((current) => current.map((clip) => clip.messageId ? clip : { ...clip, messageId: finalGmMessage.id }));
                setStreamingNarrations({});
            }
        };
        const handleScene = (scene) => {
            setRoom((current) => current ? { ...current, scene } : current);
        };
        const handleImage = (job) => {
            setRoom((current) => current ? {
                ...current,
                imageJobs: current.imageJobs.some((entry) => entry.id === job.id)
                    ? current.imageJobs.map((entry) => (entry.id === job.id ? job : entry))
                    : [...current.imageJobs, job],
            } : current);
        };
        const handlePlayers = (players) => {
            setRoom((current) => current ? { ...current, players } : current);
            const localPlayer = players.find((entry) => entry.id === playerId);
            setNotesDraft(localPlayer?.notes ?? "");
        };
        const handleCombat = (combat) => {
            setRoom((current) => current ? { ...current, combat } : current);
        };
        const handleImageJobs = (imageJobs) => {
            setRoom((current) => current ? { ...current, imageJobs } : current);
        };
        const handlePreparationStep = ({ step, progress }) => {
            setPreparationStep(step);
            setPreparationProgress(progress);
        };
        const handleGmStream = (event) => {
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
        const playNextAudio = () => {
            if (isPlayingRef.current)
                return;
            const next = audioQueueRef.current.shift();
            if (!next)
                return;
            const audio = audioElementRef.current;
            if (!audio)
                return;
            isPlayingRef.current = true;
            audio.src = `${apiBaseUrl}${next.audioUrl}`;
            audio.play().catch(() => {
                // Falha no play (autoplay bloqueado, áudio expirado, etc.). Pula essa frase.
                isPlayingRef.current = false;
                playNextAudio();
            });
        };
        const handleGmAudio = (event) => {
            setAudioClips((current) => {
                const clip = { ...event, expiresAt: Date.now() + visibleAudioTtlMs };
                const withoutDuplicate = current.filter((entry) => entry.audioId !== event.audioId && entry.expiresAt > Date.now());
                return [...withoutDuplicate, clip].sort((a, b) => (a.messageId ?? a.streamId).localeCompare(b.messageId ?? b.streamId) || a.sequence - b.sequence);
            });
            window.setTimeout(() => {
                setAudioClips((current) => current.filter((entry) => entry.audioId !== event.audioId));
            }, visibleAudioTtlMs);
            if (!ttsEnabled)
                return;
            // Insere mantendo ordem por sequence dentro do mesmo streamId.
            const queue = audioQueueRef.current;
            const insertIndex = queue.findIndex((entry) => entry.streamId === event.streamId && entry.sequence > event.sequence);
            if (insertIndex === -1) {
                queue.push(event);
            }
            else {
                queue.splice(insertIndex, 0, event);
            }
            playNextAudio();
        };
        const handleGmAudioCancel = () => {
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
        const handleAudioEnded = () => {
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
                const payload = await lobbyOptionsResponse.json();
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
            const payload = await response.json();
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
            }
            else {
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
        }));
    }, [room, playerId, characterDraft.name, characterDraft.characterName]);
    // Auto-configure dice panel when a roll is requested
    const pendingRoll = room?.scene.pendingRollRequest;
    useEffect(() => {
        if (!pendingRoll)
            return;
        const sideMap = { d4: 4, d6: 6, d8: 8, d10: 10, d12: 12, d20: 20 };
        const sides = sideMap[pendingRoll.die] ?? 20;
        setDiceSides(sides);
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
    const jobsByMessage = new Map();
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
    const createRoom = async (event) => {
        event.preventDefault();
        const response = await fetch(`${apiBaseUrl}/api/rooms`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: roomName, setup: setupDraft }),
        });
        const payload = await response.json();
        setRoom(payload);
        setRoomCode(payload.code);
        socket.emit("room:subscribe", payload.id);
        setStatus(`Sessão ${payload.name} criada. Agora crie o personagem do anfitrião.`);
        await refreshRooms();
    };
    const loadRoomByCode = async (event) => {
        event.preventDefault();
        const response = await fetch(`${apiBaseUrl}/api/rooms/by-code/${roomCode}`);
        if (!response.ok) {
            setStatus("Código de sessão não encontrado.");
            return;
        }
        const payload = await response.json();
        setRoom(payload);
        socket.emit("room:subscribe", payload.id);
        setStatus(`Sessão ${payload.name} carregada.`);
    };
    const deleteSavedRoom = async (entry) => {
        const confirmed = window.confirm(`Excluir a sessão "${entry.name}" (${entry.code})? Essa ação remove a sala e o histórico dela.`);
        if (!confirmed)
            return;
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
    const joinRoom = async (event) => {
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
        if (isGeneratingPortraitPreview)
            return;
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
        }
        catch {
            setStatus("Falha de rede ao gerar retrato.");
        }
        finally {
            setIsGeneratingPortraitPreview(false);
        }
    };
    const setReady = async (ready) => {
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
        if (!room)
            return;
        setIsFetchingSuggestions(true);
        setStatus("O Mestre está preparando as sugestões de aventura...");
        try {
            const response = await fetch(`${apiBaseUrl}/api/rooms/${room.id}/suggestions`);
            const payload = await response.json();
            if (response.ok && Array.isArray(payload)) {
                setSuggestions(payload);
            }
            else {
                setSuggestions([]);
            }
        }
        catch {
            setSuggestions([]);
        }
        finally {
            setIsFetchingSuggestions(false);
            setStatus("");
        }
    };
    const startSession = async (hook, sceneKeyword, adventureTitle) => {
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
    const applyLevelUp = async (className, choices) => {
        if (!room || !localPlayer)
            return;
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
        }
        catch {
            setStatus("Falha de rede ao aplicar nível.");
        }
    };
    const regeneratePortrait = async () => {
        if (!room || !localPlayer)
            return;
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
        }
        catch {
            setStatus("Falha de rede ao regenerar retrato.");
        }
    };
    const handleRegenerate = async () => {
        if (!room || !playerId || !isHost || isRegenerating)
            return;
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
                setStatus(payload.message ?? "Não foi possível regenerar a narração.");
            }
            else {
                setStatus("Narração regenerada.");
            }
        }
        catch {
            setStatus("Falha de rede ao regenerar.");
        }
        finally {
            setIsRegenerating(false);
        }
    };
    const refreshLlmStats = async () => {
        try {
            const response = await fetch(`${apiBaseUrl}/api/llm-stats?limit=30`);
            if (response.ok) {
                const data = (await response.json());
                setLlmStats(data);
            }
        }
        catch {
            // best-effort
        }
    };
    const sendChat = async (event) => {
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
                setStatus(payload.message ?? "Não foi possível enviar a mensagem.");
            }
            // Success: socket events (room:messages, room:scene, etc.) handle all state updates
        }
        catch {
            setChatInput(inputSnapshot);
            setStatus("Não foi possível enviar a mensagem.");
        }
        finally {
            setIsSending(false);
        }
    };
    const insertChatPrefix = (prefix) => {
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
    const chooseSuggestedAction = (content) => {
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
                const useAdvantage = pendingRoll?.advantage &&
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
                        setStatus(payload.message ?? "Não foi possível registrar a rolagem.");
                        return;
                    }
                    // Success: socket events handle state updates
                    setStatus("Rolagem compartilhada com a mesa.");
                }).catch(() => {
                    setStatus("Não foi possível registrar a rolagem.");
                });
                const useAdvantage = pendingRoll?.advantage &&
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
    return (_jsxs("main", { className: `appShell${isActive ? " appShell-active" : ""}`, children: [_jsxs("header", { className: "topbar", children: [_jsxs("div", { className: "topbar-title", children: [_jsx("p", { className: "eyebrow", children: "Local-first AI RPG" }), _jsx("h1", { children: isActive ? room.name : "RPG — Lobby" })] }), pendingImageJobs.length > 0 && (_jsxs("span", { className: "imagePendingBadge", children: [_jsx("span", { className: "loadingDot", "aria-hidden": "true" }), pendingImageJobs.length, " imagem", pendingImageJobs.length > 1 ? "ns" : "", pendingImageSummary ? ` · ${pendingImageSummary}` : ""] })), _jsx("p", { className: "muted", style: { fontSize: "0.76rem", maxWidth: 300 }, children: status }), _jsxs("div", { className: "topbar-sys", children: [_jsxs("span", { className: `sysDot${integrations?.jan.ok ? " sysDot-ok" : " sysDot-warn"}`, children: [_jsx("span", { style: { width: 6, height: 6, borderRadius: "999px", background: "currentColor", display: "inline-block" } }), "Jan"] }), _jsxs("span", { className: `sysDot${integrations?.image.ok ? " sysDot-ok" : " sysDot-warn"}`, children: [_jsx("span", { style: { width: 6, height: 6, borderRadius: "999px", background: "currentColor", display: "inline-block" } }), "Imagem"] }), _jsxs("span", { className: `sysDot${integrations?.memory?.ok ? " sysDot-ok" : " sysDot-warn"}`, title: integrations?.memory?.details, children: [_jsx("span", { style: { width: 6, height: 6, borderRadius: "999px", background: "currentColor", display: "inline-block" } }), "Mem\u00F3ria"] })] }), _jsx("div", { className: "topbar-actions", children: _jsx("button", { type: "button", className: "btn-ghost", onClick: clearLocalSession, children: "Limpar aba" }) })] }), !room && (_jsxs("section", { className: "lobbyStage", children: [_jsxs("section", { className: "lobbyCard", children: [_jsxs("h2", { children: ["Nova campanha", _jsx("span", { className: "lobbyCard-step", children: "passo 1" })] }), _jsx("p", { className: "lobbyCard-lead", children: "Defina a base do mundo. Voc\u00EA poder\u00E1 ajustar tudo depois que entrar na sala." }), _jsxs("form", { onSubmit: createRoom, className: "stack", children: [_jsxs("fieldset", { className: "formSection", children: [_jsx("legend", { children: "Sess\u00E3o" }), _jsxs("div", { className: "formField", children: [_jsx("label", { htmlFor: "lobby-room-name", children: "Nome da sess\u00E3o" }), _jsx("input", { id: "lobby-room-name", value: roomName, placeholder: "Ex.: A Coroa de Cinzas", onChange: (event) => setRoomName(event.target.value) })] })] }), _jsxs("fieldset", { className: "formSection", children: [_jsx("legend", { children: "Configura\u00E7\u00E3o da campanha" }), _jsxs("div", { className: "formField", children: [_jsx("label", { children: "Sistema" }), _jsx("select", { value: setupDraft.systemId, onChange: (event) => setSetupDraft((current) => ({ ...current, systemId: event.target.value })), children: lobbyOptions?.options.systems.map((entry) => _jsx("option", { value: entry.id, children: entry.label }, entry.id)) })] }), _jsxs("div", { className: "formGrid-2", children: [_jsxs("div", { className: "formField", children: [_jsx("label", { children: "N\u00EDvel inicial" }), _jsx("select", { value: setupDraft.startingLevel, onChange: (event) => setSetupDraft((current) => ({ ...current, startingLevel: Number(event.target.value) })), children: [1, 2, 3, 4, 5].map((level) => _jsx("option", { value: level, children: level }, level)) })] }), _jsxs("div", { className: "formField", children: [_jsx("label", { children: "Companheiros NPC" }), _jsx("select", { value: setupDraft.npcCompanions, onChange: (event) => setSetupDraft((current) => ({ ...current, npcCompanions: Number(event.target.value) })), children: lobbyOptions?.options.npcCompanions.map((entry) => _jsx("option", { value: entry.id, children: entry.label }, entry.id)) })] })] })] }), _jsxs("fieldset", { className: "formSection", children: [_jsx("legend", { children: "Estilo de combate" }), _jsxs("div", { className: "formGrid-2", children: [_jsxs("div", { className: "formField", children: [_jsx("label", { children: "Dificuldade dos inimigos" }), _jsx("select", { value: setupDraft.enemyDifficulty, onChange: (event) => setSetupDraft((current) => ({ ...current, enemyDifficulty: event.target.value })), children: lobbyOptions?.options.difficulties.map((entry) => _jsx("option", { value: entry.id, children: entry.label }, entry.id)) })] }), _jsxs("div", { className: "formField", children: [_jsx("label", { children: "Intensidade das batalhas" }), _jsx("select", { value: setupDraft.battleIntensity, onChange: (event) => setSetupDraft((current) => ({ ...current, battleIntensity: event.target.value })), children: lobbyOptions?.options.battleIntensity.map((entry) => _jsx("option", { value: entry.id, children: entry.label }, entry.id)) })] })] })] }), _jsxs("fieldset", { className: "formSection", children: [_jsx("legend", { children: "Tom do mestre" }), _jsxs("div", { className: "formField", children: [_jsx("label", { children: "Bondade do mestre" }), _jsx("select", { value: setupDraft.gmKindness, onChange: (event) => setSetupDraft((current) => ({ ...current, gmKindness: event.target.value })), children: lobbyOptions?.options.gmKindness.map((entry) => _jsx("option", { value: entry.id, children: entry.label }, entry.id)) }), _jsx("p", { className: "formField-hint", children: "Influencia narra\u00E7\u00E3o, recompensas e o quanto o Mestre \"perdoa\" erros t\u00E1ticos." })] })] }), _jsx("div", { className: "lobbyCard-footer", children: _jsx("button", { type: "submit", className: "btn-lg btn-block", children: "Criar sess\u00E3o" }) })] })] }), _jsxs("section", { className: "lobbyCard", children: [_jsx("h2", { children: "Continuar uma sess\u00E3o" }), _jsx("p", { className: "lobbyCard-lead", children: "Use o c\u00F3digo de uma sala existente ou retome uma das sess\u00F5es salvas neste navegador." }), _jsxs("form", { onSubmit: loadRoomByCode, className: "stack", children: [_jsxs("div", { className: "formField", children: [_jsx("label", { htmlFor: "lobby-room-code", children: "C\u00F3digo da sess\u00E3o" }), _jsx("input", { id: "lobby-room-code", value: roomCode, placeholder: "Ex.: QUMRE8", style: { fontFamily: "ui-monospace, monospace", letterSpacing: "0.18em" }, onChange: (event) => setRoomCode(event.target.value.toUpperCase()) })] }), _jsx("button", { type: "submit", className: "btn-lg btn-block", children: "Carregar sala" })] }), _jsxs("div", { children: [_jsxs("div", { className: "savedList-header", children: [_jsxs("p", { className: "sectionLabel", children: ["Sess\u00F5es salvas ", rooms.length > 0 && _jsxs("span", { className: "faint", style: { marginLeft: "0.4rem" }, children: ["(", rooms.length, ")"] })] }), _jsx("button", { type: "button", className: "savedList-refresh", onClick: () => void refreshRooms(), children: "Atualizar" })] }), rooms.length === 0 ? (_jsxs("div", { className: "savedList-empty", children: ["Nenhuma sess\u00E3o local ainda.", _jsx("br", {}), "Crie uma nova ao lado ou carregue por c\u00F3digo."] })) : (_jsx("div", { className: "savedList savedList-scroll", children: rooms.map((entry) => {
                                            const systemLabel = entry.setup.systemId === "dnd5e-srd" ? "D&D 5e" : entry.setup.systemId;
                                            const playersCount = entry.players?.length ?? 0;
                                            return (_jsxs("div", { className: "savedItem", children: [_jsxs("button", { type: "button", className: "savedItem-main", onClick: () => {
                                                            setRoom(entry);
                                                            setRoomCode(entry.code);
                                                            socket.emit("room:subscribe", entry.id);
                                                            setStatus(`Sessão ${entry.name} aberta.`);
                                                        }, children: [_jsx("span", { className: "savedItem-name", children: entry.name }), _jsx("span", { className: "savedItem-code", children: entry.code }), _jsxs("span", { className: "savedItem-meta", children: [_jsx("span", { children: systemLabel }), _jsxs("span", { children: ["n\u00EDvel ", entry.setup.startingLevel] }), playersCount > 0 && _jsxs("span", { children: [playersCount, " jogador", playersCount > 1 ? "es" : ""] })] })] }), _jsx("button", { type: "button", className: "savedItem-delete", title: `Excluir sessão ${entry.name}`, "aria-label": `Excluir sessão ${entry.name}`, onClick: () => void deleteSavedRoom(entry), children: "\u00D7" })] }, entry.id));
                                        }) }))] })] })] })), room?.status === "lobby" && (_jsxs("section", { className: "lobbyStage", children: [_jsxs("section", { className: "lobbyCard stack", children: [_jsxs("h2", { children: ["Lobby \u2014 ", room.name] }), _jsxs("div", { className: "detailCard", children: [_jsxs("p", { children: [_jsx("strong", { children: "C\u00F3digo:" }), " ", room.code] }), _jsxs("p", { children: [_jsx("strong", { children: "Sistema:" }), " D&D 5e SRD \u00B7 N\u00EDvel ", room.setup.startingLevel] }), _jsxs("p", { children: [_jsx("strong", { children: "Dificuldade:" }), " ", room.setup.enemyDifficulty, " \u00B7 ", room.setup.battleIntensity, " \u00B7 mestre ", room.setup.gmKindness] }), _jsx("p", { className: "faint", children: "Todos os jogadores precisam marcar pronto antes do anfitri\u00E3o iniciar." })] }), suggestions !== null && isHost && (_jsxs("div", { className: "stack", children: [_jsx("p", { className: "sectionLabel", children: "Onde a primeira cena come\u00E7a?" }), _jsx("div", { style: { overflowY: "auto", maxHeight: "46vh", display: "flex", flexDirection: "column", gap: "0.4rem" }, children: suggestions.map((s, i) => (_jsxs("button", { type: "button", onClick: () => setSelectedSuggestion(s), style: { textAlign: "left", padding: "0.55rem 0.75rem", borderRadius: "6px", border: selectedSuggestion === s ? "2px solid var(--gold)" : "1px solid var(--border)", width: "100%" }, children: [_jsx("strong", { style: { fontSize: "0.95em" }, children: s.title }), _jsx("p", { style: { margin: "0.2rem 0 0", fontSize: "0.82em", opacity: 0.85, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }, children: s.hook }), _jsxs("p", { style: { margin: "0.15rem 0 0", fontSize: "0.7em", opacity: 0.55 }, children: ["Cena: ", s.sceneKeyword, " \u00B7 ", s.mood] })] }, i))) }), _jsxs("div", { className: "stepActions", children: [_jsx("button", { type: "button", className: "btn-quiet", onClick: () => { setSuggestions(null); setSelectedSuggestion(null); }, children: "\u2190 Voltar" }), _jsx("span", { className: "stepActions-spacer" }), _jsx("button", { type: "button", className: "btn-lg", disabled: selectedSuggestion === null, onClick: () => { if (selectedSuggestion)
                                                    void startSession(selectedSuggestion.hook, selectedSuggestion.sceneKeyword, selectedSuggestion.title); }, children: "Iniciar neste ponto" })] })] })), suggestions === null && localPlayer && (_jsxs("div", { className: "stack", children: [_jsxs("div", { className: "detailCard", children: [_jsx("strong", { children: localPlayer.characterName }), _jsxs("p", { children: [localPlayer.className, " n\u00EDvel ", localPlayer.level] })] }), _jsx("button", { type: "button", className: localPlayer.ready ? "btn-ghost btn-block" : "btn-block", onClick: () => void setReady(!localPlayer.ready), children: localPlayer.ready ? "Marcar não pronto" : "Estou pronto" }), isHost && (_jsx("button", { type: "button", className: "btn-lg btn-block", onClick: () => void fetchSuggestions(), disabled: !allReady || isFetchingSuggestions, children: isFetchingSuggestions ? "Consultando o Mestre..." : allReady ? "▶ Iniciar sessão" : "Aguardando todos ficarem prontos…" }))] })), suggestions === null && !localPlayer && (_jsxs("div", { className: "stack", children: [(() => {
                                        const hasSpells = (lobbyOptions?.options.classSpellChoices?.[characterDraft.className]?.count ?? 0) > 0;
                                        const totalSteps = hasSpells ? 7 : 6;
                                        const displayStep = charCreationStep <= 3 ? charCreationStep : (hasSpells ? charCreationStep : charCreationStep - 1);
                                        const stepNames = hasSpells
                                            ? ["Básico", "Atributos", "Perícias", "Magias", "Equipamento", "Retrato", "História"]
                                            : ["Básico", "Atributos", "Perícias", "Equipamento", "Retrato", "História"];
                                        const currentName = stepNames[displayStep - 1] ?? "";
                                        return (_jsxs("div", { children: [_jsxs("div", { className: "charStepper-label", children: [_jsxs("span", { children: ["Cria\u00E7\u00E3o de personagem \u2014 passo ", displayStep, " de ", totalSteps] }), _jsx("span", { className: "charStepper-title", children: currentName })] }), _jsx("div", { className: "charStepper", "aria-hidden": "true", children: Array.from({ length: totalSteps }, (_, i) => {
                                                        const stepNum = i + 1;
                                                        const cls = stepNum < displayStep ? "is-done" : stepNum === displayStep ? "is-active" : "";
                                                        return _jsx("span", { className: `charStepper-pill ${cls}` }, stepNum);
                                                    }) })] }));
                                    })(), charCreationStep === 1 && (_jsxs("div", { className: "stack", children: [_jsxs("div", { className: "formField", children: [_jsx("label", { children: "Nome do jogador" }), _jsx("input", { value: characterDraft.name, onChange: (event) => setCharacterDraft((current) => ({ ...current, name: event.target.value })) })] }), _jsxs("div", { className: "formField", children: [_jsx("label", { children: "Nome do personagem" }), _jsx("input", { value: characterDraft.characterName, onChange: (event) => setCharacterDraft((current) => ({ ...current, characterName: event.target.value })) })] }), _jsxs("div", { className: "formField", children: [_jsx("label", { children: "Classe" }), _jsx("select", { value: characterDraft.className, onChange: (event) => { setCharacterDraft((current) => ({ ...current, className: event.target.value, portraitUrl: "" })); setSkillDraft([]); setSpellDraft([]); setEquipChoiceIdx(0); }, children: lobbyOptions?.options.classes.map((entry) => _jsx("option", { value: entry, children: entry }, entry)) })] }), _jsxs("div", { className: "formField", children: [_jsx("label", { children: "Esp\u00E9cie" }), _jsx("select", { value: characterDraft.species, onChange: (event) => setCharacterDraft((current) => ({ ...current, species: event.target.value, portraitUrl: "" })), children: lobbyOptions?.options.species.map((entry) => _jsx("option", { value: entry, children: entry }, entry)) })] }), _jsxs("div", { className: "formField", children: [_jsx("label", { children: "Antecedente" }), _jsx("select", { value: characterDraft.background, onChange: (event) => setCharacterDraft((current) => ({ ...current, background: event.target.value })), children: lobbyOptions?.options.backgrounds.map((entry) => _jsx("option", { value: entry, children: entry }, entry)) })] }), _jsxs("div", { className: "formField", children: [_jsx("label", { children: "G\u00EAnero" }), _jsxs("div", { className: "genderPicker", children: [_jsx("button", { type: "button", className: `genderBtn${characterDraft.gender === "male" ? " genderBtn-active" : ""}`, onClick: () => setCharacterDraft((current) => ({ ...current, gender: "male", portraitUrl: "" })), children: "Masculino" }), _jsx("button", { type: "button", className: `genderBtn${characterDraft.gender === "female" ? " genderBtn-active" : ""}`, onClick: () => setCharacterDraft((current) => ({ ...current, gender: "female", portraitUrl: "" })), children: "Feminino" })] })] }), _jsxs("div", { className: "stepActions", children: [_jsx("span", { className: "stepActions-spacer" }), _jsx("button", { type: "button", disabled: !characterDraft.name.trim() || !characterDraft.characterName.trim(), onClick: () => setCharCreationStep(2), children: "Pr\u00F3ximo: Atributos \u2192" })] })] })), charCreationStep === 2 && (() => {
                                        const pointBuyCosts = lobbyOptions?.options.pointBuyCosts ?? { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
                                        const budget = 27;
                                        const spent = Object.values(attributeDraft).reduce((sum, v) => sum + (pointBuyCosts[v] ?? 0), 0);
                                        const remaining = budget - spent;
                                        const attrLabels = { strength: "Força", agility: "Agilidade", mind: "Mente", presence: "Presença", constitution: "Constituição", wisdom: "Sabedoria" };
                                        const attrKeys = ["strength", "agility", "mind", "presence", "constitution", "wisdom"];
                                        const canIncrease = (key) => {
                                            const cur = attributeDraft[key] ?? 8;
                                            if (cur >= 15)
                                                return false;
                                            const nextCost = (pointBuyCosts[cur + 1] ?? 999) - (pointBuyCosts[cur] ?? 0);
                                            return remaining >= nextCost;
                                        };
                                        return (_jsxs("div", { className: "stack", children: [_jsxs("p", { className: "faint", children: ["Distribua ", budget, " pontos entre os atributos. Restam: ", _jsx("strong", { children: remaining })] }), _jsx("div", { className: "attrGrid", children: attrKeys.map((key) => {
                                                        const val = attributeDraft[key] ?? 8;
                                                        const mod = Math.floor((val - 10) / 2);
                                                        return (_jsxs("div", { className: "attrRow", children: [_jsx("span", { className: "attrLabel", children: attrLabels[key] }), _jsx("button", { type: "button", className: "attrBtn", disabled: (attributeDraft[key] ?? 8) <= 8, onClick: () => setAttributeDraft((a) => ({ ...a, [key]: (a[key] ?? 8) - 1 })), children: "\u2212" }), _jsxs("span", { className: "attrVal", children: [val, " ", _jsxs("span", { className: "faint", children: ["(", mod >= 0 ? "+" : "", mod, ")"] })] }), _jsx("button", { type: "button", className: "attrBtn", disabled: !canIncrease(key), onClick: () => setAttributeDraft((a) => ({ ...a, [key]: (a[key] ?? 8) + 1 })), children: "+" }), _jsxs("span", { className: "faint attrCost", children: [pointBuyCosts[val] ?? 0, "pt"] })] }, key));
                                                    }) }), _jsxs("div", { className: "stepActions", children: [_jsx("button", { type: "button", className: "btn-quiet", onClick: () => setCharCreationStep(1), children: "\u2190 Voltar" }), _jsx("span", { className: "stepActions-spacer" }), _jsx("button", { type: "button", disabled: remaining !== 0, onClick: () => setCharCreationStep(3), children: "Pr\u00F3ximo: Per\u00EDcias \u2192" })] })] }));
                                    })(), charCreationStep === 3 && (() => {
                                        const classChoice = lobbyOptions?.options.classSkillChoices[characterDraft.className];
                                        const maxSkills = classChoice?.count ?? 2;
                                        const skillOptions = classChoice?.options ?? [];
                                        return (_jsxs("div", { className: "stack", children: [_jsxs("p", { className: "faint", children: ["Escolha ", _jsx("strong", { children: maxSkills }), " per\u00EDcias para ", characterDraft.className, ". (", skillDraft.length, "/", maxSkills, " selecionadas)"] }), _jsx("div", { className: "skillGrid", children: skillOptions.map((skill) => {
                                                        const selected = skillDraft.includes(skill);
                                                        const disabled = !selected && skillDraft.length >= maxSkills;
                                                        return (_jsx("button", { type: "button", className: `skillOption${selected ? " skillOption-selected" : ""}${disabled ? " skillOption-disabled" : ""}`, disabled: disabled, onClick: () => setSkillDraft((current) => current.includes(skill) ? current.filter((s) => s !== skill) : [...current, skill]), children: skill }, skill));
                                                    }) }), _jsxs("div", { className: "stepActions", children: [_jsx("button", { type: "button", className: "btn-quiet", onClick: () => setCharCreationStep(2), children: "\u2190 Voltar" }), _jsx("span", { className: "stepActions-spacer" }), _jsxs("button", { type: "button", disabled: skillDraft.length < maxSkills, onClick: () => {
                                                                const hasSpells = (lobbyOptions?.options.classSpellChoices?.[characterDraft.className]?.count ?? 0) > 0;
                                                                setCharCreationStep(hasSpells ? 4 : 5);
                                                            }, children: ["Pr\u00F3ximo: ", ((lobbyOptions?.options.classSpellChoices?.[characterDraft.className]?.count ?? 0) > 0) ? "Magias →" : "Equipamento →"] })] })] }));
                                    })(), charCreationStep === 4 && (() => {
                                        const spellData = lobbyOptions?.options.classSpellChoices?.[characterDraft.className];
                                        const maxSpells = spellData?.count ?? 0;
                                        const spellOptions = spellData?.options ?? [];
                                        return (_jsxs("div", { className: "stack", children: [_jsxs("p", { className: "faint", children: ["Escolha ", _jsx("strong", { children: maxSpells }), " magias iniciais para ", characterDraft.className, ". (", spellDraft.length, "/", maxSpells, " selecionadas)"] }), _jsx("div", { className: "skillGrid", children: spellOptions.map((spell) => {
                                                        const selected = spellDraft.includes(spell);
                                                        const disabled = !selected && spellDraft.length >= maxSpells;
                                                        return (_jsx("button", { type: "button", className: `skillOption${selected ? " skillOption-selected" : ""}${disabled ? " skillOption-disabled" : ""}`, disabled: disabled, onClick: () => setSpellDraft((current) => current.includes(spell) ? current.filter((s) => s !== spell) : [...current, spell]), children: spell }, spell));
                                                    }) }), _jsxs("div", { className: "stepActions", children: [_jsx("button", { type: "button", className: "btn-quiet", onClick: () => setCharCreationStep(3), children: "\u2190 Voltar" }), _jsx("span", { className: "stepActions-spacer" }), _jsx("button", { type: "button", disabled: spellDraft.length < maxSpells, onClick: () => setCharCreationStep(5), children: "Pr\u00F3ximo: Equipamento \u2192" })] })] }));
                                    })(), charCreationStep === 5 && (() => {
                                        const equipOptions = lobbyOptions?.options.classEquipmentChoices?.[characterDraft.className] ?? [];
                                        return (_jsxs("div", { className: "stack", children: [_jsxs("p", { className: "faint", children: ["Escolha seu equipamento inicial como ", characterDraft.className, "."] }), _jsx("div", { className: "equipGrid", children: equipOptions.map((option, index) => (_jsxs("button", { type: "button", className: `equipOption${equipChoiceIdx === index ? " equipOption-selected" : ""}`, onClick: () => setEquipChoiceIdx(index), children: [_jsx("strong", { children: option.label }), _jsxs("span", { className: "faint", style: { fontSize: "0.78rem" }, children: ["Equipado: ", option.equipped.join(", ")] }), _jsxs("span", { className: "faint", style: { fontSize: "0.72rem" }, children: ["Mochila: ", option.backpack.join(", ")] })] }, index))) }), _jsxs("div", { className: "stepActions", children: [_jsx("button", { type: "button", className: "btn-quiet", onClick: () => {
                                                                const hasSpells = (lobbyOptions?.options.classSpellChoices?.[characterDraft.className]?.count ?? 0) > 0;
                                                                setCharCreationStep(hasSpells ? 4 : 3);
                                                            }, children: "\u2190 Voltar" }), _jsx("span", { className: "stepActions-spacer" }), _jsx("button", { type: "button", onClick: () => setCharCreationStep(6), children: "Pr\u00F3ximo: Retrato \u2192" })] })] }));
                                    })(), charCreationStep === 6 && (() => {
                                        return (_jsxs("form", { onSubmit: joinRoom, className: "stack", children: [_jsxs("div", { className: "formField", children: [_jsx("label", { children: "Rosto e cabe\u00E7a" }), _jsx("textarea", { value: characterDraft.physicalDescription, onChange: (event) => setCharacterDraft((current) => ({ ...current, physicalDescription: event.target.value, portraitUrl: "" })), placeholder: "Ex: rosto quadrado, cabelo castanho curto, barba cheia, olhos verdes, cicatriz fina na sobrancelha", rows: 3 })] }), _jsxs("div", { className: "formField", children: [_jsx("label", { children: "Roupa ou armadura vis\u00EDvel" }), _jsx("textarea", { value: characterDraft.outfitDescription, onChange: (event) => setCharacterDraft((current) => ({ ...current, outfitDescription: event.target.value, portraitUrl: "" })), placeholder: "Ex: cota de malha com ombreiras gastas, couro escuro no peito, gola de tecido vermelho", rows: 2 })] }), _jsxs("div", { className: "formField", children: [_jsx("label", { children: "Retrato gerado" }), isGeneratingPortraitPreview ? (_jsx(LoadingArtCard, { title: "Gerando retrato", description: "O modelo local est\u00E1 pintando sua pr\u00E9via...", variant: "portrait" })) : characterDraft.portraitUrl ? (_jsx("div", { className: "portraitPicker", children: _jsxs("button", { type: "button", className: "portraitOption portraitOption-selected", onClick: () => setCharacterDraft((current) => ({ ...current, portraitUrl: "" })), children: [_jsx("img", { src: toAssetUrl(characterDraft.portraitUrl), alt: "Retrato gerado" }), _jsx("span", { className: "badge", style: { position: "absolute", top: 8, left: 8 }, children: "Selecionado" })] }) })) : (_jsx("p", { className: "faint", children: "Gere uma pr\u00E9via com os textos acima antes de entrar." })), _jsx("button", { type: "button", className: "btn-ghost", onClick: generatePortraitPreview, disabled: isGeneratingPortraitPreview, children: characterDraft.portraitUrl ? "Regenerar imagem" : "Gerar imagem" })] }), !characterDraft.portraitUrl && _jsx("p", { className: "faint", children: "Um retrato novo ser\u00E1 gerado automaticamente com as descri\u00E7\u00F5es acima ap\u00F3s entrar." }), _jsxs("div", { className: "stepActions", children: [_jsx("button", { type: "button", className: "btn-quiet", onClick: () => setCharCreationStep(5), children: "\u2190 Voltar" }), _jsx("span", { className: "stepActions-spacer" }), _jsx("button", { type: "button", onClick: () => setCharCreationStep(7), children: "Pr\u00F3ximo: Hist\u00F3ria \u2192" })] })] }));
                                    })(), charCreationStep === 7 && (_jsxs("form", { onSubmit: joinRoom, className: "stack", children: [_jsx("p", { className: "faint", children: "Crie muni\u00E7\u00E3o narrativa para o Mestre: de onde o personagem vem, o que ele quer e quais pessoas ou problemas ainda o puxam para a hist\u00F3ria." }), _jsxs("div", { className: "formField", children: [_jsx("label", { children: "Origem" }), _jsx("textarea", { value: characterDraft.origin, onChange: (event) => setCharacterDraft((current) => ({ ...current, origin: event.target.value })), placeholder: "Ex: nasceu entre estivadores, contrabandistas e velhas supersti\u00E7\u00F5es de uma cidade portu\u00E1ria.", rows: 2 })] }), _jsxs("div", { className: "formField", children: [_jsx("label", { children: "Motiva\u00E7\u00E3o" }), _jsx("textarea", { value: characterDraft.motivation, onChange: (event) => setCharacterDraft((current) => ({ ...current, motivation: event.target.value })), placeholder: "Ex: procura dinheiro, vingan\u00E7a, reden\u00E7\u00E3o, conhecimento, fama ou algu\u00E9m desaparecido.", rows: 2 })] }), _jsxs("div", { className: "formField", children: [_jsx("label", { children: "Ponto de virada" }), _jsx("textarea", { value: characterDraft.turningPoint, onChange: (event) => setCharacterDraft((current) => ({ ...current, turningPoint: event.target.value })), placeholder: "Ex: foi tra\u00EDdo, perdeu a casa, encontrou uma marca estranha ou foi acusado injustamente.", rows: 2 })] }), _jsxs("div", { className: "formField", children: [_jsx("label", { children: "Conex\u00F5es" }), _jsx("textarea", { value: characterDraft.connections, onChange: (event) => setCharacterDraft((current) => ({ ...current, connections: event.target.value })), placeholder: "Ex: um amigo em uma guilda, um rival, uma d\u00EDvida, um parente distante ou algu\u00E9m que evita encontrar.", rows: 2 })] }), _jsxs("div", { className: "formField", children: [_jsx("label", { children: "Resumo livre" }), _jsx("textarea", { value: characterDraft.backstory, onChange: (event) => setCharacterDraft((current) => ({ ...current, backstory: event.target.value })), placeholder: "Opcional: amarre os pontos acima em uma narrativa curta para o Mestre usar.", rows: 3 })] }), _jsxs("div", { className: "stepActions", children: [_jsx("button", { type: "button", className: "btn-quiet", onClick: () => setCharCreationStep(6), children: "\u2190 Voltar" }), _jsx("span", { className: "stepActions-spacer" }), _jsx("button", { type: "submit", className: "btn-lg", children: "Criar personagem e entrar" })] })] }))] }))] }), _jsxs("section", { className: "lobbyCard stack", children: [_jsx("h2", { children: "Jogadores na sala" }), _jsx("div", { className: "lobbyPlayerList", children: room.players.map((entry) => (_jsxs("div", { className: `lobbyPlayerCard${entry.id === playerId ? " lobbyPlayerCard-local" : ""}${entry.ready ? " lobbyPlayerCard-ready" : ""}`, children: [_jsxs("div", { style: { flex: 1 }, children: [_jsx("strong", { children: entry.characterName }), _jsxs("p", { className: "faint", children: [entry.className, " n\u00EDvel ", entry.level, " \u00B7 ", entry.species] })] }), entry.ready && _jsx("span", { className: "readyBadge", children: "Pronto" }), room.setup.hostPlayerId === entry.id && _jsx("span", { className: "badge", children: "Host" })] }, entry.id))) }), room.messages.length > 0 && (_jsx("div", { className: "msgFeed", style: { maxHeight: 200, marginTop: "0.5rem" }, children: room.messages.slice(-8).map((message) => _jsx(ChatCard, { message: message, jobs: jobsByMessage.get(message.id), audioClips: audioClips.filter((clip) => clip.messageId === message.id) }, message.id)) }))] })] })), room?.status === "preparing" && (_jsx(PreparationScreen, { roomName: room.name, step: preparationStep, progress: preparationProgress, players: room.players })), room?.status === "active" && (_jsxs("section", { className: "gameViewport", children: [_jsxs("aside", { className: "gamePane", children: [_jsxs("div", { className: "paneHead", children: [_jsx("h2", { children: room.name }), _jsx("span", { className: "badge", children: room.code })] }), _jsxs("div", { className: "paneScroll", children: [_jsx(PartySummary, { players: room.players, localPlayerId: playerId, room: room }), _jsx(CombatTracker, { combat: room.combat })] })] }), _jsxs("section", { className: "gamePane stagePane", children: [_jsxs("div", { className: "stageSplit", children: [_jsxs("div", { className: "storyFeed", children: [_jsx("div", { className: "storyFeedHead", children: _jsx("h2", { children: room.scene.title }) }), room.scene.pendingRollRequest && (_jsxs("div", { className: "rollRequestBanner", children: [_jsx("span", { className: "rollRequestIcon", children: "\uD83C\uDFB2" }), _jsxs("div", { className: "rollRequestBody", children: [_jsx("strong", { children: room.scene.pendingRollRequest.description }), _jsxs("span", { className: "faint", children: ["Role ", room.scene.pendingRollRequest.advantage ? `2${room.scene.pendingRollRequest.die}` : `${room.scene.pendingRollRequest.diceCount ?? room.scene.pendingRollRequest.damageDiceCount ?? 1}${room.scene.pendingRollRequest.die}`, room.scene.pendingRollRequest.modifier !== 0 ? ` ${room.scene.pendingRollRequest.modifier > 0 ? "+" : ""}${room.scene.pendingRollRequest.modifier}` : "", " ", "\u00B7 CD ", room.scene.pendingRollRequest.difficulty, " \u00B7 ", room.scene.pendingRollRequest.skill, room.scene.pendingRollRequest.advantage === "advantage" ? " · vantagem: use o maior d20" : "", room.scene.pendingRollRequest.advantage === "disadvantage" ? " · desvantagem: use o menor d20" : ""] })] })] })), _jsxs("div", { className: "prefixBar", children: [_jsx("button", { type: "button", onClick: () => insertChatPrefix("*"), children: "* A\u00E7\u00E3o" }), _jsx("button", { type: "button", onClick: () => insertChatPrefix("-"), children: "- Fala" }), _jsx("button", { type: "button", onClick: () => insertChatPrefix('"'), children: "\" Sussurro" }), _jsx("button", { type: "button", onClick: () => insertChatPrefix("("), children: "(?) Pergunta" })] }), _jsxs("div", { className: "msgFeed", children: [recentMessages.map((message) => _jsx(ChatCard, { message: message, jobs: jobsByMessage.get(message.id), audioClips: audioClips.filter((clip) => clip.messageId === message.id) }, message.id)), streamingEntries.map(([streamId, narration]) => (_jsx(StreamingGmCard, { narration: narration, audioClips: audioClips.filter((clip) => !clip.messageId && clip.streamId === streamId) }, streamId)))] })] }), _jsx("div", { className: "sceneRail", children: _jsx(SceneCard, { room: room }) })] }), _jsxs("form", { onSubmit: sendChat, className: "inputDock", children: [_jsx("div", { className: "inputDockHint", children: room.combat.active
                                            ? `Turno atual: ${currentTurn?.actorName ?? "desconhecido"}`
                                            : `Tipo detectado: ${messagePrefix[localInputKind]}` }), _jsx("textarea", { value: chatInput, onChange: (event) => setChatInput(event.target.value), rows: 3, placeholder: '*avanço com o escudo | - Segurem a linha! | "acho que há uma emboscada | (vejo símbolos nas ruínas?)' }), _jsxs("div", { className: "inputDockButtons", children: [_jsx("button", { type: "submit", disabled: !canSendChat || isSending, children: isSending ? "Enviando…" : "Enviar" }), isHost && (_jsx("button", { type: "button", className: "ghostButton", onClick: handleRegenerate, disabled: isRegenerating || isSending, title: "Descartar a \u00FAltima narra\u00E7\u00E3o do Mestre e gerar de novo (apenas host)", children: isRegenerating ? "Regenerando…" : "🔄 Regenerar narração" }))] })] })] }), _jsxs("aside", { className: `gamePane${activePanel === "sheet" ? " sheetPane" : ""}`, children: [_jsx("div", { className: "paneHead", children: _jsx("h2", { children: localPlayer?.characterName ?? "Mesa pessoal" }) }), _jsxs("div", { className: "paneScroll", children: [_jsxs("div", { className: "hostBlock", children: [_jsx("audio", { ref: audioElementRef, style: { display: "none" }, preload: "auto" }), _jsx("button", { type: "button", className: `ghostButton ghostButton-block${ttsEnabled ? " ghostButton-active" : ""}`, onClick: () => {
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
                                                }, title: "Liga/desliga a narra\u00E7\u00E3o falada pelo Mestre IA", children: ttsEnabled ? "🔊 Narração ativa" : "🔈 Ativar narração" }), isHost && (_jsxs("button", { type: "button", className: "ghostButton ghostButton-block", onClick: () => {
                                                    const next = !llmStatsOpen;
                                                    setLlmStatsOpen(next);
                                                    if (next)
                                                        void refreshLlmStats();
                                                }, children: [llmStatsOpen ? "▼" : "▶", " Estat\u00EDsticas do Mestre IA"] })), isHost && llmStatsOpen && (_jsx(LlmStatsPanel, { stats: llmStats, onRefresh: refreshLlmStats }))] }), localPlayer && (_jsxs("div", { className: "heroCard", children: [localPlayer.portraitAssetUrl
                                                ? _jsx("img", { className: "heroPortrait", src: toAssetUrl(localPlayer.portraitAssetUrl), alt: localPlayer.characterName })
                                                : findPendingPortraitJob(room, localPlayer)
                                                    ? _jsx(LoadingArtCard, { title: "", description: "Pintando retrato...", variant: "portrait" })
                                                    : _jsx("div", { className: "heroPortraitPlaceholder", children: _jsx("span", { className: "faint", children: "?" }) }), _jsxs("div", { className: "heroStats", children: [_jsx("strong", { children: localPlayer.characterName }), _jsxs("span", { className: "muted", children: [localPlayer.className, " n\u00EDvel ", localPlayer.level, " \u00B7 ", localPlayer.species] }), _jsx("span", { className: "muted", children: formatXpProgress(localPlayer) }), _jsxs("div", { className: "vitalRow", children: [_jsxs("span", { className: "vitalPill vitalPill-hp", children: [_jsxs("strong", { children: [localPlayer.hitPoints, "/", localPlayer.maxHitPoints] }), _jsx("span", { children: "HP" })] }), _jsxs("span", { className: "vitalPill vitalPill-ac", children: [_jsx("strong", { children: localPlayer.armorClass }), _jsx("span", { children: "AC" })] })] }), _jsx("button", { type: "button", className: "btn-ghost", onClick: regeneratePortrait, children: "Regenerar retrato" })] })] })), localPlayer && localPlayer.pendingLevelUps > 0 && (_jsx(LevelUpPanel, { player: localPlayer, classes: lobbyOptions?.options.classes ?? [], skillChoices: lobbyOptions?.options.classSkillChoices ?? {}, spellChoices: lobbyOptions?.options.classSpellChoices ?? {}, onApply: applyLevelUp })), localPlayer && (_jsxs("div", { className: "tabBar playerPanelTabs", children: [_jsx("button", { type: "button", className: activePanel === "sheet" ? "tabBar-active" : "", onClick: () => setActivePanel(activePanel === "sheet" ? null : "sheet"), children: "Ficha" }), _jsx("button", { type: "button", className: activePanel === "inventory" ? "tabBar-active" : "", onClick: () => setActivePanel(activePanel === "inventory" ? null : "inventory"), children: "Inv." }), _jsx("button", { type: "button", className: activePanel === "lore" ? "tabBar-active" : "", onClick: () => setActivePanel(activePanel === "lore" ? null : "lore"), children: "Lore" }), _jsx("button", { type: "button", className: activePanel === "notes" ? "tabBar-active" : "", onClick: () => setActivePanel(activePanel === "notes" ? null : "notes"), children: "Notas" })] })), localPlayer && _jsx(SuggestedActions, { player: localPlayer, room: room, onPick: chooseSuggestedAction }), localPlayer && (_jsxs(_Fragment, { children: [activePanel === "sheet" && _jsx(PaperSheetView, { player: localPlayer }), activePanel === "inventory" && _jsx(InventoryView, { player: localPlayer }), activePanel === "lore" && _jsx(PlayerLoreView, { player: localPlayer }), activePanel === "notes" && _jsx(NotesView, { notesDraft: notesDraft, setNotesDraft: setNotesDraft, onSave: saveNotes }), !activePanel && (_jsxs("div", { className: "detailCard", children: [_jsxs("p", { children: [_jsx("strong", { children: "Visual:" }), " ", localPlayer.physicalDescription] }), _jsxs("p", { children: [_jsx("strong", { children: "Arma:" }), " ", localPlayer.weaponDescription] }), _jsxs("p", { children: [_jsx("strong", { children: "Traje:" }), " ", localPlayer.outfitDescription] })] }))] })), _jsx(DiceTable, { diceCount: diceCount, diceSides: diceSides, diceModifier: diceModifier, diceRoll: diceRoll, setDiceCount: setDiceCount, setDiceSides: setDiceSides, setDiceModifier: setDiceModifier, onRoll: rollDice }), orphanImageJobs.length > 0 && (_jsx("div", { className: "galleryGrid", children: orphanImageJobs.map((job) => (_jsxs("div", { className: "galleryItem", children: [job.assetUrl && job.status === "done"
                                                    ? _jsx("img", { src: toAssetUrl(job.assetUrl), alt: job.profile })
                                                    : _jsx(LoadingArtCard, { title: "Gerando arte", description: "Aguarde a composi\u00E7\u00E3o final.", variant: "gallery" }), _jsx("span", { className: "badge", children: job.profile })] }, job.id))) }))] })] })] }))] }));
}
const PREPARATION_STEPS = [
    "O Mestre estuda o cenário e os seus segredos...",
    "O Mestre concebe inimigos, aliados e missões para a aventura...",
    "Registrando lore e memórias do mundo...",
    "O Mestre narra a cena de abertura...",
    "Pintando a cena de abertura...",
    "Tudo pronto! A aventura começa...",
];
function PreparationScreen({ roomName, step, progress, players }) {
    const currentIndex = PREPARATION_STEPS.indexOf(step);
    const clampedProgress = Math.min(100, Math.max(0, progress));
    return (_jsx("section", { className: "preparationScreen", children: _jsxs("div", { className: "preparationCard", children: [_jsx("p", { className: "eyebrow", children: "Preparando a sess\u00E3o" }), _jsx("h2", { className: "preparationTitle", children: roomName }), _jsxs("div", { className: "preparationOrb", "aria-hidden": "true", children: [_jsx("span", { className: "preparationOrbRing" }), _jsx("span", { className: "preparationOrbCore" })] }), _jsxs("div", { className: "preparationProgressBar", role: "progressbar", "aria-valuenow": clampedProgress, "aria-valuemin": 0, "aria-valuemax": 100, children: [_jsx("div", { className: "preparationProgressFill", style: { width: `${clampedProgress}%` } }), _jsxs("span", { className: "preparationProgressLabel", children: [clampedProgress, "%"] })] }), _jsx("div", { className: "preparationSteps", children: PREPARATION_STEPS.map((label, index) => {
                        const isDone = index < currentIndex;
                        const isActive = index === currentIndex;
                        return (_jsxs("div", { className: `preparationStep${isDone ? " preparationStep-done" : ""}${isActive ? " preparationStep-active" : ""}`, children: [_jsx("span", { className: "preparationStepDot" }), _jsx("span", { className: "preparationStepLabel", children: label })] }, label));
                    }) }), players.length > 0 && (_jsx("div", { className: "preparationParty", children: players.map((p) => (_jsxs("span", { className: "preparationPartyMember", children: [p.portraitAssetUrl
                                ? _jsx("img", { src: p.portraitAssetUrl.startsWith("http") ? p.portraitAssetUrl : `${(import.meta.env.VITE_API_BASE_URL ?? "").trim() || (import.meta.env.DEV ? "http://127.0.0.1:8787" : window.location.origin)}${p.portraitAssetUrl}`, alt: p.characterName })
                                : _jsx("span", { className: "preparationPartyAvatar", children: p.characterName[0] }), _jsx("span", { children: p.characterName })] }, p.id))) }))] }) }));
}
function SceneCard({ room }) {
    const sceneImage = room.imageJobs.find((job) => job.profile === "scene" && job.status === "done" && job.assetUrl);
    const pendingScene = room.imageJobs.some((job) => job.profile === "scene" && job.status === "queued");
    return (_jsxs("div", { className: "stack", children: [_jsx("p", { className: "sectionLabel", children: "Panorama" }), sceneImage?.assetUrl
                ? (_jsxs("div", { className: "sceneImageFrame", children: [_jsx("img", { className: "sceneImg", src: toAssetUrl(sceneImage.assetUrl), alt: room.scene.title }), pendingScene && (_jsxs("div", { className: "imageGenerationOverlay", children: [_jsx("div", { className: "loadingDot", "aria-hidden": "true" }), _jsx("span", { children: "Nova imagem sendo gerada" })] }))] }))
                : pendingScene
                    ? _jsx(LoadingArtCard, { title: "Imagem em gera\u00E7\u00E3o", description: "O modelo local come\u00E7ou a pintar este cen\u00E1rio.", variant: "scene" })
                    : null, room.scene.summary && (_jsxs("div", { className: "sceneInfo", children: [_jsx("strong", { children: room.scene.title }), _jsx("p", { children: room.scene.summary })] }))] }));
}
function PartySummary({ players, localPlayerId, room }) {
    const sceneNpcs = room.scene.activeNpcs ?? [];
    const activeNpcs = sceneNpcs.filter((npc) => npc.relation === "companion");
    const nearbyNpcs = sceneNpcs.filter((npc) => npc.relation !== "companion");
    return (_jsxs("div", { className: "partyBlock", children: [_jsx("p", { className: "sectionLabel", children: "Grupo" }), players.map((entry) => {
                const hpPct = entry.maxHitPoints > 0 ? Math.max(0, Math.min(100, (entry.hitPoints / entry.maxHitPoints) * 100)) : 0;
                return (_jsxs("article", { className: `partyMember${entry.id === localPlayerId ? " partyMember-self" : ""}`, children: [entry.portraitAssetUrl
                            ? _jsx("img", { className: "partyThumb", src: toAssetUrl(entry.portraitAssetUrl), alt: entry.characterName })
                            : room.imageJobs.some((j) => j.profile === "portrait" && j.status === "queued" && j.subjectName === entry.characterName)
                                ? _jsx("div", { className: "partyThumbPlaceholder", children: _jsx("div", { className: "loadingDot" }) })
                                : _jsx("div", { className: "partyThumbPlaceholder", children: _jsx("span", { className: "faint", children: "?" }) }), _jsxs("div", { className: "partyInfo", children: [_jsx("strong", { children: entry.characterName }), _jsxs("span", { className: "muted", children: [entry.className, " ", entry.level] }), _jsx("div", { className: "hpBar", children: _jsx("div", { className: "hpBar-fill", style: { width: `${hpPct}%` } }) }), _jsxs("span", { className: "faint", children: ["HP ", entry.hitPoints, "/", entry.maxHitPoints, " \u00B7 AC ", entry.armorClass] })] })] }, entry.id));
            }), activeNpcs.map((npc) => {
                const npcJob = room.imageJobs.find((j) => (j.profile === "npc" || j.profile === "portrait") && j.subjectName === npc.name);
                const portraitUrl = npc.portraitAssetUrl ?? (npcJob?.status === "done" ? npcJob.assetUrl : undefined);
                const isPending = !portraitUrl && npcJob?.status === "queued";
                const isUnconscious = npc.status === "unconscious";
                const isDead = npc.status === "dead";
                const statusLabel = isDead ? "morto" : isUnconscious ? "inconsciente" : null;
                return (_jsxs("article", { className: `partyMember partyMember-npc${isUnconscious ? " partyMember-unconscious" : ""}${isDead ? " partyMember-dead" : ""}`, children: [portraitUrl
                            ? _jsx("img", { className: "partyThumb", src: toAssetUrl(portraitUrl), alt: npc.name, style: isUnconscious || isDead ? { filter: "grayscale(0.8) opacity(0.6)" } : undefined })
                            : isPending
                                ? _jsx("div", { className: "partyThumbPlaceholder", children: _jsx("div", { className: "loadingDot" }) })
                                : _jsx("div", { className: "partyThumbPlaceholder", children: _jsx("span", { className: "faint", children: "N" }) }), _jsxs("div", { className: "partyInfo", children: [_jsxs("strong", { children: [npc.name, " ", _jsx("span", { className: "badge", style: { fontSize: "0.65rem" }, children: "NPC" }), statusLabel && _jsx("span", { className: "badge", style: { fontSize: "0.62rem", background: isDead ? "rgba(120,30,30,0.5)" : "rgba(80,80,80,0.5)", marginLeft: "0.25rem" }, children: statusLabel })] }), _jsxs("span", { className: "muted", children: [npc.className ?? npc.role, npc.level ? ` ${npc.level}` : "", npc.race ? ` · ${npc.race}` : ""] }), npc.maxHitPoints !== undefined && npc.hitPoints !== undefined && (_jsxs(_Fragment, { children: [_jsx("div", { className: "hpBar", children: _jsx("div", { className: "hpBar-fill", style: { width: `${Math.max(0, Math.min(100, (npc.hitPoints / npc.maxHitPoints) * 100))}%` } }) }), _jsxs("span", { className: "faint", children: ["HP ", npc.hitPoints, "/", npc.maxHitPoints, npc.armorClass !== undefined ? ` · AC ${npc.armorClass}` : ""] })] }))] })] }, npc.name));
            }), nearbyNpcs.length > 0 && (_jsxs(_Fragment, { children: [_jsx("p", { className: "sectionLabel", children: "NPCs na cena" }), nearbyNpcs.map((npc) => {
                        const npcJob = room.imageJobs.find((j) => (j.profile === "npc" || j.profile === "portrait") && j.subjectName === npc.name);
                        const portraitUrl = npc.portraitAssetUrl ?? (npcJob?.status === "done" ? npcJob.assetUrl : undefined);
                        const isPending = !portraitUrl && npcJob?.status === "queued";
                        return (_jsxs("article", { className: "partyMember partyMember-npc", children: [portraitUrl
                                    ? _jsx("img", { className: "partyThumb", src: toAssetUrl(portraitUrl), alt: npc.name })
                                    : isPending
                                        ? _jsx("div", { className: "partyThumbPlaceholder", children: _jsx("div", { className: "loadingDot" }) })
                                        : _jsx("div", { className: "partyThumbPlaceholder", children: _jsx("span", { className: "faint", children: "N" }) }), _jsxs("div", { className: "partyInfo", children: [_jsxs("strong", { children: [npc.name, " ", _jsx("span", { className: "badge", style: { fontSize: "0.65rem" }, children: "Cena" })] }), _jsx("span", { className: "muted", children: npc.className ?? npc.role }), _jsx("span", { className: "faint", children: "Presente na cena. Ainda n\u00E3o faz parte do grupo." })] })] }, npc.name));
                    })] }))] }));
}
function LlmStatsPanel({ stats, onRefresh }) {
    if (!stats) {
        return _jsx("p", { className: "faint", children: "Carregando estat\u00EDsticas\u2026" });
    }
    const labels = Object.entries(stats.stats.byLabel).sort((a, b) => b[1].count - a[1].count);
    return (_jsxs("div", { className: "llmStatsPanel", children: [_jsxs("div", { className: "llmStatsHeader", children: [_jsx("span", { className: "sectionLabel", children: "Lat\u00EAncia e fallbacks por chamada" }), _jsx("button", { type: "button", className: "ghostButton ghostButton-tiny", onClick: onRefresh, children: "\u21BB Atualizar" })] }), labels.length === 0
                ? _jsx("p", { className: "faint", children: "Sem chamadas registradas ainda." })
                : (_jsxs("table", { className: "llmStatsTable", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Label" }), _jsx("th", { children: "#" }), _jsx("th", { children: "Lat\u00EAncia (ms)" }), _jsx("th", { children: "Falha" }), _jsx("th", { children: "Fallback" })] }) }), _jsx("tbody", { children: labels.map(([label, agg]) => (_jsxs("tr", { children: [_jsx("td", { children: label }), _jsx("td", { children: agg.count }), _jsx("td", { children: agg.avgLatency }), _jsxs("td", { className: agg.failureRate > 0.1 ? "warn" : "", children: [(agg.failureRate * 100).toFixed(1), "%"] }), _jsxs("td", { className: agg.fallbackRate > 0.1 ? "warn" : "", children: [(agg.fallbackRate * 100).toFixed(1), "%"] })] }, label))) })] })), _jsxs("details", { className: "llmRecent", children: [_jsxs("summary", { children: ["\u00DAltimas ", stats.recent.length, " chamadas"] }), _jsx("ul", { children: stats.recent.slice(0, 12).map((call) => (_jsxs("li", { className: call.ok ? "" : "warn", children: [_jsx("span", { className: "muted", children: new Date(call.createdAt).toLocaleTimeString() }), " ", _jsx("strong", { children: call.label }), " \u00B7 ", call.model, " \u00B7 ", call.latencyMs, "ms", !call.ok && call.error ? ` · ${call.error}` : ""] }, call.id))) })] })] }));
}
function CombatTracker({ combat }) {
    if (!combat.active) {
        return (_jsxs("div", { className: "combatBlock", children: [_jsx("p", { className: "sectionLabel", children: "Iniciativa" }), _jsx("p", { className: "faint", children: "Sem combate ativo." })] }));
    }
    return (_jsxs("div", { className: "combatBlock", children: [_jsxs("p", { className: "sectionLabel", children: ["Iniciativa \u2014 Rodada ", combat.round] }), combat.enemies.length > 0 && (_jsx("div", { className: "enemyList", children: combat.enemies.map((enemy) => (_jsxs("div", { className: `enemySummary${enemy.hitPoints <= 0 ? " enemyDown" : ""}`, children: [_jsxs("p", { className: "muted", children: [enemy.name, " \u00B7 CA ", enemy.armorClass, " \u00B7 ", enemy.hitPoints, "/", enemy.maxHitPoints, " HP \u00B7 ", enemy.xpValue, " XP", enemy.challengeRating ? ` · CR ${enemy.challengeRating}` : "", enemy.hitPoints <= 0 ? " · derrotado" : ""] }), enemy.traits?.length ? _jsx("p", { className: "faint", children: enemy.traits.slice(0, 2).join(" · ") }) : null] }, enemy.id))) })), combat.order.map((entry, index) => (_jsxs("div", { className: `initiativeRow${index === combat.currentTurnIndex ? " initiativeRow-active" : ""}`, children: [_jsx("strong", { children: entry.actorName }), _jsxs("span", { className: "initiativeSide", children: [entry.side, " \u00B7 ", entry.initiative] })] }, entry.id))), combat.lastOutcome && _jsx("p", { className: "faint", children: combat.lastOutcome })] }));
}
function CampaignMemoryPanel({ summary, entries }) {
    return (_jsxs("div", { className: "memoryBlock", children: [_jsx("p", { className: "sectionLabel", children: "Canon da campanha" }), summary && _jsx("p", { className: "muted", style: { fontSize: "0.82rem" }, children: summary }), entries.map((entry) => (_jsxs("div", { className: "memoryEntry", children: [_jsx("strong", { children: entry.title }), _jsx("p", { children: entry.content })] }, entry.id))), entries.length === 0 && _jsx("p", { className: "faint", children: "Nenhuma mem\u00F3ria registrada ainda." })] }));
}
function DiceTable({ diceCount, diceSides, diceModifier, diceRoll, setDiceCount, setDiceSides, setDiceModifier, onRoll, }) {
    return (_jsxs("section", { className: "diceSection", children: [_jsx("p", { className: "sectionLabel", children: "Mesa de dados" }), _jsxs("div", { className: "diceControls", children: [_jsxs("label", { children: ["Qtd", _jsx("input", { type: "number", min: 1, max: 6, value: diceCount, onChange: (event) => setDiceCount(Math.max(1, Math.min(6, Number(event.target.value) || 1))) })] }), _jsxs("label", { children: ["Dado", _jsx("select", { value: diceSides, onChange: (event) => setDiceSides(Number(event.target.value)), children: commonDice.map((entry) => _jsxs("option", { value: entry, children: ["d", entry] }, entry)) })] }), _jsxs("label", { children: ["Mod", _jsx("input", { type: "number", min: -10, max: 20, value: diceModifier, onChange: (event) => setDiceModifier(Number(event.target.value) || 0) })] })] }), _jsxs("button", { type: "button", className: "diceRollBtn", onClick: onRoll, disabled: diceRoll.status === "rolling", children: ["Rolar ", diceCount, "d", diceSides] }), diceRoll.dice.length > 0 && (_jsx("div", { className: "dicePool", children: diceRoll.dice.map((die) => (_jsxs("div", { className: `dieFace${diceRoll.status === "rolling" ? " dieFace-rolling" : ""}`, children: [_jsxs("span", { children: ["d", die.sides] }), _jsx("strong", { children: diceRoll.status === "rolling" ? "?" : die.value })] }, die.id))) })), diceRoll.status !== "idle" && (_jsx("p", { className: "diceResult", children: diceRoll.status === "revealed"
                    ? `Total: ${diceRoll.total}${diceModifier !== 0 ? ` (mod ${diceModifier > 0 ? "+" : ""}${diceModifier})` : ""}`
                    : diceRoll.label }))] }));
}
function ChatCard({ message, jobs, audioClips = [] }) {
    const hasImages = jobs && jobs.length > 0;
    return (_jsxs("article", { className: `msg msg-${message.role}`, children: [_jsxs("div", { className: "msgHeader", children: [_jsx("strong", { children: message.authorName }), _jsx("span", { className: "msgKind", children: messagePrefix[message.kind] })] }), _jsx("p", { children: message.content }), audioClips.length > 0 && _jsx(NarrationAudioList, { clips: audioClips }), hasImages && (_jsx("div", { className: "inlineMsgImages", children: jobs.map((job) => (job.assetUrl && job.status === "done"
                    ? _jsx("img", { src: toAssetUrl(job.assetUrl), alt: job.profile, className: "inlineMsgImg" }, job.id)
                    : _jsx("div", { className: "inlineMsgImgPlaceholder", children: _jsx(LoadingArtCard, { title: "Imagem em gera\u00E7\u00E3o", description: imageJobLoadingText(job), variant: "gallery" }) }, job.id))) }))] }));
}
function NarrationAudioList({ clips }) {
    const ordered = [...clips].sort((a, b) => a.sequence - b.sequence);
    return (_jsx("div", { className: "narrationAudioList", children: ordered.map((clip) => (_jsxs("div", { className: "narrationAudioBubble", children: [_jsxs("span", { className: "narrationAudioMeta", children: [clip.speaker, " \u00B7 ", Math.max(1, Math.round(clip.durationMs / 1000)), "s \u00B7 expira em 2 min"] }), _jsx("audio", { controls: true, preload: "none", src: `${apiBaseUrl}${clip.audioUrl}` })] }, clip.audioId))) }));
}
function imageJobLoadingText(job) {
    if (job.profile === "scene")
        return "O cenário entrou na fila do modelo local.";
    if (job.profile === "creature")
        return "O token do inimigo entrou na fila.";
    if (job.profile === "portrait" || job.profile === "npc")
        return "O token do personagem entrou na fila.";
    if (job.profile === "item")
        return "O item entrou na fila de arte.";
    return "A arte entrou na fila.";
}
function StreamingGmCard({ narration, audioClips = [] }) {
    return (_jsxs("article", { className: "msg msg-gm msg-streaming", children: [_jsxs("div", { className: "msgHeader", children: [_jsx("strong", { children: "Game Master" }), _jsx("span", { className: "msgKind", children: "Mestre" })] }), _jsxs("p", { children: [narration || "O Mestre está narrando...", _jsx("span", { className: "streamCursor", "aria-hidden": "true" })] }), audioClips.length > 0 && _jsx(NarrationAudioList, { clips: audioClips })] }));
}
const ATTR_LABELS = {
    strength: "Força", agility: "Agilidade", mind: "Mente",
    presence: "Presença", constitution: "Constituição", wisdom: "Sabedoria",
};
const ATTR_DESCRIPTIONS = {
    strength: "Força física. Role 1d20 + mod. de Força para escalar, empurrar, quebrar objetos e ataques corpo-a-corpo.",
    agility: "Destreza e velocidade. Role 1d20 + mod. de Agilidade para furtividade, acrobacia, ataques à distância e CA sem armadura.",
    mind: "Inteligência. Role 1d20 + mod. de Mente para investigação, arcanismo, história e magias de Mago.",
    presence: "Presença/Carisma. Role 1d20 + mod. de Presença para persuasão, enganação, intimidação e magias de Bardo/Paladino.",
    constitution: "Resistência física. Afeta HP máximo (dado de vida + modificador por nível) e manutenção de concentração em magias.",
    wisdom: "Sabedoria e percepção. Role 1d20 + mod. de Sabedoria para percepção, medicina, intuição e magias de Clérigo/Druida.",
};
const SKILL_DESCRIPTIONS = {
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
const FEATURE_DESCRIPTIONS = {
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
const SPELL_DESCRIPTIONS = {
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
function Tip({ text, children }) {
    return (_jsxs("span", { className: "tipWrap", children: [children, _jsx("span", { className: "tipBox", children: text })] }));
}
function SheetView({ player }) {
    const attrKeys = ["strength", "agility", "mind", "presence", "constitution", "wisdom"];
    return (_jsxs("div", { className: "detailCard stack", children: [_jsxs("p", { className: "sectionLabel", children: ["Ficha \u00B7 ", player.characterName] }), _jsxs("p", { className: "faint", children: [player.className, " N\u00EDvel ", player.level, " \u00B7 HP ", player.hitPoints, "/", player.maxHitPoints, " \u00B7 AC ", player.armorClass, " \u00B7 Prof +", player.proficiencyBonus] }), Object.keys(player.attributes).length > 0 && (_jsxs(_Fragment, { children: [_jsx("p", { className: "sectionLabel", style: { marginTop: "0.3rem" }, children: "Atributos" }), _jsx("div", { className: "statsGrid", children: attrKeys.filter((k) => player.attributes[k] !== undefined).map((key) => {
                            const val = player.attributes[key] ?? 10;
                            const mod = Math.floor((val - 10) / 2);
                            return (_jsx(Tip, { text: ATTR_DESCRIPTIONS[key] ?? key, children: _jsxs("div", { className: "statCell", style: { width: "100%" }, children: [_jsx("span", { children: ATTR_LABELS[key] ?? key }), _jsx("strong", { children: val }), _jsxs("span", { style: { fontSize: "0.7rem", color: "var(--gold)" }, children: [mod >= 0 ? "+" : "", mod] })] }) }, key));
                        }) })] })), Object.keys(player.skills).length > 0 && (_jsxs(_Fragment, { children: [_jsx("p", { className: "sectionLabel", style: { marginTop: "0.3rem" }, children: "Per\u00EDcias" }), _jsx("div", { className: "skillList", children: Object.entries(player.skills).map(([skill, bonus]) => (_jsx(Tip, { text: SKILL_DESCRIPTIONS[skill] ?? `${skill}: bônus +${bonus}`, children: _jsxs("div", { className: "skillRow", style: { width: "100%" }, children: [_jsx("span", { className: "skillRow-name", children: skill.charAt(0).toUpperCase() + skill.slice(1) }), _jsxs("span", { className: "skillRow-val", children: [bonus >= 0 ? "+" : "", bonus] })] }) }, skill))) })] })), player.features.length > 0 && (_jsxs(_Fragment, { children: [_jsx("p", { className: "sectionLabel", style: { marginTop: "0.3rem" }, children: "Caracter\u00EDsticas" }), _jsx("div", { className: "featureList", children: player.features.map((entry) => (_jsx(Tip, { text: FEATURE_DESCRIPTIONS[entry] ?? `Característica de classe: ${entry}`, children: _jsx("div", { className: "featureItem", style: { width: "100%", cursor: "help" }, children: entry }) }, entry))) })] })), player.spells.length > 0 && (_jsxs(_Fragment, { children: [_jsx("p", { className: "sectionLabel", style: { marginTop: "0.3rem" }, children: "Magias" }), _jsx("div", { className: "featureList", children: player.spells.map((entry) => (_jsx(Tip, { text: SPELL_DESCRIPTIONS[entry] ?? `Magia: ${entry}`, children: _jsx("div", { className: "featureItem", style: { width: "100%", cursor: "help" }, children: entry }) }, entry))) })] }))] }));
}
const levelXpFloor = (level) => {
    const table = {
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
const formatXpProgress = (player) => {
    const current = player.experiencePoints ?? levelXpFloor(player.level);
    if (!player.nextLevelExperience)
        return `${current} XP`;
    return `${current}/${player.nextLevelExperience} XP`;
};
const formatClassLevels = (player) => Object.entries(player.classLevels ?? { [player.className]: player.level })
    .filter(([, level]) => level > 0)
    .map(([className, level]) => `${className} ${level}`)
    .join(" / ");
const speciesAbilityBonuses = {
    Human: { strength: 1, agility: 1, mind: 1, presence: 1, constitution: 1, wisdom: 1 },
    Elf: { agility: 2, mind: 1 },
    Dwarf: { constitution: 2, wisdom: 1 },
    Halfling: { agility: 2, presence: 1 },
};
const abilityModifier = (value) => Math.floor((value - 10) / 2);
const buildAttributeBreakdown = (player, key) => {
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
const armorClassBreakdown = (player) => {
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
    }
    else if (/chain mail|cota de malha/.test(equipped)) {
        armorName = "Chain Mail / Cota de malha";
        base = 16;
        dexApplied = 0;
        capText = "armadura pesada: não soma Agilidade";
    }
    else if (/scale mail|cota de escamas/.test(equipped)) {
        armorName = "Scale Mail / Cota de escamas";
        base = 14;
        dexApplied = Math.min(agilityMod, 2);
        capText = "armadura média: Agilidade máx. +2";
    }
    else if (/chain shirt|camisola de cota/.test(equipped)) {
        armorName = "Chain Shirt / Camisola de cota";
        base = 13;
        dexApplied = Math.min(agilityMod, 2);
        capText = "armadura média: Agilidade máx. +2";
    }
    else if (/studded leather|couro cravejado/.test(equipped)) {
        armorName = "Studded Leather / Couro cravejado";
        base = 12;
    }
    else if (/leather armor|armadura de couro|\bcouro\b/.test(equipped)) {
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
const hitPointBreakdown = (player) => {
    const constitutionMod = abilityModifier(player.attributes.constitution ?? 10);
    return [
        `HP atual: ${player.hitPoints}/${player.maxHitPoints}.`,
        `Constituição ${player.attributes.constitution ?? 10}: modificador ${constitutionMod >= 0 ? "+" : ""}${constitutionMod}.`,
        "No nível 1, D&D usa o dado de vida cheio da classe + modificador de Constituição. Em níveis seguintes, o sistema soma o ganho de HP da classe escolhida no level up.",
    ].join(" ");
};
const xpProgressPercent = (player) => {
    const current = player.experiencePoints ?? levelXpFloor(player.level);
    const next = player.nextLevelExperience;
    if (!next)
        return 100;
    const floor = levelXpFloor(player.level);
    return Math.max(0, Math.min(100, ((current - floor) / Math.max(1, next - floor)) * 100));
};
function LevelUpPanel({ player, classes, skillChoices, spellChoices, onApply, }) {
    const currentClasses = Object.keys(player.classLevels ?? {});
    const availableClasses = classes.filter((className) => currentClasses.includes(className) || currentClasses.length < 2);
    const [selectedClass, setSelectedClass] = useState(availableClasses[0] ?? player.className);
    const [selectedSkills, setSelectedSkills] = useState([]);
    const [selectedSpells, setSelectedSpells] = useState([]);
    const classLevel = (player.classLevels?.[selectedClass] ?? 0) + 1;
    const skillLimit = player.classLevels?.[selectedClass] ? 1 : Math.min(2, skillChoices[selectedClass]?.count ?? 0);
    const spellLimit = (spellChoices[selectedClass]?.count ?? 0) > 0 ? (classLevel === 1 ? spellChoices[selectedClass].count : 2) : 0;
    const skillOptions = (skillChoices[selectedClass]?.options ?? []).filter((skill) => player.skills[skill.toLowerCase()] === undefined);
    const spellOptions = (spellChoices[selectedClass]?.options ?? []).filter((spell) => !player.spells.includes(spell));
    const toggle = (value, selected, setSelected, limit) => {
        if (selected.includes(value)) {
            setSelected(selected.filter((entry) => entry !== value));
            return;
        }
        if (selected.length < limit)
            setSelected([...selected, value]);
    };
    return (_jsxs("div", { className: "detailCard stack", children: [_jsx("p", { className: "sectionLabel", children: "Nivel disponivel" }), _jsxs("p", { className: "faint", children: [player.characterName, " tem ", player.pendingLevelUps, " nivel(is) para aplicar. Multiclasse limitada a 2 classes."] }), _jsx("div", { className: "featureList", children: availableClasses.map((className) => (_jsxs("button", { type: "button", className: className === selectedClass ? "btn-primary" : "btn-ghost", onClick: () => {
                        setSelectedClass(className);
                        setSelectedSkills([]);
                        setSelectedSpells([]);
                    }, children: ["Subir ", className, " para nivel ", (player.classLevels?.[className] ?? 0) + 1] }, className))) }), skillLimit > 0 && skillOptions.length > 0 && (_jsxs(_Fragment, { children: [_jsxs("p", { className: "sectionLabel", children: ["Pericias novas (", selectedSkills.length, "/", skillLimit, ")"] }), _jsx("div", { className: "choiceGrid", children: skillOptions.map((skill) => (_jsx("button", { type: "button", className: selectedSkills.includes(skill) ? "choicePill choicePill-active" : "choicePill", onClick: () => toggle(skill, selectedSkills, setSelectedSkills, skillLimit), children: skill }, skill))) })] })), spellLimit > 0 && spellOptions.length > 0 && (_jsxs(_Fragment, { children: [_jsxs("p", { className: "sectionLabel", children: ["Magias novas (", selectedSpells.length, "/", spellLimit, ")"] }), _jsx("div", { className: "choiceGrid", children: spellOptions.map((spell) => (_jsx("button", { type: "button", className: selectedSpells.includes(spell) ? "choicePill choicePill-active" : "choicePill", onClick: () => toggle(spell, selectedSpells, setSelectedSpells, spellLimit), children: spell }, spell))) })] })), _jsxs("button", { type: "button", className: "btn-primary", onClick: () => onApply(selectedClass, { newSkillProficiencies: selectedSkills, newSpells: selectedSpells }), children: ["Confirmar level up em ", selectedClass] })] }));
}
const inventoryItems = (player) => [...player.inventory.equipped, ...player.inventory.backpack];
const playerHasItem = (player, matcher) => inventoryItems(player).some((item) => matcher.test(item));
const firstMatchingItem = (player, matcher) => inventoryItems(player).find((item) => matcher.test(item)) ?? null;
function buildSuggestedActions(player, room) {
    const actions = [];
    const weapon = firstMatchingItem(player, /sword|axe|bow|rapier|dagger|staff|mace|warhammer|espada|machado|arco|adaga/i);
    const secondWind = player.resources?.limited?.second_wind;
    const actionSurge = player.resources?.limited?.action_surge;
    if (room.combat.active) {
        if (weapon)
            actions.push({ label: `Atacar com ${weapon}`, content: `*ataco com ${weapon} mirando o inimigo mais ameaçador`, hint: getEquipmentInfo(weapon).summary });
        if (playerHasItem(player, /shield|escudo/i))
            actions.push({ label: "Postura defensiva", content: "*levanto o escudo e assumo uma postura defensiva, protegendo meu espaço", hint: "Usa escudo/cobertura e deixa a intenção clara ao Mestre." });
        if (secondWind && secondWind.used < secondWind.max)
            actions.push({ label: "Usar Second Wind", content: "*uso Second Wind para recuperar o fôlego em meio ao combate", hint: `${secondWind.max - secondWind.used}/${secondWind.max} uso(s) restante(s).` });
        if (actionSurge && actionSurge.used < actionSurge.max)
            actions.push({ label: "Usar Action Surge", content: "*uso Action Surge para criar uma abertura tática imediata", hint: `${actionSurge.max - actionSurge.used}/${actionSurge.max} uso(s) restante(s).` });
        actions.push({ label: "Ajudar aliado", content: "*ajudo o aliado mais próximo a ganhar vantagem na próxima ação", hint: "Boa opção quando atacar não é a melhor escolha." });
    }
    else {
        actions.push({ label: "Observar cena", content: "*observo o ambiente com calma procurando ameaças, pistas e rotas seguras", hint: "Costuma pedir Percepção/Investigação se houver risco." });
        if (weapon)
            actions.push({ label: "Preparar arma", content: `*mantenho ${weapon} pronto, mas avanço com cautela sem iniciar combate`, hint: "Mostra preparo sem forçar luta." });
        if (playerHasItem(player, /torch|torches|tocha/i))
            actions.push({ label: "Acender tocha", content: "*acendo uma tocha para iluminar melhor o caminho e revelar detalhes escondidos", hint: getEquipmentInfo("Torch").summary });
        if (playerHasItem(player, /rope|corda/i))
            actions.push({ label: "Usar corda", content: "*uso minha corda para criar uma passagem segura e prender um ponto de apoio", hint: getEquipmentInfo("Rope").summary });
        if (playerHasItem(player, /lockpicks|gazua|ladrao|ladrão/i))
            actions.push({ label: "Usar gazuas", content: "*examino a fechadura ou mecanismo e uso minhas gazuas com cuidado", hint: getEquipmentInfo("Lockpicks").summary });
        if (playerHasItem(player, /healer|curandeiro/i))
            actions.push({ label: "Primeiros socorros", content: "*uso o kit de curandeiro para avaliar ferimentos e estabilizar quem precisar", hint: getEquipmentInfo("Healer's Kit").summary });
        actions.push({ label: "Falar com cautela", content: "- tento conversar com calma, deixando claro que não procuro conflito", hint: "Ajuda o Mestre a resolver socialmente antes de puxar combate." });
    }
    actions.push({ label: "Perguntar opções", content: "(com base na minha ficha e na cena, quais são minhas opções mais razoáveis agora?)", hint: "Pergunta OOC para o Mestre orientar como numa mesa real." });
    return actions.slice(0, 7);
}
function SuggestedActions({ player, room, onPick }) {
    const actions = buildSuggestedActions(player, room);
    return (_jsxs("section", { className: "suggestedActions", children: [_jsxs("div", { className: "suggestedActionsHead", children: [_jsx("strong", { children: "O que posso fazer agora?" }), _jsx("span", { children: room.combat.active ? "Combate" : "Cena" })] }), _jsx("div", { className: "suggestedActionGrid", children: actions.map((action) => (_jsxs("button", { type: "button", className: "suggestedActionBtn", onClick: () => onPick(action.content), title: action.hint, children: [_jsx("span", { children: action.label }), _jsx("em", { children: action.hint })] }, action.label))) })] }));
}
function PaperSheetView({ player }) {
    const attrKeys = ["strength", "agility", "mind", "presence", "constitution", "wisdom"];
    const resourceList = Object.values(player.resources?.limited ?? {});
    const hpPct = player.maxHitPoints > 0 ? Math.max(0, Math.min(100, (player.hitPoints / player.maxHitPoints) * 100)) : 0;
    const xpPct = xpProgressPercent(player);
    const equippedWeapons = player.inventory.equipped.filter((item) => /sword|axe|bow|rapier|dagger|staff|mace|crossbow|espada|machado|arco|adaga/i.test(item));
    const abilityMod = abilityModifier;
    const fmt = (value) => `${value >= 0 ? "+" : ""}${value}`;
    const classLine = formatClassLevels(player);
    const acBreakdown = armorClassBreakdown(player);
    return (_jsxs("div", { className: "paperSheet", children: [_jsxs("header", { className: "paperSheetHeader", children: [_jsxs("div", { children: [_jsx("span", { className: "paperKicker", children: "Ficha de personagem" }), _jsx("h3", { children: player.characterName })] }), _jsxs("div", { className: "paperIdentity", children: [_jsx("span", { children: classLine || `${player.className} ${player.level}` }), _jsx("span", { children: player.species }), _jsx("span", { children: player.background })] })] }), _jsxs("section", { className: "paperVitals", children: [_jsxs("div", { className: "paperVital paperVital-wide", children: [_jsx("span", { children: "HP" }), _jsxs("strong", { children: [player.hitPoints, "/", player.maxHitPoints] }), _jsx(InfoButton, { text: hitPointBreakdown(player) }), _jsx("div", { className: "paperMeter", children: _jsx("i", { style: { width: `${hpPct}%` } }) })] }), _jsxs("div", { className: "paperVital", children: [_jsx("span", { children: "AC" }), _jsx("strong", { children: player.armorClass }), _jsx(InfoButton, { text: acBreakdown.text })] }), _jsxs("div", { className: "paperVital", children: [_jsx("span", { children: "Prof." }), _jsxs("strong", { children: ["+", player.proficiencyBonus] }), _jsx(InfoButton, { text: `Bônus de proficiência por nível total ${player.level}: +${player.proficiencyBonus}. Em D&D 5e, níveis 1-4 usam +2; níveis 5-8 usam +3.` })] }), _jsxs("div", { className: "paperVital", children: [_jsx("span", { children: "Ouro" }), _jsx("strong", { children: player.inventory.gold })] }), _jsxs("div", { className: "paperVital paperVital-wide", children: [_jsx("span", { children: "XP" }), _jsx("strong", { children: formatXpProgress(player) }), _jsx("div", { className: "paperMeter", children: _jsx("i", { style: { width: `${xpPct}%` } }) })] })] }), resourceList.length > 0 && (_jsxs("section", { className: "paperBox", children: [_jsx("h4", { children: "Recursos" }), _jsx("div", { className: "resourceGrid", children: resourceList.map((resource) => (_jsxs("div", { className: "resourceChip", children: [_jsx("span", { children: resource.label }), _jsxs("strong", { children: [Math.max(0, resource.max - resource.used), "/", resource.max] })] }, resource.label))) })] })), _jsxs("section", { className: "paperColumns", children: [_jsxs("div", { className: "paperBox", children: [_jsx("h4", { children: "Atributos" }), _jsx("div", { className: "abilityGrid", children: attrKeys.filter((key) => player.attributes[key] !== undefined).map((key) => {
                                    const value = player.attributes[key] ?? 10;
                                    return (_jsxs("div", { className: "abilityCard", children: [_jsx("span", { children: ATTR_LABELS[key] ?? key }), _jsx("strong", { children: fmt(abilityMod(value)) }), _jsx("em", { children: value }), _jsx(InfoButton, { text: `${ATTR_DESCRIPTIONS[key] ?? key} ${buildAttributeBreakdown(player, key)}` })] }, key));
                                }) })] }), _jsxs("div", { className: "paperBox", children: [_jsx("h4", { children: "Pericias" }), _jsx("div", { className: "paperSkillList", children: Object.entries(player.skills).sort(([a], [b]) => a.localeCompare(b)).map(([skill, bonus]) => (_jsxs("div", { className: "paperSkillRow", children: [_jsx("span", { children: skill.charAt(0).toUpperCase() + skill.slice(1) }), _jsx("strong", { children: fmt(bonus) }), _jsx(InfoButton, { text: SKILL_DESCRIPTIONS[skill] ?? `${skill}: bonus ${fmt(bonus)}.` })] }, skill))) })] })] }), _jsxs("section", { className: "paperBox", children: [_jsx("h4", { children: "Habilidades" }), _jsx("div", { className: "paperFeatureList", children: player.features.length > 0 ? player.features.map((entry) => (_jsx(InfoLine, { label: entry, text: FEATURE_DESCRIPTIONS[entry] ?? `Caracteristica de classe: ${entry}.` }, entry))) : _jsx("span", { className: "paperEmpty", children: "Nenhuma habilidade registrada." }) })] }), _jsxs("section", { className: "paperBox", children: [_jsx("h4", { children: "Magias" }), _jsx("div", { className: "paperFeatureList", children: player.spells.length > 0 ? player.spells.map((entry) => (_jsx(InfoLine, { label: entry, text: SPELL_DESCRIPTIONS[entry] ?? `Magia: ${entry}.` }, entry))) : _jsx("span", { className: "paperEmpty", children: "Nenhuma magia conhecida/preparada." }) })] }), _jsxs("section", { className: "paperBox", children: [_jsx("h4", { children: "Equipamento" }), _jsxs("div", { className: "paperEquipment", children: [_jsxs("div", { children: [_jsx("strong", { children: "Equipado" }), player.inventory.equipped.map((entry) => {
                                        const info = getEquipmentInfo(entry);
                                        return _jsx(InfoLine, { label: entry, meta: info.summary, text: info.details, compact: true }, entry);
                                    })] }), _jsxs("div", { children: [_jsx("strong", { children: "Mochila" }), player.inventory.backpack.map((entry) => {
                                        const info = getEquipmentInfo(entry);
                                        return _jsx(InfoLine, { label: entry, meta: info.summary, text: info.details, compact: true }, entry);
                                    })] })] })] }), _jsxs("section", { className: "paperBox", children: [_jsx("h4", { children: "Ataques" }), _jsx("div", { className: "attackRows", children: (equippedWeapons.length > 0 ? equippedWeapons : player.inventory.equipped).slice(0, 4).map((item) => (_jsxs("div", { className: "attackRow", children: [_jsx("span", { children: item }), _jsx("strong", { children: fmt(player.skills.melee ?? player.proficiencyBonus) }), _jsx("em", { children: /bow|arco|crossbow/i.test(item) ? "distancia" : "corpo a corpo" })] }, item))) })] })] }));
}
const loreCategoryLabels = {
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
const moralAxisLabels = {
    compassion: "Compaixao",
    cruelty: "Crueldade",
    honesty: "Honestidade",
    deceit: "Engano",
    lawfulness: "Ordem",
    chaos: "Caos",
    courage: "Coragem",
    selfishness: "Egoismo",
};
function PlayerLoreView({ player }) {
    const loreEvents = [...(player.loreEvents ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const moralProfile = player.moralProfile;
    const moralEntries = moralProfile
        ? Object.entries(moralProfile)
            .filter(([key, value]) => key !== "label" && typeof value === "number" && value !== 0)
            .sort(([, a], [, b]) => Math.abs(Number(b)) - Math.abs(Number(a)))
            .slice(0, 6)
        : [];
    return (_jsxs("div", { className: "paperSheet loreSheet", children: [_jsxs("header", { className: "paperSheetHeader", children: [_jsxs("div", { children: [_jsx("span", { className: "paperKicker", children: "Cronica pessoal" }), _jsx("h3", { children: player.characterName })] }), _jsxs("div", { className: "paperIdentity", children: [_jsx("span", { children: "Bussola moral" }), _jsx("span", { children: moralProfile?.label ?? "em formacao" }), _jsxs("span", { children: [loreEvents.length, " registro(s)"] })] })] }), _jsxs("section", { className: "paperBox", children: [_jsx("h4", { children: "Bussola moral" }), moralEntries.length > 0 ? (_jsx("div", { className: "moralGrid", children: moralEntries.map(([axis, value]) => (_jsxs("div", { className: "moralAxis", children: [_jsx("span", { children: moralAxisLabels[axis] ?? axis }), _jsxs("strong", { children: [Number(value) > 0 ? "+" : "", Number(value)] })] }, axis))) })) : (_jsx("span", { className: "paperEmpty", children: "O mundo ainda esta formando uma opiniao sobre este personagem." }))] }), _jsxs("section", { className: "paperBox", children: [_jsx("h4", { children: "Feitos, dividas e consequencias" }), _jsx("div", { className: "loreTimeline", children: loreEvents.length > 0 ? loreEvents.map((event) => (_jsxs("article", { className: `loreEvent loreEvent-${event.importance}`, children: [_jsxs("div", { className: "loreEventHead", children: [_jsx("strong", { children: event.title }), _jsxs("span", { children: [loreCategoryLabels[event.category] ?? event.category, " \u00B7 ", event.importance] })] }), _jsx("p", { children: event.summary }), (event.location || event.peopleInvolved?.length) && (_jsxs("em", { children: [event.location ? `Local: ${event.location}` : "", event.location && event.peopleInvolved?.length ? " · " : "", event.peopleInvolved?.length ? `Pessoas: ${event.peopleInvolved.join(", ")}` : ""] }))] }, event.id))) : (_jsx("span", { className: "paperEmpty", children: "Sem feitos importantes registrados ainda. Acoes comuns ficam fora daqui para manter o lore limpo." })) })] })] }));
}
function InfoButton({ text }) {
    const buttonRef = useRef(null);
    const [open, setOpen] = useState(false);
    const [popoverStyle, setPopoverStyle] = useState({});
    useLayoutEffect(() => {
        if (!open || !buttonRef.current)
            return;
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
        if (!open)
            return;
        const close = (event) => {
            const target = event.target;
            if (buttonRef.current?.contains(target))
                return;
            setOpen(false);
        };
        window.addEventListener("mousedown", close);
        window.addEventListener("resize", () => setOpen(false), { once: true });
        return () => window.removeEventListener("mousedown", close);
    }, [open]);
    return (_jsxs(_Fragment, { children: [_jsx("button", { ref: buttonRef, type: "button", className: `infoPopoverButton${open ? " infoPopoverButton-open" : ""}`, "aria-label": "Mais informacoes", "aria-expanded": open, onClick: () => setOpen((current) => !current), children: "i" }), open && createPortal(_jsx("div", { className: "infoPopoverPanel", style: popoverStyle, children: text }), document.body)] }));
}
function InfoLine({ label, text, meta, compact = false }) {
    return (_jsxs("div", { className: `paperInfoLine${compact ? " paperInfoLine-compact" : ""}`, children: [_jsxs("span", { children: [label, meta && _jsx("em", { className: "paperInfoMeta", children: meta })] }), _jsx(InfoButton, { text: text })] }));
}
function InventoryView({ player }) {
    return (_jsxs("div", { className: "paperSheet inventorySheet", children: [_jsxs("header", { className: "paperSheetHeader", children: [_jsxs("div", { children: [_jsx("span", { className: "paperKicker", children: "Invent\u00E1rio" }), _jsx("h3", { children: player.characterName })] }), _jsxs("div", { className: "paperIdentity", children: [_jsxs("span", { children: ["Ouro ", player.inventory.gold] }), _jsxs("span", { children: [player.inventory.equipped.length, " equipado(s)"] }), _jsxs("span", { children: [player.inventory.backpack.length, " na mochila"] })] })] }), _jsxs("section", { className: "paperColumns", children: [_jsxs("div", { className: "paperBox", children: [_jsx("h4", { children: "Equipado" }), _jsx("div", { className: "paperFeatureList", children: player.inventory.equipped.length > 0 ? player.inventory.equipped.map((entry) => {
                                    const info = getEquipmentInfo(entry);
                                    return _jsx(InfoLine, { label: entry, meta: info.summary, text: info.details }, entry);
                                }) : _jsx("span", { className: "paperEmpty", children: "Nada equipado." }) })] }), _jsxs("div", { className: "paperBox", children: [_jsx("h4", { children: "Mochila" }), _jsx("div", { className: "paperFeatureList", children: player.inventory.backpack.length > 0 ? player.inventory.backpack.map((entry) => {
                                    const info = getEquipmentInfo(entry);
                                    return _jsx(InfoLine, { label: entry, meta: info.summary, text: info.details }, entry);
                                }) : _jsx("span", { className: "paperEmpty", children: "Mochila vazia." }) })] })] })] }));
}
function NotesView({ notesDraft, setNotesDraft, onSave }) {
    return (_jsxs("div", { className: "paperSheet notesSheet", children: [_jsxs("header", { className: "paperSheetHeader", children: [_jsxs("div", { children: [_jsx("span", { className: "paperKicker", children: "Notas de mesa" }), _jsx("h3", { children: "Anota\u00E7\u00F5es" })] }), _jsxs("div", { className: "paperIdentity", children: [_jsx("span", { children: "Privado da aba" }), _jsx("span", { children: "Salvo na ficha" })] })] }), _jsxs("section", { className: "paperBox", children: [_jsx("h4", { children: "Registro do jogador" }), _jsx("textarea", { className: "paperTextarea", value: notesDraft, onChange: (event) => setNotesDraft(event.target.value), rows: 12, placeholder: "Pistas, suspeitos, promessas, d\u00EDvidas, mapas mentais..." }), _jsx("button", { type: "button", className: "btn-primary", onClick: onSave, children: "Salvar anota\u00E7\u00F5es" })] })] }));
}
function LoadingArtCard({ title, description, variant, }) {
    return (_jsxs("div", { className: `loadingArtCard loadingArtCard-${variant}`, children: [_jsx("div", { className: "loadingDot", "aria-hidden": "true" }), title && _jsx("strong", { children: title }), description && _jsx("p", { children: description })] }));
}
