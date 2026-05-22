/**
 * Acumula chunks de texto vindos do streaming do Mestre e emite frases completas
 * conforme detecta limites naturais de pausa.
 *
 * Por que existir:
 * - O extractor de narração emite caractere a caractere (ou em rajadas curtas).
 * - O TTS precisa de frases inteiras para entoar corretamente — Piper sintetizar
 *   "Você ouve" e depois "passos atrás de você." como duas frases isoladas dá
 *   entonação cortada e desnatural.
 * - Mas esperar a narração inteira terminar elimina o ganho de streaming.
 * - A solução: detectar ponto final de frase e enviar pra TTS imediatamente,
 *   enquanto o resto continua streamando.
 *
 * Regras conservadoras de detecção:
 * - Final de frase: . ! ? seguido de espaço OU fim de buffer.
 * - Não quebra em abreviações comuns: Sr. Dr. Sra. Dra. p. ex. etc.
 * - Não quebra em números decimais: "1.5", "13,7".
 * - Quebra forte em \n\n (parágrafo).
 */

export type SentenceEmitter = (sentence: string, sequence: number) => void;

const ABBREVIATIONS = new Set([
  "sr", "sra", "dr", "dra", "srta", "exmo", "exma", "rev",
  "etc", "ex", "obs", "vs",
  // títulos comuns em fantasia
  "mr", "mrs", "ms", "lord", "lady",
]);

type SentenceBufferOptions = {
  /** Mínimo de caracteres para emitir; frases muito curtas são acumuladas. */
  minLength?: number;
  /** Tamanho máximo permitido antes de forçar flush mesmo sem pontuação. */
  maxLength?: number;
};

export class SentenceBuffer {
  private buffer = "";
  private sequence = 0;
  private readonly minLength: number;
  private readonly maxLength: number;

  constructor(
    private readonly emit: SentenceEmitter,
    options: SentenceBufferOptions = {},
  ) {
    this.minLength = options.minLength ?? 25;
    this.maxLength = options.maxLength ?? 400;
  }

  /**
   * Empilha mais texto vindo do stream e libera frases completas detectadas.
   */
  push(chunk: string): void {
    if (!chunk) return;
    this.buffer += chunk;
    this.drain();
  }

  /**
   * Quebra forte em quebra de parágrafo (\n\n). Útil quando o stream entrega
   * texto multilinha de uma vez.
   */
  private drain(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;

      // Quebra explícita por parágrafo (sempre flush, mesmo curto).
      const paragraphBreak = this.buffer.indexOf("\n\n");
      if (paragraphBreak >= 0) {
        const head = this.buffer.slice(0, paragraphBreak).trim();
        this.buffer = this.buffer.slice(paragraphBreak + 2);
        if (head.length > 0) this.flushSentence(head);
        progressed = true;
        continue;
      }

      // Procura próximo terminador de frase.
      const terminatorIndex = this.findSentenceEnd(this.buffer);
      if (terminatorIndex === -1) {
        // Sem terminador. Se o buffer estourou o teto, força flush no último espaço.
        if (this.buffer.length > this.maxLength) {
          const forceSplit = this.buffer.lastIndexOf(" ", this.maxLength);
          if (forceSplit > 0) {
            const head = this.buffer.slice(0, forceSplit).trim();
            this.buffer = this.buffer.slice(forceSplit + 1);
            if (head.length > 0) this.flushSentence(head);
            progressed = true;
          }
        }
        return;
      }

      const candidate = this.buffer.slice(0, terminatorIndex + 1).trim();
      this.buffer = this.buffer.slice(terminatorIndex + 1).trimStart();

      // Junta com a próxima frase se ficou curta demais. Acumular pra não soltar
      // "Sim." isolado no TTS.
      if (candidate.length < this.minLength) {
        // Reinsere com espaço pra continuar acumulando.
        this.buffer = `${candidate} ${this.buffer}`;
        return;
      }

      this.flushSentence(candidate);
      progressed = true;
    }
  }

  /**
   * Libera o que sobrou no buffer (chamado ao fim do stream).
   */
  flush(): void {
    const remainder = this.buffer.trim();
    this.buffer = "";
    if (remainder.length === 0) return;
    if (remainder.length < this.minLength) {
      // Texto residual curto — sintetiza mesmo assim porque é a última chance.
      this.flushSentence(remainder);
      return;
    }
    this.flushSentence(remainder);
  }

  /**
   * Descarta tudo sem emitir. Usado no barge-in.
   */
  reset(): void {
    this.buffer = "";
    this.sequence = 0;
  }

  /**
   * Retorna índice do terminador de frase válido (não de abreviação) ou -1.
   */
  private findSentenceEnd(text: string): number {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch !== "." && ch !== "!" && ch !== "?") continue;

      // Próximo char precisa ser espaço, quebra ou fim. Caso contrário pode ser parte
      // de número, URL, ou abreviação sem espaço.
      const next = text[i + 1];
      if (next !== undefined && next !== " " && next !== "\n" && next !== "\t" && next !== "\r") continue;

      // Reticências (`...`): o ponto final é o terceiro, não o primeiro.
      if (ch === "." && text[i + 1] === "." && text[i + 2] === ".") {
        i += 2;
        continue;
      }

      // Não quebra dentro de número decimal: "1.5" ou "1,5".
      const prev = text[i - 1];
      const nextChar = text[i + 1];
      if (ch === "." && prev && /\d/.test(prev) && nextChar && /\d/.test(nextChar)) continue;

      // Não quebra após abreviação conhecida.
      if (ch === "." && this.precedingTokenIsAbbreviation(text, i)) continue;

      return i;
    }
    return -1;
  }

  private precedingTokenIsAbbreviation(text: string, dotIndex: number): boolean {
    let start = dotIndex - 1;
    while (start >= 0 && /[a-zA-ZÀ-ÿ]/.test(text[start])) start--;
    const token = text.slice(start + 1, dotIndex).toLowerCase();
    if (token.length === 0) return false;
    return ABBREVIATIONS.has(token);
  }

  private flushSentence(text: string): void {
    const seq = this.sequence++;
    try {
      this.emit(text, seq);
    } catch {
      // Sink não pode quebrar o buffer.
    }
  }
}
