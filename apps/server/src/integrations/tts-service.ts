import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { nanoid } from "nanoid";
import { config } from "../config.js";
import { getVoiceConfig, type VoiceProfile } from "../game/voice-catalog.js";
import { preprocessForTts } from "./tts-text-preprocess.js";

/**
 * TtsService: síntese de voz local com Piper.
 *
 * Design:
 * - Cada síntese é um spawn one-shot de `piper --model X --output-raw`.
 *   Texto vai por stdin, PCM bruto sai por stdout.
 *   Wrappamos o PCM em cabeçalho WAV em memória.
 * - O buffer WAV resultante é guardado num registry in-memory com TTL e contador
 *   de plays restantes. Sem disco.
 * - Um sweep periódico remove entradas expiradas.
 * - Se TTS_ENABLED for false, ou se o binário do Piper não rodar, a função
 *   synthesize() retorna null e o engine apenas pula áudio nessa frase.
 *
 * Por que não rodar um servidor HTTP do Piper:
 * - Menos infra pro usuário manter, e spawn one-shot é rápido (~150ms cold).
 * - Sem porta TCP exposta acidentalmente.
 * - Mais simples falhar gracioso: erro de spawn = áudio pulado, jogo continua.
 *
 * Por que PCM raw + wrap WAV em vez de --output_file:
 * - Não toca disco. Tudo fica em RAM.
 * - Header WAV é 44 bytes, trivial montar.
 */

type AudioEntry = {
  id: string;
  buffer: Buffer;
  playsRemaining: number;
  expiresAt: number;
  contentType: string;
  durationMs: number;
};

export type SynthResult = {
  audioId: string;
  durationMs: number;
};

const SAMPLE_RATE = 22050; // padrão dos modelos Piper
const CHANNELS = 1;
const BIT_DEPTH = 16;

/**
 * Constrói cabeçalho WAV de 44 bytes para PCM 16-bit mono 22050Hz.
 */
const buildWavHeader = (pcmByteLength: number): Buffer => {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8);
  const blockAlign = CHANNELS * (BIT_DEPTH / 8);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcmByteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);          // fmt chunk size
  header.writeUInt16LE(1, 20);           // PCM format
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BIT_DEPTH, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcmByteLength, 40);

  return header;
};

const estimateDurationMs = (pcmByteLength: number): number => {
  const samples = pcmByteLength / (BIT_DEPTH / 8) / CHANNELS;
  return Math.round((samples / SAMPLE_RATE) * 1000);
};

export class TtsService {
  private readonly registry = new Map<string, AudioEntry>();
  private readonly ttlMs: number;
  private readonly maxPlays: number;
  private readonly minSentenceLength: number;
  private sweepTimer: NodeJS.Timeout | null = null;
  private piperAvailable: boolean | null = null;
  private retryPiperAfter = 0;
  private synthesisChain: Promise<void> = Promise.resolve();

  constructor() {
    this.ttlMs = config.ttsAudioTtlSeconds * 1000;
    this.maxPlays = config.ttsAudioMaxPlays;
    this.minSentenceLength = config.ttsMinSentenceLength;
    this.startSweep();
  }

  /**
   * Indica se o serviço está habilitado e configurado. Engine consulta antes de
   * gastar trabalho construindo o stream.
   */
  isEnabled(): boolean {
    return config.ttsEnabled && Boolean(config.ttsVoiceGm);
  }

  /**
   * Sintetiza um trecho de texto numa voz e devolve um id que pode ser usado
   * pra recuperar o WAV via getAudio(). Retorna null quando:
   * - TTS_ENABLED é false
   * - texto curto demais
   * - Piper falhou (binário ausente, modelo inválido, etc.)
   */
  async synthesize(text: string, voiceProfile: VoiceProfile = "gm-narrator"): Promise<SynthResult | null> {
    if (!this.isEnabled()) return null;
    if (this.piperAvailable === false && Date.now() < this.retryPiperAfter) return null;
    const cleaned = preprocessForTts(text);
    if (cleaned.length < this.minSentenceLength) return null;

    const voice = getVoiceConfig(voiceProfile);
    if (!voice.modelPath) return null;

    try {
      const pcm = await this.enqueuePiper(cleaned, voice.modelPath, voice.lengthScale, voice.noiseScale);
      if (!pcm || pcm.length === 0) return null;
      this.piperAvailable = true;
      this.retryPiperAfter = 0;

      const wav = Buffer.concat([buildWavHeader(pcm.length), pcm]);
      const id = nanoid();
      const durationMs = estimateDurationMs(pcm.length);

      this.registry.set(id, {
        id,
        buffer: wav,
        playsRemaining: this.maxPlays,
        expiresAt: Date.now() + this.ttlMs,
        contentType: "audio/wav",
        durationMs,
      });

      return { audioId: id, durationMs };
    } catch (error) {
      // Marcamos Piper como indisponível pra evitar tentar de novo em loop.
      // Pode voltar a tentar depois do sweep.
      this.piperAvailable = false;
      this.retryPiperAfter = Date.now() + 60_000;
      console.warn("[tts] Piper failed:", (error as Error).message);
      return null;
    }
  }

