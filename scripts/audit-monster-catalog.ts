import fs from "node:fs/promises";
import path from "node:path";
import { monsterCatalog, type MonsterStatBlock } from "../apps/server/src/game/monster-catalog.js";

const xpByCr: Record<string, number> = {
  "0": 10,
  "1/8": 25,
  "1/4": 50,
  "1/2": 100,
  "1": 200,
  "2": 450,
  "3": 700,
  "4": 1100,
  "5": 1800,
};

const levelRangeByCr: Record<string, [number, number]> = {
  "0": [1, 1],
  "1/8": [1, 1],
  "1/4": [1, 2],
  "1/2": [1, 3],
  "1": [2, 4],
  "2": [3, 5],
  "3": [4, 5],
  "4": [5, 6],
  "5": [5, 7],
};

const attackDamageAverage = (monster: MonsterStatBlock): number => {
  const action = monster.actions[0];
  if (!action) return 0;
  const sides = Number(action.damageDie.replace("d", ""));
  return action.damageDiceCount * ((sides + 1) / 2) + action.damageModifier;
};

const auditMonster = (monster: MonsterStatBlock): string[] => {
  const issues: string[] = [];
  const expectedXp = xpByCr[monster.challengeRating];
  if (expectedXp === undefined) issues.push(`CR ${monster.challengeRating} sem XP de referencia no auditor.`);
  if (expectedXp !== undefined && monster.xpValue !== expectedXp) {
    issues.push(`XP ${monster.xpValue} nao bate com CR ${monster.challengeRating} (${expectedXp}).`);
  }
  if (!monster.actions.length) issues.push("Sem acoes de combate.");
  if (monster.armorClass < 5 || monster.armorClass > 20) issues.push(`CA fora da faixa esperada para baixo nivel: ${monster.armorClass}.`);
  if (monster.hitPoints < 1 || monster.hitPoints > 120) issues.push(`HP fora da faixa esperada para baixo nivel: ${monster.hitPoints}.`);
  const attackBonus = monster.actions[0]?.attackBonus ?? 0;
  if (attackBonus < 2 || attackBonus > 8) issues.push(`Bonus de ataque suspeito para baixo nivel: ${attackBonus}.`);
  const averageDamage = attackDamageAverage(monster);
  if (averageDamage > 16 && Number(monster.challengeRating) < 3) {
    issues.push(`Dano medio alto para CR ${monster.challengeRating}: ${averageDamage.toFixed(1)}.`);
  }
  if (!monster.difficultyBand.length) issues.push("Sem difficultyBand.");
  if (!monster.suggestedLevels.length) issues.push("Sem suggestedLevels.");
  const range = levelRangeByCr[monster.challengeRating];
  if (range) {
    const [min, max] = range;
    const farLevels = monster.suggestedLevels.filter((level) => level < min - 1 || level > max + 1);
    if (farLevels.length) issues.push(`suggestedLevels muito longe do CR: ${farLevels.join(", ")} para CR ${monster.challengeRating}.`);
  }
  if ((monster.biomeTags ?? []).length === 0) issues.push("Sem biomeTags explicitos; dependera de inferencia textual.");
  if (!monster.description || monster.description.length < 40) issues.push("Descricao curta demais para orientar o Mestre.");
  if (!monster.traits.length) issues.push("Sem traits narrativos/mecanicos.");
  return issues;
};

const main = async () => {
  const rows = monsterCatalog.map((monster) => ({
    id: monster.id,
    name: monster.name,
    cr: monster.challengeRating,
    xp: monster.xpValue,
    ac: monster.armorClass,
    hp: monster.hitPoints,
    attackBonus: monster.actions[0]?.attackBonus ?? null,
    averageDamage: Number(attackDamageAverage(monster).toFixed(1)),
    suggestedLevels: monster.suggestedLevels,
    difficultyBand: monster.difficultyBand,
    biomeTags: monster.biomeTags ?? [],
    issues: auditMonster(monster),
  }));

  const summary = {
    generatedAt: new Date().toISOString(),
    monsterCount: monsterCatalog.length,
    issueCount: rows.reduce((sum, row) => sum + row.issues.length, 0),
    monstersWithIssues: rows.filter((row) => row.issues.length > 0).length,
    byCr: rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.cr] = (acc[row.cr] ?? 0) + 1;
      return acc;
    }, {}),
  };

  const outDir = path.resolve("playtest-logs", "monster-audits");
  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(outDir, `monster-audit-${stamp}.json`);
  const mdPath = path.join(outDir, `monster-audit-${stamp}.md`);
  await fs.writeFile(jsonPath, JSON.stringify({ summary, rows }, null, 2), "utf-8");
  await fs.writeFile(mdPath, [
    "# Auditoria do catalogo de monstros",
    "",
    "```json",
    JSON.stringify(summary, null, 2),
    "```",
    "",
    "## Itens com alertas",
    "",
    ...rows
      .filter((row) => row.issues.length > 0)
      .flatMap((row) => [
        `### ${row.name} (${row.id})`,
        "",
        `CR ${row.cr}, XP ${row.xp}, CA ${row.ac}, HP ${row.hp}, ataque ${row.attackBonus}, dano medio ${row.averageDamage}.`,
        "",
        ...row.issues.map((issue) => `- ${issue}`),
        "",
      ]),
  ].join("\n"), "utf-8");

  console.log(JSON.stringify({ summary, jsonPath, mdPath }, null, 2));
};

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
