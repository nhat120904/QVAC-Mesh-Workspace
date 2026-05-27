import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pcm16ToWav } from "./audio.js";
import { buildDocumentChunks, buildRagPrompt, formatSources, retrieveTopChunks } from "./rag.js";
import { errorToMessage, QvacWorkspace, SetupRequiredError } from "./qvacClient.js";
import { defaultConfig } from "./defaults.js";
import { LocalStore, nowIso, uid } from "./storage.js";
import type { AppState, Capability, ChatMessage, ProviderConfig, RouteRequest, StoredDocument, Transcript, VoiceTurn } from "./types.js";

const port = Number(process.env.QVAC_MESH_API_PORT ?? 38471);
const store = new LocalStore(process.env.QVAC_MESH_STORAGE);
let state: AppState;
let qvac: QvacWorkspace;

await boot();

async function boot(): Promise<void> {
  state = await store.load();
  qvac = new QvacWorkspace(state.config);

  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`QVAC Mesh Workspace API listening on http://127.0.0.1:${port}`);
  });

  const shutdown = async () => {
    await qvac.unloadAll().catch(() => undefined);
    await qvac.stopProvider().catch(() => undefined);
    server.close();
  };
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (url.pathname === "/chat/stream" && req.method === "POST") {
      const body = await readJson(req);
      await chatStream(asRecord(body), res);
      return;
    }
    if (url.pathname === "/image/stream" && req.method === "POST") {
      const body = await readJson(req);
      await imageStream(asRecord(body), res);
      return;
    }
    const body = req.method === "GET" ? undefined : await readJson(req);
    const result = await route(url.pathname, body);
    writeJson(res, 200, { ok: true, ...result });
  } catch (error) {
    writeJson(res, 500, { ok: false, error: errorToMessage(error) });
  }
}

async function chatStream(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-cache",
    "x-accel-buffering": "no"
  });
  const send = (obj: Record<string, unknown>): void => {
    res.write(`${JSON.stringify(obj)}\n`);
  };
  const unsubscribe = qvac.onStatus((status) => send({ type: "status", status }));
  try {
    const mode = String(body.mode ?? "normal");
    const prompt = String(body.prompt ?? "");
    const route = body.route as RouteRequest;
    if (!prompt.trim()) throw new Error("Prompt is empty.");

    if (mode === "rag") {
      send({ type: "info", message: "Embedding question and retrieving chunks..." });
      const answer = await answerWithRag(prompt, route);
      const assistant: ChatMessage = { role: "assistant", content: answer, at: nowIso(), route: route.mode };
      send({ type: "token", text: answer });
      send({ type: "done", message: assistant, state });
      return;
    }

    const attachments = await saveUploads((body.attachments ?? []) as UploadInput[], "uploads");
    const userMessage: ChatMessage = { role: "user", content: prompt, at: nowIso(), attachments };
    const history = state.chat.slice(-12);
    state.chat.push(userMessage);
    send({ type: "user", message: userMessage });

    const result = await qvac.complete(
      {
        prompt,
        history,
        attachments,
        onToken: (token) => send({ type: "token", text: token })
      },
      route
    );
    const assistant: ChatMessage = {
      role: "assistant",
      content: result.value,
      at: nowIso(),
      route: result.route,
      providerPublicKey: result.provider?.publicKey
    };
    state.chat.push(assistant);
    await save();
    send({ type: "done", message: assistant, state });
  } catch (error) {
    send({ type: "error", error: errorToMessage(error) });
  } finally {
    unsubscribe();
    res.end();
  }
}

