import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildCharacterPortraitPrompt, buildPlayerFromCharacter } from "../apps/server/src/game/dnd5e.js";
import { config } from "../apps/server/src/config.js";
import type { CharacterCreation, ImageJob } from "../apps/server/src/game/types.js";
import { ImageService } from "../apps/server/src/integrations/image-service.js";

const allClasses = ["Fighter", "Rogue", "Wizard", "Cleric", "Ranger", "Bard", "Paladin", "Druid"] as const;
type ClassName = (typeof allClasses)[number];

const species = ["Human", "Elf", "Dwarf", "Halfling"] as const;
const genders = ["male", "female"] as const;

const backgroundByClass: Record<ClassName, CharacterCreation["background"]> = {
  Fighter: "Soldier",
  Rogue: "Outlander",
  Wizard: "Scholar",
  Cleric: "Acolyte",
  Ranger: "Outlander",
  Bard: "Entertainer",
  Paladin: "Acolyte",
  Druid: "Hermit",
};

const titleByGender: Record<(typeof genders)[number], string> = {
  male: "adult male adventurer with grounded features",
  female: "adult female adventurer with grounded features",
};

const variantCount = 2;

const slug = (...parts: string[]) => parts.map((part) => part.toLowerCase()).join("_");

// Optional --only=Ranger,Bard,Paladin,Druid filter
const onlyArg = process.argv.find((arg) => arg.startsWith("--only="));
const classes: readonly ClassName[] = onlyArg
  ? (onlyArg.replace("--only=", "").split(",").filter((c): c is ClassName => (allClasses as readonly string[]).includes(c)))
  : allClasses;

const createCalibrationCharacter = (
  className: ClassName,
  speciesName: (typeof species)[number],
  gender: (typeof genders)[number],
): CharacterCreation => ({
  name: "Portrait Calibration",
  characterName: `${className} ${speciesName} ${gender}`,
  className,
  species: speciesName,
  background: backgroundByClass[className],
  physicalDescription: `${titleByGender[gender]}, ${speciesName.toLowerCase()} adventurer, calm expression, readable face, clean body proportions`,
  weaponDescription: "",
  outfitDescription: "",
  appearanceDescription: "clear class silhouette, practical gear, portrait-ready pose",
});

const main = async () => {
  const service = new ImageService();
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.join(config.storageDir, "portrait-calibration", runId);
  const manifest: Array<{
    fileName: string;
    className: string;
    species: string;
    gender: string;
    variant: number;
    presetName: string;
    prompt: string;
    negativePrompt: string;
    seed: number;
  }> = [];

  await mkdir(outputDir, { recursive: true });

  for (const className of classes) {
    for (const speciesName of species) {
      for (const gender of genders) {
        const player = buildPlayerFromCharacter(createCalibrationCharacter(className, speciesName, gender), 3);
        const portrait = buildCharacterPortraitPrompt(player);

        for (let variant = 1; variant <= variantCount; variant += 1) {
          const seed = portrait.seed + variant * 101;
          const fileName = `${slug(className, speciesName, gender)}_${variant}.png`;
          const job: ImageJob = {
            id: `portrait-grid-${slug(className, speciesName, gender)}-${variant}`,
            roomId: "portrait-grid",
            status: "queued",
            profile: "portrait",
            prompt: portrait.prompt,
            negativePrompt: portrait.negativePrompt,
            seed,
          };

          const result = await service.render(job);
          if (!result?.assetUrl || !result.assetUrl.startsWith("/assets/generated/")) {
            throw new Error(`Portrait generation failed for ${fileName}.`);
          }

          const generatedPath = path.join(config.generatedImagesDir, path.basename(result.assetUrl));
          await copyFile(generatedPath, path.join(outputDir, fileName));

          manifest.push({
            fileName,
            className,
            species: speciesName,
            gender,
            variant,
            presetName: portrait.presetName,
            prompt: portrait.prompt,
            negativePrompt: portrait.negativePrompt,
            seed,
          });

          console.log(`generated ${fileName}`);
        }
      }
    }
  }

  await writeFile(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  console.log(`portrait calibration grid saved to ${outputDir}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
