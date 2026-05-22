const normalize = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

const hasAny = (text: string, terms: string[]): boolean => terms.some((term) => text.includes(normalize(term)));

export const visualLocksFromPortuguese = (description: string): { positive: string[]; negative: string[] } => {
  const text = normalize(description);
  const positive: string[] = [];
  const negative: string[] = [];

  if (hasAny(text, ["velho", "idoso", "anci", "grisalho", "envelhecido"])) {
    positive.push("(elderly older face:1.55), visible wrinkles, grey hair or grey beard, weathered aged features");
    negative.push("young face, smooth youthful skin, teenager, handsome young hero");
  } else if (hasAny(text, ["meia idade", "meia-idade", "experiente", "veterano"])) {
    positive.push("(middle aged mature face:1.4), age lines, experienced tired eyes, not young");
    negative.push("teenager, young adult, smooth youthful face");
  }

  if (hasAny(text, ["barba longa"])) {
    positive.push("(very long full beard:1.65), beard reaching upper chest");
    negative.push("clean shaven, stubble, short beard, trimmed beard");
  } else if (hasAny(text, ["barba grisalha"])) {
    positive.push("(grey beard:1.55), full facial hair with grey strands");
    negative.push("clean shaven, black beard only");
  } else if (hasAny(text, ["barba"])) {
    positive.push("(visible beard:1.35), clear facial hair");
    negative.push("clean shaven");
  }

  if (hasAny(text, ["careca", "calvo"])) {
    positive.push("(bald head:1.65), clearly shaved or hairless scalp");
    negative.push("full hair, long hair on top, thick hairstyle");
  }
  if (hasAny(text, ["cabelo longo"])) positive.push("(long hair:1.55), hair falling past shoulders");
  if (hasAny(text, ["encaracolado", "cacheado"])) positive.push("(curly hair:1.45), clearly curled hair texture");
  if (hasAny(text, ["ruivo", "ruiva"])) positive.push("(red ginger hair:1.5), copper red hair color");
  if (hasAny(text, ["loiro", "loira"])) positive.push("(blond hair:1.45), clear blond hair color");
  if (hasAny(text, ["cabelo preto"])) positive.push("(black hair:1.35), clear black hair color");
  if (hasAny(text, ["cabelo branco"])) positive.push("(white hair:1.45), clear white hair color");

  if (hasAny(text, ["olhos azuis"])) positive.push("(blue eyes:1.45), clearly blue iris color");
  if (hasAny(text, ["olhos verdes"])) positive.push("(green eyes:1.45), clearly green iris color");
  if (hasAny(text, ["olhos castanhos"])) positive.push("(brown eyes:1.3), brown iris color");

  if (hasAny(text, ["cicatriz no olho", "cicatriz sobre o olho", "cicatriz no rosto", "cicatriz facial", "cicatriz"])) {
    positive.push("(visible face scar:1.65), clear scar mark on the face, scar must be readable in the portrait");
    negative.push("perfect unscarred face, flawless skin");
  }

  if (hasAny(text, ["trapo", "farrapo", "rasgado", "pano rasgado"])) {
    positive.push("(ragged torn cloth:1.6), poor worn fabric, frayed torn edges, visibly damaged clothing");
    negative.push("polished armor, noble clothing, pristine shirt, expensive costume");
  }
  if (hasAny(text, ["preto", "preta"])) positive.push("(black clothing:1.45), charcoal black fabric");
  if (hasAny(text, ["vermelho", "vermelha"])) positive.push("(red clothing:1.35), red fabric");
  if (hasAny(text, ["azul"])) positive.push("(blue clothing:1.35), blue fabric");
  if (hasAny(text, ["verde"])) positive.push("(green clothing:1.35), green fabric");
  if (hasAny(text, ["branco", "branca"])) positive.push("(white clothing:1.25), white fabric");

  if (hasAny(text, ["cauteloso", "desconfiado"])) positive.push("cautious suspicious eyes, guarded posture");
  if (hasAny(text, ["exausto", "cansado"])) positive.push("tired eyes, exhausted posture");
  if (hasAny(text, ["corpulento", "robusto", "pesado"])) positive.push("stocky heavy build, broad body");

  return { positive, negative };
};

export const enemyIsNaturalBeast = (name: string, description: string): boolean => {
  const text = normalize(`${name} ${description}`);
  return (
    hasAny(text, ["lobo", "wolf", "cachorro", "cao", "cão", "dog", "beagle", "hound", "urso", "bear", "javali", "boar", "pantera", "panther", "aranha", "spider", "rato gigante", "giant rat", "cobra", "snake", "fera", "beast", "animal"]) &&
    !hasAny(text, ["lobisomem", "werewolf", "homem lobo", "licantropo", "humanoide", "humanoid", "goblin", "orc", "kobold"])
  );
};

export const npcIsAnimalCompanion = (name: string, role: string, description: string): boolean => {
  const text = normalize(`${name} ${role} ${description}`);
  return hasAny(text, ["companheiro animal", "animal companion", "cachorro", "cao", "cão", "beagle", "hound", "dog", "lobo domesticado", "falcao", "falcão", "corvo", "cavalo"]);
};

export const buildBeastVisualLocks = (name: string, description: string): { positive: string[]; negative: string[] } => {
  const text = normalize(`${name} ${description}`);
  const positive = [
    "natural quadruped animal creature, four-legged beast anatomy, body fully visible, animal posture",
    "no clothing, no armor, no weapons, no human hands",
  ];
  const negative = [
    "humanoid, human body, bipedal, standing upright like a person, man, woman, warrior",
    "holding weapon, sword, axe, spear, shield, armor, clothes, boots, gloves, human hands",
  ];

  if (hasAny(text, ["lobo", "wolf"])) {
    positive.unshift("(real wolf beast:1.7), grey or dark fur, canine muzzle, four paws, tail, predatory animal");
    negative.push("werewolf, wolfman, anthropomorphic wolf, furry humanoid");
  }
  if (hasAny(text, ["beagle"])) {
    positive.unshift("(real beagle dog:1.9), small hound dog, white brown and black short fur, floppy ears, black nose, four paws, tail, loyal tracking dog");
    negative.push("human, person, boy, man, ranger, humanoid dog, anthropomorphic dog");
  } else if (hasAny(text, ["cachorro", "cao", "cão", "dog", "hound"])) {
    positive.unshift("(real dog animal:1.75), canine muzzle, four paws, tail, loyal tracking hound");
    negative.push("human, person, man, humanoid dog, anthropomorphic dog");
  }

  return { positive, negative };
};
