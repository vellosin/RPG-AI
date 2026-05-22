import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";

const toNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
};

const configDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(configDir, "..");
loadEnv({ path: path.join(appDir, ".env") });
const storageDir = process.env.STORAGE_DIR ?? path.join(appDir, "storage");
const webDistDir = path.resolve(appDir, "..", "web", "dist");

export const config = {
  port: toNumber(process.env.PORT, 8787),
  host: process.env.HOST ?? "127.0.0.1",
  janBaseUrl: process.env.JAN_BASE_URL ?? "http://127.0.0.1:1337/v1",
  janModel: process.env.JAN_MODEL ?? "Qwen3_5-9B-IQ4_XS",
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "",
  imageBaseUrl: process.env.IMAGE_BASE_URL ?? "http://127.0.0.1:7860",
  imageModel: process.env.IMAGE_MODEL ?? "",
  imageProvider: process.env.IMAGE_PROVIDER ?? "auto",
  imageComfyUrl: process.env.IMAGE_COMFY_URL ?? "http://127.0.0.1:8188",
  imageComfyCheckpoint: process.env.IMAGE_COMFY_CHECKPOINT ?? "",
  imagePythonExecutable: process.env.IMAGE_PYTHON_EXECUTABLE ?? "",
  imageRuntimeDir: process.env.IMAGE_RUNTIME_DIR ?? path.join(process.env.USERPROFILE ?? "", "Models", "sdxl-test"),
  imageMcpUrl: process.env.IMAGE_MCP_URL ?? "http://127.0.0.1:8765/mcp",
  imageFastMode: toBoolean(process.env.IMAGE_FAST_MODE, true),
  textOnly: toBoolean(process.env.TEXT_ONLY, false),
  neo4jEnabled: toBoolean(process.env.NEO4J_ENABLED, false),
  neo4jUri: process.env.NEO4J_URI ?? "bolt://127.0.0.1:7687",
  neo4jHttpQueryUrl: process.env.NEO4J_HTTP_QUERY_URL ?? "",
  neo4jUsername: process.env.NEO4J_USERNAME ?? "neo4j",
  neo4jPassword: process.env.NEO4J_PASSWORD ?? "",
  neo4jDatabase: process.env.NEO4J_DATABASE ?? "neo4j",
  neo4jVectorDimensions: toNumber(process.env.NEO4J_VECTOR_DIMENSIONS, 1536),
  ttsEnabled: toBoolean(process.env.TTS_ENABLED, false),
  ttsPiperBinary: process.env.TTS_PIPER_BINARY ?? "piper",
  ttsVoiceGm: process.env.TTS_VOICE_GM ?? "",
  ttsVoiceNpcGruff: process.env.TTS_VOICE_NPC_GRUFF ?? "",
  ttsVoiceNpcMystic: process.env.TTS_VOICE_NPC_MYSTIC ?? "",
  ttsVoiceNpcMerchant: process.env.TTS_VOICE_NPC_MERCHANT ?? "",
  ttsVoiceNpcChild: process.env.TTS_VOICE_NPC_CHILD ?? "",
  ttsVoiceNpcVillain: process.env.TTS_VOICE_NPC_VILLAIN ?? "",
  ttsAudioTtlSeconds: toNumber(process.env.TTS_AUDIO_TTL_SECONDS, 120),
  ttsAudioMaxPlays: toNumber(process.env.TTS_AUDIO_MAX_PLAYS, 2),
  ttsMinSentenceLength: toNumber(process.env.TTS_MIN_SENTENCE_LENGTH, 25),
  storageDir,
  roomsFilePath: path.join(storageDir, "rooms.json"),
  databasePath: process.env.DATABASE_PATH ?? path.join(storageDir, "campaign.sqlite"),
  generatedImagesDir: path.join(storageDir, "generated"),
  portraitsDir: path.join(storageDir, "portraits"),
  scenesDir: path.join(storageDir, "scenes"),
  driveCacheDir: path.join(storageDir, "drive-cache"),
  curationDir: path.join(storageDir, "curadoria"),
  driveConfigPath: path.join(storageDir, "drive-config.json"),
  webDistDir,
  hasWebDist: existsSync(webDistDir),
};
