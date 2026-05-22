/**
 * Per-room async mutex.
 *
 * Why this exists:
 * - Two players in the same room can submit actions at the same instant.
 * - GM turn graph + memory updates + combat resolution mutate `room.combat.currentTurnIndex`,
 *   `room.scene.activeNpcs`, `room.memory.entries`. Without serialization, the second turn
 *   could read stale state and overwrite legitimate updates from the first.
 * - For local play this is rare; for multiplayer 2-4 it is real.
 *
 * Strategy: chain promises per roomId so withRoomLock(room, work) runs work() to completion
 * before the next withRoomLock for the same room begins. Different rooms are independent.
 */

const chains = new Map<string, Promise<unknown>>();

export const withRoomLock = async <T>(roomId: string, work: () => Promise<T>): Promise<T> => {
  const previous = chains.get(roomId) ?? Promise.resolve();
  let release!: (value: unknown) => void;
  const next = new Promise<unknown>((resolve) => { release = resolve; });
  chains.set(roomId, previous.then(() => next));

  try {
    await previous;
    return await work();
  } finally {
    release(undefined);
    // Best-effort cleanup so completed chains don't keep the room key forever.
    if (chains.get(roomId) === next) {
      chains.delete(roomId);
    }
  }
};
