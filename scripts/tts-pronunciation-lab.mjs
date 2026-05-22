import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(rootDir, "apps", "server", ".env");

const parseEnvFile = (filePath) => {
  if (!existsSync(filePath)) return {};
  const entries = {};
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    entries[key] = value;
  }
  return entries;
};

const env = { ...parseEnvFile(envPath), ...process.env };
const candidatePaths = [
  env.TTS_PIPER_BINARY,
  "C:/Users/Lucas/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/Scripts/piper.exe",
  "C:/Users/Lucas/AppData/Roaming/Python/Python312/Scripts/piper.exe",
  "C:/Users/Lucas/AppData/Roaming/Python/Python311/Scripts/piper.exe",
  "C:/Users/Lucas/AppData/Local/Programs/Python/Python312/Scripts/piper.exe",
  "C:/Users/Lucas/AppData/Local/Programs/Python/Python311/Scripts/piper.exe",
  "C:/Users/Lucas/.local/bin/piper.exe",
].filter(Boolean);

const resolvePiperBinary = () => {
  const pathResult = spawnSync("where.exe", ["piper"], { encoding: "utf8" });
  const pathMatch = pathResult.status === 0 ? pathResult.stdout.split(/\r?\n/).find(Boolean) : "";
  if (pathMatch) return pathMatch.trim();

  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) return candidate;
  }
  return env.TTS_PIPER_BINARY || "piper";
};

const piperBinary = resolvePiperBinary();
const voiceModel = env.TTS_VOICE_GM || path.join(rootDir, "pt_BR-faber-medium.onnx");
const outDir = path.join(
  rootDir,
  "playtest-logs",
  `tts-pronunciation-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);

const SAMPLE_RATE = 22050;
const CHANNELS = 1;
const BIT_DEPTH = 16;

const buildWavHeader = (pcmByteLength) => {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8);
  const blockAlign = CHANNELS * (BIT_DEPTH / 8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcmByteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BIT_DEPTH, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcmByteLength, 40);
  return header;
};

const synthesize = (text, outputPath, options = {}) => new Promise((resolve, reject) => {
  const proc = spawn(piperBinary, [
    "--model", voiceModel,
    "--output-raw",
    "--length-scale", "1.28",
    "--noise-scale", "0.58",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    env: options.forceUtf8 === false
      ? process.env
      : { ...process.env, PYTHONIOENCODING: "utf-8" },
  });

  const chunks = [];
  let stderr = "";

  proc.stdout.on("data", (chunk) => chunks.push(chunk));
  proc.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  proc.on("error", reject);
  proc.on("close", (code) => {
    if (code !== 0) {
      reject(new Error(`Piper exited with ${code}: ${stderr.slice(0, 500)}`));
      return;
    }
    const pcm = Buffer.concat(chunks);
    writeFileSync(outputPath, Buffer.concat([buildWavHeader(pcm.length), pcm]));
    resolve({ bytes: pcm.length, stderr: stderr.trim() });
  });

  proc.stdin.write(text, "utf8");
  proc.stdin.end();
});

const samples = [
  {
    id: "01-acentos-nativos-utf8",
    text: "Não avance para o portão. A ação chama atenção. A visão do salão revela uma inscrição antiga.",
  },
  {
    id: "02-antigo-quebrado-sem-utf8",
    text: "Não avance para o portão. A ação chama atenção. A visão do salão revela uma inscrição antiga.",
    forceUtf8: false,
  },
  {
    id: "03-sem-acentos",
    text: "Nao avance para o portao. A acao chama atencao. A visao do salao revela uma inscricao antiga.",
  },
  {
    id: "04-fonetico-aum",
    text: "Naum avance para o portaum. A assaum chama atensaum. A visaum do salaum revela uma inscrissaum antiga.",
  },
  {
    id: "05-fonetico-awn",
    text: "Nawn avance para o portawn. A assawn chama atensawn. A visawn do salawn revela uma inscrissawn antiga.",
  },
  {
    id: "06-misto-ao-final-utf8",
    text: "Não avance para o portãum. A açãum chama atençãum. A visãum do salãum revela uma inscriçãum antiga.",
  },
];

const escapeHtml = (value) => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

if (!existsSync(voiceModel)) {
  throw new Error(`Voice model not found: ${voiceModel}`);
}

mkdirSync(outDir, { recursive: true });

const manifest = [];
console.log(`Piper: ${piperBinary}`);
console.log(`Voice: ${voiceModel}`);
console.log(`Output: ${outDir}`);

if ((piperBinary.includes("/") || piperBinary.includes("\\")) && !existsSync(piperBinary)) {
  throw new Error([
    `Piper binary not found: ${piperBinary}`,
    "Fix apps/server/.env TTS_PIPER_BINARY or install Piper, then run from anywhere with:",
    `npm --prefix ${rootDir} run tts:pronunciation`,
  ].join("\n"));
}

for (const sample of samples) {
  const wavPath = path.join(outDir, `${sample.id}.wav`);
  const result = await synthesize(sample.text, wavPath, { forceUtf8: sample.forceUtf8 });
  manifest.push({ ...sample, wavPath, pcmBytes: result.bytes, stderr: result.stderr });
  console.log(`${sample.id}: ${sample.text}`);
}

writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
writeFileSync(
  path.join(outDir, "README.txt"),
  [
    "Listen in order:",
    "01 keeps Brazilian Portuguese accents and forces UTF-8 into Piper stdin.",
    "02 is the old broken Windows stdin behavior without PYTHONIOENCODING=utf-8.",
    "03 strips accents, like the older RPG preprocessing did.",
    "04/05/06 are phonetic hacks for comparison only.",
    "",
    "Pick the sample that sounds most natural for words like nao/nao, acao/acao, portao/portao, visao/visao.",
    "",
    ...manifest.map((entry) => `${entry.id}.wav - ${entry.text}`),
  ].join("\n"),
  "utf8",
);

writeFileSync(
  path.join(outDir, "index.html"),
  `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>Piper pronunciation test</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 900px; margin: 32px auto; line-height: 1.45; color: #1f2937; }
    article { border: 1px solid #d1d5db; border-radius: 8px; padding: 16px; margin: 12px 0; }
    h1 { margin-bottom: 4px; }
    code { background: #f3f4f6; padding: 2px 5px; border-radius: 4px; }
    audio { width: 100%; margin-top: 8px; }
  </style>
</head>
<body>
  <h1>Piper pronunciation test</h1>
  <p>Compare os formatos para <code>não</code>, <code>ação</code>, <code>portão</code>, <code>visão</code> e <code>salão</code>.</p>
  ${manifest.map((entry) => `<article>
    <h2>${escapeHtml(entry.id)}</h2>
    <p>${escapeHtml(entry.text)}</p>
    <audio controls preload="metadata" src="./${escapeHtml(entry.id)}.wav"></audio>
  </article>`).join("\n")}
</body>
</html>
`,
  "utf8",
);