  /**
   * Recupera o buffer pra streaming HTTP. Decrementa plays restantes; remove
   * quando zera ou quando expira.
   */
  consumeAudio(audioId: string): { buffer: Buffer; contentType: string; durationMs: number } | null {
    const entry = this.registry.get(audioId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.registry.delete(audioId);
      return null;
    }

    entry.playsRemaining -= 1;
    const result = { buffer: entry.buffer, contentType: entry.contentType, durationMs: entry.durationMs };
    if (entry.playsRemaining <= 0) {
      this.registry.delete(audioId);
    }
    return result;
  }

  /**
   * Cancela todas as entradas que ainda não foram consumidas — usado no barge-in
   * quando o jogador interrompe o Mestre com nova ação.
   */
  cancelAll(): void {
    this.registry.clear();
  }

  /**
   * Encerra timers; útil em testes ou shutdown.
   */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.registry.clear();
  }

  /**
   * Status pra /api/integrations.
   */
  getStatus(): { provider: string; enabled: boolean; ok: boolean; details: string } {
    if (!config.ttsEnabled) {
      return { provider: "piper-tts", enabled: false, ok: false, details: "TTS_ENABLED desligado." };
    }
    if (!config.ttsVoiceGm) {
      return { provider: "piper-tts", enabled: true, ok: false, details: "TTS_VOICE_GM não configurado." };
    }
    if (config.ttsPiperBinary !== "piper" && !existsSync(config.ttsPiperBinary)) {
      return { provider: "piper-tts", enabled: true, ok: false, details: `Binario Piper nao encontrado: ${config.ttsPiperBinary}` };
    }
    if (!existsSync(config.ttsVoiceGm)) {
      return { provider: "piper-tts", enabled: true, ok: false, details: `Voz nao encontrada: ${config.ttsVoiceGm}` };
    }
    if (this.piperAvailable === false && Date.now() < this.retryPiperAfter) {
      return { provider: "piper-tts", enabled: true, ok: false, details: "Última chamada ao Piper falhou. Nova tentativa automática em até 60s." };
    }
    return { provider: "piper-tts", enabled: true, ok: true, details: `Voz padrão: ${config.ttsVoiceGm}` };
  }

  /**
   * Spawn de piper one-shot. Resolve com PCM puro.
   */
  private runPiper(text: string, modelPath: string, lengthScale: number, noiseScale: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const args = [
        "--model", modelPath,
        "--output-raw",
        "--length-scale", lengthScale.toFixed(2),
        "--noise-scale", noiseScale.toFixed(3),
      ];

      const proc = spawn(config.ttsPiperBinary, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
        },
      });

      const chunks: Buffer[] = [];
      let stderr = "";
      let settled = false;

      const safeResolve = (value: Buffer): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const safeReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      // Hard timeout: se o Piper travar, não deixa pendurado o turno.
      const timeoutMs = Math.min(45_000, Math.max(15_000, text.length * 180));
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        safeReject(new Error(`Piper timeout (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);

      proc.stdout.on("data", (chunk: Buffer) => { chunks.push(chunk); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });
      proc.on("error", (error) => {
        clearTimeout(timer);
        safeReject(error);
      });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          safeReject(new Error(`Piper exited with ${code}: ${stderr.slice(0, 200)}`));
          return;
        }
        safeResolve(Buffer.concat(chunks));
      });

      proc.stdin.write(text);
      proc.stdin.end();
    });
  }

  private enqueuePiper(text: string, modelPath: string, lengthScale: number, noiseScale: number): Promise<Buffer> {
    const run = this.synthesisChain.then(() => this.runPiper(text, modelPath, lengthScale, noiseScale));
    this.synthesisChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Varre entradas expiradas. Chamado periodicamente em background.
   */
  private startSweep(): void {
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of this.registry.entries()) {
        if (now > entry.expiresAt) {
          this.registry.delete(id);
        }
      }
    }, 10_000);
    if (typeof this.sweepTimer.unref === "function") this.sweepTimer.unref();
  }
}