async function route(pathname: string, body: unknown): Promise<Record<string, unknown>> {
  switch (pathname) {
    case "/state":
      return statePayload();
    case "/gallery/images":
      return await galleryImages();
    case "/config/save":
      state.config = asRecord(body).config as AppState["config"];
      await qvac.unloadAll();
      qvac.setConfig(state.config);
      await save();
      return statePayload();
    case "/config/auto-setup":
      return await autoSetup(asRecord(body));
    case "/config/reset":
      return await resetConfig();
    case "/chat/complete":
      return await chatComplete(asRecord(body));
    case "/chat/clear":
      state.chat = [];
      await save();
      return statePayload();
    case "/documents/ingest":
      return await ingestDocument(asRecord(body));
    case "/documents/remove":
      return await removeDocument(asRecord(body));
    case "/documents/clear":
      state.documents = [];
      state.chunks = [];
      await save();
      return statePayload();
    case "/rag/answer":
      return await ragAnswer(asRecord(body));
    case "/multimodal":
      return await multimodal(asRecord(body));
    case "/audio/transcribe":
      return await transcribeUpload(asRecord(body));
    case "/audio/transcript-prompt":
      return await transcriptPrompt(asRecord(body));
    case "/audio/transcript-to-rag":
      return await latestTranscriptToRag(asRecord(body));
    case "/translate":
      return await translateText(asRecord(body));
    case "/voice/turn":
      return await voiceTurn(asRecord(body));
    case "/image/generate":
      return await imageGenerate(asRecord(body));
    case "/image/enhance-prompt":
      return await enhanceImagePrompt(asRecord(body));
    case "/provider/start":
      return { publicKey: await qvac.startProvider(), ...statePayload() };
    case "/provider/stop":
      await qvac.stopProvider();
      return statePayload();
    case "/provider/add":
      return await providerAdd(asRecord(body));
    case "/provider/remove":
      return await providerRemove(asRecord(body));
    case "/provider/test":
      return await providerTest(asRecord(body));
    default:
      throw new Error(`Unknown API route ${pathname}`);
  }
}

async function chatComplete(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const prompt = String(body.prompt ?? "");
  const attachments = await saveUploads((body.attachments ?? []) as UploadInput[], "uploads");
  const userMessage: ChatMessage = { role: "user", content: prompt, at: nowIso(), attachments };
  const history = state.chat.slice(-12);
  state.chat.push(userMessage);
  const route = body.route as RouteRequest;
  const result = await qvac.complete({ prompt, history, attachments }, route);
  const assistant: ChatMessage = {
    role: "assistant",
    content: result.value,
    at: nowIso(),
    route: result.route,
    providerPublicKey: result.provider?.publicKey
  };
  state.chat.push(assistant);
  await save();
  return { message: assistant, state };
}

async function ingestDocument(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const name = String(body.name ?? `document-${Date.now()}.txt`);
  const text = String(body.text ?? "");
  const path = await store.writeText("documents", name, text);
  const document: StoredDocument = { id: uid(), name, path, chunkIds: [], createdAt: nowIso() };
  const chunks = await buildDocumentChunks({ embedTexts: (texts) => qvac.embedTexts(texts, body.route as Partial<RouteRequest>) }, document, text);
  document.chunkIds = chunks.map((chunk) => chunk.id);
  state.documents.push(document);
  state.chunks.push(...chunks);
  await save();
  return { document, chunks: chunks.length, state };
}

async function ragAnswer(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const question = String(body.question ?? "");
  const answer = await answerWithRag(question, body.route as RouteRequest);
  return { answer };
}

async function multimodal(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const prompt = String(body.prompt ?? "");
  const attachments = await saveUploads((body.attachments ?? []) as UploadInput[], "uploads");
  const result = await qvac.complete({ prompt, attachments }, body.route as RouteRequest);
  return { answer: result.value, route: result.route, provider: result.provider };
}

async function transcribeUpload(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const [audioPath] = await saveUploads([body.file as UploadInput], "audio");
  if (!audioPath) throw new Error("No audio file provided.");
  const result = await qvac.transcribe(audioPath, body.route as RouteRequest);
  const transcript: Transcript = {
    id: uid(),
    name: String((body.file as UploadInput | undefined)?.name ?? basename(audioPath)),
    audioPath,
    text: result.value,
    createdAt: nowIso()
  };
  state.transcripts.push(transcript);
  await save();
  return { transcript, text: result.value, state };
}

async function transcriptPrompt(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const latest = state.transcripts.at(-1);
  if (!latest) return { answer: "No transcript available." };
  const instruction = String(body.instruction ?? "Summarize this transcript clearly.");
  const result = await qvac.complete({ prompt: `${instruction}\n\nTranscript:\n${latest.text}` }, body.route as RouteRequest);
  return { answer: result.value };
}

async function latestTranscriptToRag(body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const latest = state.transcripts.at(-1);
  if (!latest) return { answer: "No transcript available." };
  const route = (body?.route as Partial<RouteRequest> | undefined) ?? { capability: "embeddings", mode: state.config.defaultRoute ?? "local" };
  await ingestDocument({ name: `Transcript-${latest.name}.txt`, text: latest.text, route });
  return { answer: `Added transcript "${latest.name}" to RAG.`, state };
}

async function translateText(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await qvac.translate(
    String(body.text ?? ""),
    String(body.from ?? "en"),
    String(body.to ?? "vi"),
    body.route as RouteRequest
  );
  return { answer: result.value };
}

