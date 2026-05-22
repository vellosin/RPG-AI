const dieMap: Record<string, string> = {
  d4: "dado de quatro",
  d6: "dado de seis",
  d8: "dado de oito",
  d10: "dado de dez",
  d12: "dado de doze",
  d20: "dado de vinte",
  d100: "dado percentual",
};

const stripMechanicalTail = (text: string): string => text
  .replace(/\b(?:Rule|Regra|Sistema)\s*:\s*[\s\S]*$/i, "")
  .replace(/\b(?:Attack roll|Enemy turn|Proximo turno|Pr[oó]ximo turno)\s*:\s*[\s\S]*$/i, "");

const repairCommonMojibake = (text: string): string => {
  if (!/[ÃÂâ]/.test(text)) return text;
  try {
    return Buffer.from(text, "latin1").toString("utf8");
  } catch {
    return text;
  }
};

const stripMarkdown = (text: string): string => text
  .replace(/^#{1,6}\s+/gm, "")
  .replace(/^\s*[-*]\s+/gm, "")
  .replace(/\*\*(.+?)\*\*/g, "$1")
  .replace(/\*(.+?)\*/g, "$1")
  .replace(/__(.+?)__/g, "$1")
  .replace(/_(.+?)_/g, "$1")
  .replace(/`([^`]+)`/g, "$1")
  .replace(/~~(.+?)~~/g, "$1");

const expandDiceNotation = (text: string): string => text.replace(/\b(\d*)d(4|6|8|10|12|20|100)\b/gi, (_match, count, sides) => {
  const spoken = dieMap[`d${sides}`];
  if (!spoken) return _match;
  if (!count || count === "1") return spoken;
  return `${count} ${spoken}s`;
});

const expandGameTerms = (text: string): string => text
  .replace(/\bHP\b/g, "pontos de vida")
  .replace(/\bMP\b/g, "pontos de mana")
  .replace(/\bAC\b/g, "classe de armadura")
  .replace(/\bCD\b/g, "classe de dificuldade")
  .replace(/\bNPCs?\b/g, "personagem do mestre")
  .replace(/\bGM\b/g, "mestre")
  .replace(/\bD&D\b/g, "Dungeons and Dragons")
  .replace(/\bvs\.?\b/gi, "contra")
  .replace(/(\d+)\s*\/\s*(\d+)/g, "$1 de $2")
  .replace(/([+-])\s*(\d+)/g, (_match, sign, value) => sign === "+" ? `mais ${value}` : `menos ${value}`);

const normalizePunctuation = (text: string): string => text
  .replace(/[\u2014\u2013]/g, ", ")
  .replace(/\u2026/g, "...")
  .replace(/[""]/g, "\"")
  .replace(/['']/g, "'")
  .replace(/[;:]\s*/g, ", ")
  .replace(/\s+([,.!?])/g, "$1")
  .replace(/([!?]){2,}/g, "$1")
  .replace(/\.{4,}/g, "...")
  .replace(/\s*\.\s*\.\s*\.\s*/g, "... ")
  .replace(/\s+/g, " ")
  .trim();

const insertNaturalBreathing = (text: string): string => text
  .replace(/\s+(mas|porem|porém|entretanto|todavia|embora|contudo)\s+/gi, ", $1 ")
  .replace(/\s+(entao|então|assim|por isso|ainda assim)\s+/gi, ", $1 ");

const sanitizeForPiper = (text: string): string => text
  .normalize("NFC")
  .replace(/[\u0000-\u001F\u007F]/g, " ")
  .replace(/[^\p{L}\p{N}\s.,!?'"()\-]/gu, " ")
  .replace(/\s+/g, " ")
  .trim();

const ensureTerminalPunctuation = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
};

export const preprocessForTts = (text: string): string => {
  if (!text || typeof text !== "string") return "";
  let processed = text;
  processed = repairCommonMojibake(processed);
  processed = stripMechanicalTail(processed);
  processed = stripMarkdown(processed);
  processed = expandDiceNotation(processed);
  processed = expandGameTerms(processed);
  processed = normalizePunctuation(processed);
  processed = insertNaturalBreathing(processed);
  processed = sanitizeForPiper(processed);
  processed = ensureTerminalPunctuation(processed);
  return processed;
};
