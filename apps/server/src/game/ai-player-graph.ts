import { END, START, StateGraph } from "@langchain/langgraph";
import { z } from "zod";
import type { Player, PlayerAction, RoomState } from "./types.js";
import type { JanClient } from "../integrations/jan-client.js";

const AiPlayerState = z.object({
  room: z.custom<RoomState>(),
  requestedPlayerId: z.string().optional(),
  selectedPlayer: z.custom<Player>().optional(),
  action: z.custom<PlayerAction>().optional(),
});

export type AiPlayerState = z.infer<typeof AiPlayerState>;

export type AiPlayerTurnResult = {
  player: Player;
  action: PlayerAction;
};

const normalize = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

const sanitizeAiAction = (room: RoomState, player: Player, action: PlayerAction): PlayerAction => {
  const raw = action.content.trim().slice(0, 600);
  const prefixed = ["*", "-", "\"", "("].some((prefix) => raw.startsWith(prefix))
    ? raw
    : `* ${raw}`;

  const text = normalize(prefixed);
  const combatIsJustified = room.combat.active || (room.combat.enemies?.length ?? 0) > 0;
  const hostileWithoutThreat =
    !combatIsJustified &&
    ["ataco", "mato", "golpeio", "fireball", "bola de fogo", "esfaqueio"].some((term) => text.includes(term));

  if (hostileWithoutThreat) {
    return {
      playerId: player.id,
      content: `* observo a cena com cautela e procuro entender quem representa perigo antes de agir`,
    };
  }

  return {
    playerId: player.id,
    content: prefixed,
  };
};

export const buildAiPlayerGraph = (janClient: JanClient) => {
  const workflow = new StateGraph({
    stateSchema: AiPlayerState,
  })
    .addNode("selectPlayer", async (state: AiPlayerState): Promise<Partial<AiPlayerState>> => {
      const aiPlayers = state.room.players.filter((player) => (player.controller ?? "human") === "ai" && player.hitPoints > 0);
      const selectedPlayer = state.requestedPlayerId
        ? aiPlayers.find((player) => player.id === state.requestedPlayerId)
        : aiPlayers[0];

      return { selectedPlayer };
    })
    .addNode("chooseAction", async (state: AiPlayerState): Promise<Partial<AiPlayerState>> => {
      if (!state.selectedPlayer) return {};
      return {
        action: await janClient.runAiPlayerAction(state.room, state.selectedPlayer),
      };
    })
    .addNode("sanitizeAction", async (state: AiPlayerState): Promise<Partial<AiPlayerState>> => {
      if (!state.selectedPlayer || !state.action) return {};
      return {
        action: sanitizeAiAction(state.room, state.selectedPlayer, state.action),
      };
    })
    .addEdge(START, "selectPlayer")
    .addConditionalEdges(
      "selectPlayer",
      (state: AiPlayerState) => state.selectedPlayer ? "chooseAction" : END,
      { chooseAction: "chooseAction" },
    )
    .addEdge("chooseAction", "sanitizeAction")
    .addEdge("sanitizeAction", END);

  const graph = workflow.compile();

  return {
    async invoke(input: Pick<AiPlayerState, "room" | "requestedPlayerId">): Promise<AiPlayerTurnResult | null> {
      const result = await graph.invoke(input);
      if (!result.selectedPlayer || !result.action) return null;
      return {
        player: result.selectedPlayer,
        action: result.action,
      };
    },
  };
};
