import type { Player } from "./types.js";

const sentenceSplit = (text: string): string[] =>
  text.match(/[^.!?\n]+[.!?\n]*/g) ?? [text];

const applyFemaleAgreement = (sentence: string): string => sentence
  .replace(/\b(E|e)le\b/g, (_match, first: string) => first === "E" ? "Ela" : "ela")
  .replace(/\b(D|d)ele\b/g, (_match, first: string) => first === "D" ? "Dela" : "dela")
  .replace(/\bsozinho\b/g, "sozinha")
  .replace(/\bSozinho\b/g, "Sozinha")
  .replace(/\bchamado\b/g, "chamada")
  .replace(/\bChamado\b/g, "Chamada")
  .replace(/\benviado\b/g, "enviada")
  .replace(/\bEnviado\b/g, "Enviada")
  .replace(/\bdesignado\b/g, "designada")
  .replace(/\bDesignado\b/g, "Designada")
  .replace(/\bconvocado\b/g, "convocada")
  .replace(/\bConvocado\b/g, "Convocada")
  .replace(/\bferido\b/g, "ferida")
  .replace(/\bFerido\b/g, "Ferida")
  .replace(/\bpreparado\b/g, "preparada")
  .replace(/\bPreparado\b/g, "Preparada");

const applyMaleAgreement = (sentence: string): string => sentence
  .replace(/\b(E|e)la\b/g, (_match, first: string) => first === "E" ? "Ele" : "ele")
  .replace(/\b(D|d)ela\b/g, (_match, first: string) => first === "D" ? "Dele" : "dele")
  .replace(/\bsozinha\b/g, "sozinho")
  .replace(/\bSozinha\b/g, "Sozinho")
  .replace(/\bchamada\b/g, "chamado")
  .replace(/\bChamada\b/g, "Chamado")
  .replace(/\benviada\b/g, "enviado")
  .replace(/\bEnviada\b/g, "Enviado")
  .replace(/\bdesignada\b/g, "designado")
  .replace(/\bDesignada\b/g, "Designado")
  .replace(/\bconvocada\b/g, "convocado")
  .replace(/\bConvocada\b/g, "Convocado")
  .replace(/\bferida\b/g, "ferido")
  .replace(/\bFerida\b/g, "Ferido")
  .replace(/\bpreparada\b/g, "preparado")
  .replace(/\bPreparada\b/g, "Preparado");

export const enforcePlayerGenderAgreement = (text: string, player?: Pick<Player, "characterName" | "gender">): string => {
  if (!player?.characterName || !player.gender) return text;
  const name = player.characterName.toLowerCase();
  const transform = player.gender === "female" ? applyFemaleAgreement : applyMaleAgreement;
  const sentences = sentenceSplit(text);
  let previousMentionedPlayer = false;

  return sentences.map((sentence) => {
    const lower = sentence.toLowerCase();
    const mentionsPlayer = lower.includes(name);
    const startsWithPlayerPronoun = /^\s*(ele|ela|dele|dela|o|a)\b/i.test(sentence);
    const shouldTransform = mentionsPlayer || (previousMentionedPlayer && startsWithPlayerPronoun);
    const next = shouldTransform ? transform(sentence) : sentence;
    previousMentionedPlayer = mentionsPlayer;
    return next;
  }).join("");
};
