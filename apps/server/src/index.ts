import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { Server as SocketServer } from "socket.io";
import { config } from "./config.js";
import { GameEngine } from "./game/engine.js";
import { JanClient } from "./integrations/jan-client.js";
import { ImageService } from "./integrations/image-service.js";
import { TtsService } from "./integrations/tts-service.js";
import { createCampaignMemoryProvider } from "./game/memory-provider.js";
import { registerRoomRoutes } from "./routes/rooms.js";
import { MemoryStore } from "./store/memory-store.js";

const bootstrap = async () => {
  const store = new MemoryStore(config.roomsFilePath, config.databasePath);
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(fastifyStatic, {
    root: config.storageDir,
    prefix: "/assets/",
    decorateReply: false,
  });

  const io = new SocketServer(app.server, {
    cors: {
      origin: "*",
    },
  });

  const janClient = new JanClient();
  janClient.setLlmCallSink((trace) => {
    store.recordLlmCall({
      roomId: trace.roomId ?? null,
      model: trace.model,
      label: trace.label,
      promptChars: trace.promptChars,
      completionChars: trace.completionChars,
      latencyMs: trace.latencyMs,
      ok: trace.ok,
      mode: trace.mode,
      error: trace.error,
    });
  });
  const imageService = new ImageService();
  const ttsService = new TtsService();
  const memoryProvider = createCampaignMemoryProvider();
  const engine = new GameEngine(store, janClient, imageService, io, memoryProvider, ttsService);

  io.on("connection", (socket) => {
    socket.on("room:subscribe", (roomId: string) => {
      socket.join(roomId);
      const room = store.getRoom(roomId);
      if (room) {
        socket.emit("room:snapshot", room);
      }
    });
  });

  await registerRoomRoutes(app, { engine, store });

  if (memoryProvider.indexRoomMemory) {
    void Promise.all(store.listRooms().map((room) => memoryProvider.indexRoomMemory?.(room))).catch((error) => {
      app.log.warn({ error }, "Failed to sync existing rooms into graph memory");
    });
  }

  app.get("/api/integrations", async () => {
    const [jan, image, memory] = await Promise.all([
      janClient.getStatus(),
      imageService.getStatus(),
      memoryProvider.getStatus?.() ?? Promise.resolve({ provider: "unknown", enabled: false, ok: false, details: "No memory provider status." }),
    ]);
    return { jan, image, memory, tts: ttsService.getStatus() };
  });

  app.get("/api/audio/:audioId", async (request, reply) => {
    const params = request.params as { audioId: string };
    const audio = ttsService.consumeAudio(params.audioId);
    if (!audio) {
      reply.code(404);
      return { message: "Audio not found or expired." };
    }
    reply.header("Content-Type", audio.contentType);
    reply.header("Cache-Control", "no-store");
    return reply.send(audio.buffer);
  });

  app.get("/api/llm-stats", async (request) => {
    const params = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(params.limit ?? 50), 1), 500);
    return {
      stats: store.llmCallStats(),
      recent: store.recentLlmCalls(limit),
    };
  });

  if (config.hasWebDist) {
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      prefix: "/app/",
    });

    app.get("/", async (_request, reply) => {
      return reply.redirect("/app/");
    });

    app.get("/app", async (_request, reply) => {
      return reply.redirect("/app/");
    });
  }

  await app.listen({ host: config.host, port: config.port });

  engine.retryQueuedImageJobs();
};

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
