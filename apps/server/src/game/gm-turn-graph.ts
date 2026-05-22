import { END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import { planPlayerAction, type ActionPlan, type NarrativePolicy } from "./action-orchestrator.js";
import { buildNarrativePolicy } from "./narrative-policy.js";
import type { CampaignMemoryEntry, GmResponse, Player, PlayerAction, RoomState } from "./types.js";
import type { JanClient } from "../integrations/jan-client.js";
import { LocalCampaignMemoryProvider, type CampaignMemoryProvider } from "./memory-provider.js";
import { evaluateMechanicalRuling, type MechanicalRuling } from "./mechanics-guard.js";

type ResolutionRoute = "master" | "ooc" | "combat_engine" | "mechanics_guard";
type NarrationChunkHandler = (chunk: string) => void;

const GmTurnState = z.object({
  room: z.custom<RoomState>(),
  player: z.custom<Player>(),
  action: z.custom<PlayerAction>(),
  onNarrationChunk: z.custom<NarrationChunkHandler>().optional(),
  actionPlan: z.custom<ActionPlan>().optional(),
  relevantMemories: z.custom<CampaignMemoryEntry[]>().optional(),
  narrativePolicy: z.custom<NarrativePolicy>().optional(),
  mechanicalRuling: z.custom<MechanicalRuling>().optional(),
  route: z.custom<ResolutionRoute>().optional(),
  response: z.custom<GmResponse>().optional(),
});

export type GmTurnState = z.infer<typeof GmTurnState>;

export type GmTurnResult = {
  actionPlan: ActionPlan;
  relevantMemories: CampaignMemoryEntry[];
  narrativePolicy: NarrativePolicy;
  mechanicalRuling?: MechanicalRuling;
  route: ResolutionRoute;
  response: GmResponse;
};

const emptyResponse = (room: RoomState): GmResponse => ({
  narration: "A cena respira por um instante, mas nada claro acontece ainda.",
  sceneSummary: room.scene.summary,
  ruleOutcome: "Nenhuma resolução aplicada.",
  imageJobs: [],
  npcActions: [],
  joiningNpcs: [],
  rollRequest: null,
  npcHealthUpdates: [],
});

const toSafeArray = <T>(value: T[] | undefined): T[] => Array.isArray(value) ? value : [];

const activeNpcNames = (room: RoomState): Set<string> =>
  new Set((room.scene.activeNpcs ?? [])
    .filter((npc) => npc.status !== "dead" && npc.status !== "unconscious")
    .map((npc) => npc.name.toLowerCase()));

const validateGmResponse = (state: GmTurnState): GmResponse => {
  const response = state.response ?? emptyResponse(state.room);
  const actionPlan = state.actionPlan;

  if (!actionPlan) return response;

  const shouldSuppressRoll =
    actionPlan.intent === "social" ||
    actionPlan.intent === "question" ||
    actionPlan.intent === "ruling" ||
    !actionPlan.needsRoll;

  const shouldSuppressCombatSideEffects =
    actionPlan.intent !== "attack" &&
    !state.room.combat.active;

  const activeNpcs = activeNpcNames(state.room);
  const filteredNpcActions = toSafeArray(response.npcActions).filter((action) =>
    activeNpcs.size === 0 || activeNpcs.has(action.npcName.toLowerCase())
  );

  const filteredJoiningNpcs = toSafeArray(response.joiningNpcs)
    .filter((npc) => Boolean(npc.name && npc.role && npc.description))
    .filter((npc) => {
      const text = `${state.action.content} ${response.narration} ${response.ruleOutcome}`.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      return ["viajar junto", "seguir junto", "acompanhar", "se junta", "juntar ao grupo", "divide o risco", "dividir o risco", "aceita a companhia", "aliado"].some((term) => text.includes(term));
    })
    .slice(0, actionPlan.intent === "social" || actionPlan.intent === "exploration" ? 1 : 0);

  const filteredImages = toSafeArray(response.imageJobs).slice(0, actionPlan.intent === "exploration" || actionPlan.intent === "movement" ? 1 : 0);

  return {
    ...response,
    narration: response.narration?.trim() || emptyResponse(state.room).narration,
    sceneSummary: response.sceneSummary?.trim() || state.room.scene.summary,
    ruleOutcome: response.ruleOutcome?.trim() || "Resolução narrativa aplicada.",
    imageJobs: filteredImages,
    npcActions: filteredNpcActions,
    joiningNpcs: filteredJoiningNpcs,
    rollRequest: shouldSuppressRoll ? null : response.rollRequest,
    npcHealthUpdates: shouldSuppressCombatSideEffects ? [] : toSafeArray(response.npcHealthUpdates),
  };
};

const chooseRoute = (state: GmTurnState): ResolutionRoute => {
  if (state.mechanicalRuling?.status === "denied" || state.mechanicalRuling?.status === "resolved") return "mechanics_guard";
  const actionPlan = state.actionPlan ?? planPlayerAction(state.room, state.player, state.action);
  if (actionPlan.intent === "question" || actionPlan.intent === "ruling") return "ooc";
  if (state.room.combat.active && actionPlan.intent === "attack") return "combat_engine";
  return "master";
};

export const buildGmTurnGraph = (
  janClient: JanClient,
  memoryProvider: CampaignMemoryProvider = new LocalCampaignMemoryProvider(),
) => {
  const workflow = new StateGraph({
    stateSchema: GmTurnState,
  })
    .addNode("planAction", async (state: GmTurnState): Promise<Partial<GmTurnState>> => ({
      actionPlan: planPlayerAction(state.room, state.player, state.action),
    }))
    .addNode("retrieveMemory", async (state: GmTurnState): Promise<Partial<GmTurnState>> => ({
      relevantMemories: await memoryProvider.retrieveRelevant(state.room, state.action),
    }))
    .addNode("buildPolicy", async (state: GmTurnState): Promise<Partial<GmTurnState>> => {
      const actionPlan = state.actionPlan ?? planPlayerAction(state.room, state.player, state.action);
      const relevantMemories = state.relevantMemories ?? [];
      const narrativePolicy = buildNarrativePolicy(state.room, state.player, actionPlan, relevantMemories);
      const mechanicalRuling = evaluateMechanicalRuling(state.room, state.player, state.action, actionPlan);
      return {
        narrativePolicy,
        mechanicalRuling,
        actionPlan: {
          ...actionPlan,
          narrativePolicy,
          turnSteps: [...actionPlan.turnSteps, ...narrativePolicy.requiredBeats.slice(0, 3)],
          orchestrationNotes: [
            ...actionPlan.orchestrationNotes,
            narrativePolicy.responseFocus,
            narrativePolicy.rollGuidance,
            narrativePolicy.continuityGuidance,
            `Mechanical ruling: ${mechanicalRuling.status}. ${mechanicalRuling.reason}`,
          ],
        },
      };
    })
    .addNode("selectRoute", async (state: GmTurnState): Promise<Partial<GmTurnState>> => ({
      route: chooseRoute(state),
    }))
    .addNode("callMaster", async (state: GmTurnState): Promise<Partial<GmTurnState>> => {
      const actionPlan = state.actionPlan ?? planPlayerAction(state.room, state.player, state.action);
      const normalizedAction = { ...state.action, content: `${actionPlan.kind}: ${actionPlan.content}` };
      const response = state.onNarrationChunk
        ? await janClient.runGameMasterStreamed(
            state.room,
            normalizedAction,
            actionPlan,
            state.onNarrationChunk,
          )
        : await janClient.runGameMaster(
        state.room,
        normalizedAction,
        actionPlan,
      );

      return { response };
    })
    .addNode("mechanicsGuard", async (state: GmTurnState): Promise<Partial<GmTurnState>> => ({
      response: state.mechanicalRuling?.response ?? emptyResponse(state.room),
    }))
    .addNode("validateResponse", async (state: GmTurnState): Promise<Partial<GmTurnState>> => ({
      response: validateGmResponse(state),
    }))
    .addEdge(START, "planAction")
    .addEdge("planAction", "retrieveMemory")
    .addEdge("retrieveMemory", "buildPolicy")
    .addEdge("buildPolicy", "selectRoute")
    .addConditionalEdges(
      "selectRoute",
      (state: GmTurnState) => {
        if (state.route === "mechanics_guard") return "mechanicsGuard";
        return state.route === "combat_engine" ? "validateResponse" : "callMaster";
      },
      {
        callMaster: "callMaster",
        mechanicsGuard: "mechanicsGuard",
        validateResponse: "validateResponse",
      },
    )
    .addEdge("callMaster", "validateResponse")
    .addEdge("mechanicsGuard", "validateResponse")
    .addEdge("validateResponse", END);

  const graph = workflow.compile();

  return {
    async invoke(input: Pick<GmTurnState, "room" | "player" | "action" | "onNarrationChunk">): Promise<GmTurnResult> {
      const result = await graph.invoke(input);
      const actionPlan = result.actionPlan ?? planPlayerAction(input.room, input.player, input.action);
      const relevantMemories = result.relevantMemories ?? [];
      const narrativePolicy = result.narrativePolicy ?? buildNarrativePolicy(input.room, input.player, actionPlan, relevantMemories);
      return {
        actionPlan,
        relevantMemories,
        narrativePolicy,
        mechanicalRuling: result.mechanicalRuling,
        route: result.route ?? "master",
        response: result.response ?? emptyResponse(input.room),
      };
    },
  };
};