async function voiceTurn(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const [audioPath] = await saveUploads([body.file as UploadInput], "audio");
  if (!audioPath) throw new Error("No voice recording provided.");
  const route = body.route as RouteRequest;
  const transcription = await qvac.transcribe(audioPath, { ...route, capability: "transcription" });
  const response = await qvac.complete({ prompt: transcription.value }, { ...route, capability: "llm" });

  let ttsPath: string | undefined;
  let audioBase64: string | undefined;
  let ttsNote: string | undefined;
  try {
    const speech = await qvac.speak(response.value, { ...route, capability: "tts" });
    const wav = pcm16ToWav(speech.value);
    ttsPath = await store.writeBinary("audio", `voice-response-${Date.now()}.wav`, wav);
    audioBase64 = Buffer.from(wav).toString("base64");
  } catch (error) {
    if (error instanceof SetupRequiredError) {
      ttsNote = "TTS is not configured — returning text only. Enable TTS in Model config to hear the reply.";
    } else {
      ttsNote = `TTS failed: ${errorToMessage(error)}`;
    }
  }

  const turn: VoiceTurn = {
    id: uid(),
    audioPath,
    transcript: transcription.value,
    response: response.value,
    ttsPath,
    createdAt: nowIso()
  };
  state.voiceTurns.push(turn);
  await save();
  return { turn, audioBase64, ttsNote, state };
}

async function removeDocument(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = String(body.id ?? "");
  const before = state.documents.length;
  state.documents = state.documents.filter((doc) => doc.id !== id);
  state.chunks = state.chunks.filter((chunk) => chunk.documentId !== id);
  if (state.documents.length === before) throw new Error("Document not found.");
  await save();
  return statePayload();
}

async function imageStream(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-cache",
    "x-accel-buffering": "no"
  });
  const send = (obj: Record<string, unknown>): void => {
    res.write(`${JSON.stringify(obj)}\n`);
  };
  const unsubscribe = qvac.onStatus((status) => send({ type: "status", status }));
  try {
    const prompt = String(body.prompt ?? "").trim();
    if (!prompt) throw new Error("Prompt is empty.");
    const width = Number(body.width ?? 512);
    const height = Number(body.height ?? 512);
    const steps = Number(body.steps ?? 20);
    const route = body.route as RouteRequest;

    const result = await qvac.generateImage(
      prompt,
      width,
      height,
      steps,
      route,
      (tick) => send({ type: "progress", step: tick.step, totalSteps: tick.totalSteps, elapsedMs: tick.elapsedMs })
    );

    const images: Array<{ id: string; prompt: string; path: string; createdAt: string; dataBase64: string }> = [];
    for (let i = 0; i < result.value.length; i += 1) {
      const bytes = result.value[i] ?? new Uint8Array();
      if (bytes.byteLength === 0) {
        throw new Error(`Image ${i} has 0 bytes; provider returned empty buffer.`);
      }
      const path = await store.writeBinary("gallery", `${Date.now()}-${i}.png`, bytes);
      const item = { id: uid(), prompt, path, createdAt: nowIso() };
      state.gallery.unshift(item);
      const dataBase64 = Buffer.from(bytes).toString("base64");
      console.log(`[image] received image ${i}: ${bytes.byteLength} bytes, base64 ${dataBase64.length} chars, route=${result.route}`);
      images.push({ ...item, dataBase64 });
    }
    await save();
    send({ type: "done", images, state });
  } catch (error) {
    send({ type: "error", error: errorToMessage(error) });
  } finally {
    unsubscribe();
    res.end();
  }
}

async function imageGenerate(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await qvac.generateImage(
    String(body.prompt ?? ""),
    Number(body.width ?? 512),
    Number(body.height ?? 512),
    Number(body.steps ?? 20),
    body.route as RouteRequest
  );
  const images = [];
  for (let i = 0; i < result.value.length; i += 1) {
    const bytes = result.value[i] ?? new Uint8Array();
    if (bytes.byteLength === 0) {
      throw new Error(`Image ${i} has 0 bytes; provider returned empty buffer.`);
    }
    const path = await store.writeBinary("gallery", `${Date.now()}-${i}.png`, bytes);
    const item = { id: uid(), prompt: String(body.prompt ?? ""), path, createdAt: nowIso() };
    state.gallery.unshift(item);
    images.push({ ...item, dataBase64: Buffer.from(bytes).toString("base64") });
  }
  await save();
  return { images, state };
}

async function enhanceImagePrompt(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) throw new Error("Prompt is empty.");
  const route = body.route as RouteRequest;
  const instruction = [
    "You rewrite short user prompts into rich, vivid prompts for a text-to-image diffusion model.",
    "Keep the original subject and intent. Add concrete visual detail: subject specifics, composition, lighting, color palette, style, medium, mood, and camera/lens cues when fitting.",
    "Return ONLY the rewritten prompt as a single paragraph of comma-separated phrases. No preface, no quotes, no explanation.",
    "",
    `Original prompt: ${prompt}`,
    "Rewritten prompt:"
  ].join("\n");
  const result = await qvac.complete({ prompt: instruction }, { ...(route ?? {}), capability: "llm" });
  const enhanced = String(result.value ?? "").trim().replace(/^["']|["']$/g, "");
  return { prompt: enhanced || prompt, route: result.route, provider: result.provider };
}

async function providerAdd(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const publicKey = String(body.publicKey ?? "").trim();
  if (!publicKey) throw new Error("Provider public key is required.");
  const provider: ProviderConfig = {
    id: uid(),
    name: String(body.name ?? "") || `Provider ${publicKey.slice(0, 8)}`,
    publicKey,
    capabilities: ((body.capabilities as Capability[] | undefined) ?? ["llm"]).filter(Boolean),
    lastStatus: "saved"
  };
  state.config.providers.push(provider);
  qvac.setConfig(state.config);
  await save();
  return { provider, state };
}

async function providerRemove(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = String(body.id ?? "");
  state.config.providers = state.config.providers.filter((provider) => provider.id !== id);
  qvac.setConfig(state.config);
  await save();
  return statePayload();
}

async function providerTest(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const provider = state.config.providers.find((candidate) => candidate.id === body.id);
  if (!provider) throw new Error("Provider not found.");
  provider.lastStatus = await qvac.testProvider(provider);
  provider.lastSeenAt = nowIso();
  await save();
  return { provider, state };
}

async function autoSetup(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requested = (body.capabilities as Capability[] | undefined) ?? ["llm", "embeddings", "transcription"];
  const defaults = structuredClone(defaultConfig);
  for (const capability of requested) {
    state.config.models[capability] = { ...defaults.models[capability], enabled: true };
  }
  await qvac.unloadAll();
  qvac.setConfig(state.config);
  await save();
  return statePayload();
}

async function resetConfig(): Promise<Record<string, unknown>> {
  state.config = structuredClone(defaultConfig);
  await qvac.unloadAll();
  qvac.setConfig(state.config);
  await save();
  return statePayload();
}

async function answerWithRag(question: string, route: RouteRequest): Promise<string> {
  if (state.chunks.length === 0) return "No local RAG chunks are available. Upload and ingest a txt/md document first.";
  const [queryEmbedding] = await qvac.embedTexts([question], { capability: "embeddings", mode: route.mode, providerId: route.providerId });
  const chunks = retrieveTopChunks(state.chunks, queryEmbedding ?? [], 3);
  const prompt = buildRagPrompt(question, chunks);
  const response = await qvac.complete({ prompt }, route);
  return `${response.value}\n\nSources:\n${formatSources(chunks)}`;
}

async function saveUploads(files: UploadInput[], bucket: string): Promise<string[]> {
  const paths: string[] = [];
  for (const file of files.filter(Boolean)) {
    const name = file.name || `upload-${Date.now()}`;
    const bytes = Buffer.from(file.dataBase64, "base64");
    paths.push(await store.writeBinary(bucket, name, bytes));
  }
  return paths;
}

async function save(): Promise<void> {
  await store.save(state);
}

async function galleryImages(): Promise<Record<string, unknown>> {
  const items = await Promise.all(
    (state.gallery ?? []).map(async (item) => {
      try {
        const bytes = await readFile(item.path);
        return { id: item.id, prompt: item.prompt, createdAt: item.createdAt, dataBase64: bytes.toString("base64") };
      } catch {
        return null;
      }
    })
  );
  return { images: items.filter(Boolean) };
}

function statePayload(): Record<string, unknown> {
  return {
    state,
    statuses: qvac.getStatuses(),
    providerPublicKey: qvac.getProviderPublicKey(),
    storageRoot: store.root
  };
}

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function writeJson(res: ServerResponse, statusCode: number, value: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

type UploadInput = {
  name: string;
  type?: string;
  dataBase64: string;
};
