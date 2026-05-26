const API_BASE = "http://localhost:38471";
const CAPABILITIES = ["llm", "embeddings", "multimodal", "transcription", "translation", "tts", "image"] as const;
const setupText: Record<Capability, string> = {
  llm: "Enable the LLM model and set modelSrc to a local GGUF path, QVAC registry constant, HTTP URL, pear:// URL, or supported registry ref.",
  embeddings: "Enable embeddings and configure a llama.cpp-compatible embedding model such as EMBEDDINGGEMMA_300M_Q4_0 or a local GGUF embedding model.",
  multimodal: "Enable multimodal and configure an image-capable LLM plus modelConfig.projectionModelSrc for the matching mmproj GGUF.",
  transcription: "Enable transcription and configure a Whisper or Parakeet model. WAV files are the most reliable input.",
  translation: "Enable translation with an NMT model, or leave disabled and use the local LLM fallback when the LLM is configured.",
  tts: "Enable TTS and provide all required ONNX TTS companion model sources plus a referenceAudioSrc when using Chatterbox.",
  image: "Enable image generation and configure a QVAC diffusion model. FLUX and SD families may require companion modelConfig sources."
};
let state: AppState;
let providerPublicKey: string | undefined;
let statuses: Array<{ state: string; message: string }> = [];
let mediaRecorder: MediaRecorder | undefined;
let recordedChunks: Blob[] = [];

void boot().catch((error) => {
  const target = document.querySelector("#status-cards");
  if (target) {
    target.innerHTML = `<article class="status-card"><span class="status-pill bad">Boot error</span><h3>Renderer failed</h3><p>${escapeHtml(errorMessage(error))}</p></article>`;
  }
});

async function boot(): Promise<void> {
  const target = document.querySelector("#status-cards");
  if (target) target.innerHTML = `<article class="status-card"><span class="status-pill">Booting</span><h3>Renderer active</h3><p>Connecting to local QVAC API...</p></article>`;
  await waitForState();
  bindNavigation();
  bindDashboard();
  bindSettings();
  bindChat();
  bindDocuments();
  bindMultimodal();
  bindAudio();
  bindTranslation();
  bindVoice();
  bindImages();
  bindMesh();
  renderAll();
}

async function waitForState(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      await refreshState();
      return;
    } catch (error) {
      lastError = error;
      const target = document.querySelector("#status-cards");
      if (target) {
        target.innerHTML = `<article class="status-card"><span class="status-pill">Booting</span><h3>Waiting for local API</h3><p>Attempt ${attempt}/30...</p></article>`;
      }
      await delay(300);
    }
  }
  throw lastError;
}

function bindNavigation(): void {
  qsa<HTMLButtonElement>(".tab").forEach((button) => {
    button.addEventListener("click", () => openView(button.dataset.view ?? "dashboard"));
  });
  qsa<HTMLButtonElement>("[data-jump]").forEach((button) => {
    button.addEventListener("click", () => openView(button.dataset.jump ?? "dashboard"));
  });
}

function bindDashboard(): void {
  qs("#refresh-dashboard").addEventListener("click", async () => {
    await refreshState();
    renderAll();
  });
}

function bindSettings(): void {
  qs("#save-config").addEventListener("click", async () => {
    try {
      for (const capability of CAPABILITIES) {
        const rawConfig = input(`#config-${capability}-json`, HTMLTextAreaElement).value.trim();
        state.config.models[capability] = {
          enabled: input(`#config-${capability}-enabled`, HTMLInputElement).checked,
          modelSrc: input(`#config-${capability}-src`).value.trim(),
          modelType: input(`#config-${capability}-type`).value.trim(),
          modelConfig: rawConfig ? (JSON.parse(rawConfig) as Record<string, unknown>) : {}
        };
      }
      await api("/config/save", { config: state.config });
      await refreshState();
      renderAll();
      toast("Model config saved.");
    } catch (error) {
      toast(errorMessage(error));
    }
  });
}

function bindChat(): void {
  input("#chat-form", HTMLFormElement).addEventListener("submit", async (event) => {
    event.preventDefault();
    const prompt = input("#chat-input", HTMLTextAreaElement).value.trim();
    if (!prompt) return;
    input("#chat-input", HTMLTextAreaElement).value = "";
    const mode = input("#chat-mode", HTMLSelectElement).value;
    const node = appendMessage("assistant", "Running...", "");
    try {
      if (mode === "rag") {
        const response = await api("/rag/answer", { question: prompt, route: routeFromSelect("chat-route", "llm", "chat-provider") });
        node.content.textContent = String(response.answer);
      } else {
        const files = mode === "multimodal" ? await filesToUploads(input("#chat-image", HTMLInputElement).files) : [];
        const capability: Capability = files.length ? "multimodal" : "llm";
        const response = await api("/chat/complete", {
          prompt,
          attachments: files,
          route: routeFromSelect("chat-route", capability, "chat-provider")
        });
        state = response.state as AppState;
        const message = response.message as ChatMessage;
        node.content.textContent = message.content;
        node.meta.textContent = message.providerPublicKey ? `${message.route} · ${message.providerPublicKey}` : message.route ?? "";
      }
      await refreshState();
      renderDashboard();
    } catch (error) {
      showError(node.content, error);
    } finally {
      input("#chat-image", HTMLInputElement).value = "";
    }
  });
}

function bindDocuments(): void {
  input("#ingest-form", HTMLFormElement).addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = input("#doc-file", HTMLInputElement).files?.[0];
    if (!file) return;
    const result = qs("#rag-answer");
    result.textContent = "Embedding document with QVAC...";
    try {
      const response = await api("/documents/ingest", {
        name: file.name,
        text: await file.text(),
        route: routeFromSelect("rag-route", "embeddings")
      });
      state = response.state as AppState;
      renderDocuments();
      result.textContent = `Ingested ${file.name}: ${response.chunks} chunks stored locally.`;
    } catch (error) {
      showError(result, error);
    }
  });

  input("#rag-form", HTMLFormElement).addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = input("#rag-question", HTMLTextAreaElement).value.trim();
    if (!question) return;
    const result = qs("#rag-answer");
    result.textContent = "Retrieving chunks and asking QVAC...";
    try {
      const response = await api("/rag/answer", { question, route: routeFromSelect("rag-route", "llm") });
      result.textContent = String(response.answer);
    } catch (error) {
      showError(result, error);
    }
  });
}

function bindMultimodal(): void {
  input("#multimodal-form", HTMLFormElement).addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = qs("#multimodal-result");
    result.textContent = "Sending image prompt to QVAC...";
    try {
      const response = await api("/multimodal", {
        prompt: input("#multimodal-prompt", HTMLTextAreaElement).value.trim(),
        attachments: await filesToUploads(input("#multimodal-images", HTMLInputElement).files, 2),
        route: routeFromSelect("multimodal-route", "multimodal", "multimodal-provider")
      });
      result.textContent = String(response.answer);
    } catch (error) {
      showError(result, error);
    }
  });
}

function bindAudio(): void {
  input("#audio-form", HTMLFormElement).addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = input("#audio-file", HTMLInputElement).files?.[0];
    if (!file) return;
    const result = qs("#audio-result");
    result.textContent = "Transcribing with QVAC...";
    try {
      const response = await api("/audio/transcribe", {
        file: (await filesToUploads([file]))[0],
        route: routeFromSelect("audio-route", "transcription")
      });
      state = response.state as AppState;
      result.textContent = String(response.text);
    } catch (error) {
      showError(result, error);
    }
  });

  qs("#summarize-transcript").addEventListener("click", () => runTranscriptPrompt("Summarize this transcript clearly."));
  qs("#transcript-actions").addEventListener("click", () => runTranscriptPrompt("Extract concise action items from this transcript."));
  qs("#transcript-to-rag").addEventListener("click", async () => {
    const result = qs("#audio-result");
    try {
      const response = await api("/audio/transcript-to-rag", {});
      state = response.state as AppState;
      renderDocuments();
      result.textContent = String(response.answer);
    } catch (error) {
      showError(result, error);
    }
  });
}

function bindTranslation(): void {
  qs("#translate-last-chat").addEventListener("click", () => {
    input("#translation-input", HTMLTextAreaElement).value = [...state.chat].reverse().find((message) => message.role === "assistant")?.content ?? "";
  });
  qs("#translate-last-transcript").addEventListener("click", () => {
    input("#translation-input", HTMLTextAreaElement).value = state.transcripts.at(-1)?.text ?? "";
  });
  qs("#translate-last-document").addEventListener("click", () => {
    const latest = state.chunks.filter((chunk) => chunk.documentId === state.documents.at(-1)?.id).map((chunk) => chunk.text).join("\n\n");
    input("#translation-input", HTMLTextAreaElement).value = latest.slice(0, 8000);
  });
  input("#translation-form", HTMLFormElement).addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = qs("#translation-result");
    result.textContent = "Translating with QVAC...";
    try {
      const response = await api("/translate", {
        text: input("#translation-input", HTMLTextAreaElement).value,
        from: input("#translation-from").value,
        to: input("#translation-to").value,
        route: routeFromSelect("translation-route", "translation")
      });
      result.textContent = String(response.answer);
    } catch (error) {
      showError(result, error);
    }
  });
}

function bindVoice(): void {
  qs("#voice-record").addEventListener("click", async () => {
    recordedChunks = [];
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) recordedChunks.push(event.data);
    });
    mediaRecorder.start();
    input("#voice-record", HTMLButtonElement).disabled = true;
    input("#voice-stop", HTMLButtonElement).disabled = false;
  });
  qs("#voice-stop").addEventListener("click", async () => {
    if (!mediaRecorder) return;
    const done = new Promise<void>((resolve) => mediaRecorder?.addEventListener("stop", () => resolve(), { once: true }));
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach((track) => track.stop());
    await done;
    input("#voice-record", HTMLButtonElement).disabled = false;
    input("#voice-stop", HTMLButtonElement).disabled = true;
    await runVoiceTurn();
  });
}

function bindImages(): void {
  input("#image-form", HTMLFormElement).addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const response = await api("/image/generate", {
        prompt: input("#image-prompt", HTMLTextAreaElement).value,
        width: Number(input("#image-width").value),
        height: Number(input("#image-height").value),
        steps: Number(input("#image-steps").value),
        route: routeFromSelect("image-route", "image")
      });
      state = response.state as AppState;
      renderGallery(response.images as GeneratedImage[]);
    } catch (error) {
      toast(errorMessage(error));
    }
  });
}

function bindMesh(): void {
  qs("#start-provider").addEventListener("click", async () => {
    const target = qs("#provider-public-key");
    target.textContent = "Starting provider...";
    try {
      const response = await api("/provider/start", {});
      providerPublicKey = String(response.publicKey ?? "");
      target.textContent = providerPublicKey;
      await refreshState();
      renderDashboard();
    } catch (error) {
      showError(target, error);
    }
  });
  qs("#stop-provider").addEventListener("click", async () => {
    await api("/provider/stop", {});
    providerPublicKey = undefined;
    qs("#provider-public-key").textContent = "Provider not running.";
    renderDashboard();
  });
  input("#provider-form", HTMLFormElement).addEventListener("submit", async (event) => {
    event.preventDefault();
    const response = await api("/provider/add", {
      name: input("#provider-name").value,
      publicKey: input("#provider-key").value,
      capabilities: parseCapabilities(input("#provider-capabilities").value)
    });
    state = response.state as AppState;
    renderAll();
  });
}

function renderAll(): void {
  renderRouteSelectors();
  renderConfig();
  renderDashboard();
  renderDocuments();
  renderProviders();
  renderGallery();
  renderChat();
}

function renderDashboard(): void {
  const enabled = CAPABILITIES.filter((capability) => state.config.models[capability].enabled);
  const cards = [
    { title: "Device", pill: "local-first", body: [`Storage: local app storage`, `Provider: ${providerPublicKey ?? "stopped"}`] },
    {
      title: "Models",
      pill: enabled.length ? `${enabled.length} enabled` : "setup needed",
      warn: enabled.length === 0,
      body: enabled.length ? enabled.map((capability) => `${capability}: ${state.config.models[capability].modelSrc}`) : CAPABILITIES.map((capability) => setupText[capability])
    },
    {
      title: "Mesh",
      pill: `${state.config.providers.length} providers`,
      body: state.config.providers.length ? state.config.providers.map((provider) => `${provider.name}: ${provider.capabilities.join(", ")}`) : ["Add provider public keys to delegate inference."]
    }
  ];
  qs("#status-cards").innerHTML = cards.map((card) => `<article class="status-card">
    <span class="status-pill ${card.warn ? "warn" : ""}">${escapeHtml(card.pill)}</span>
    <h3>${escapeHtml(card.title)}</h3>
    ${card.body.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
  </article>`).join("");
  if (statuses.length) {
    qs("#status-cards").insertAdjacentHTML("beforeend", `<article class="status-card">
      <span class="status-pill">QVAC runtime</span>
      <h3>Loading state</h3>
      ${statuses.slice(-5).map((status) => `<p>${escapeHtml(status.state)}: ${escapeHtml(status.message)}</p>`).join("")}
    </article>`);
  }
}

function renderConfig(): void {
  qs("#config-grid").innerHTML = CAPABILITIES.map((capability) => {
    const model = state.config.models[capability];
    return `<section class="panel config-card">
      <h3>${escapeHtml(capability)}</h3>
      <label><input id="config-${capability}-enabled" type="checkbox" ${model.enabled ? "checked" : ""} /> Enabled</label>
      <label>modelSrc <input id="config-${capability}-src" value="${escapeAttr(model.modelSrc)}" /></label>
      <label>modelType <input id="config-${capability}-type" value="${escapeAttr(model.modelType)}" /></label>
      <label>modelConfig JSON <textarea id="config-${capability}-json">${escapeHtml(JSON.stringify(model.modelConfig, null, 2))}</textarea></label>
      <p class="hint">${escapeHtml(setupText[capability])}</p>
    </section>`;
  }).join("");
}

function renderRouteSelectors(): void {
  for (const id of ["chat-route", "rag-route", "multimodal-route", "audio-route", "translation-route", "voice-route", "image-route"]) {
    input(`#${id}`, HTMLSelectElement).innerHTML = ["local", "provider", "auto", "fallback"]
      .map((mode) => `<option value="${mode}">${mode}</option>`)
      .join("");
  }
  for (const id of ["chat-provider", "multimodal-provider"]) {
    input(`#${id}`, HTMLSelectElement).innerHTML = `<option value="">First capable provider</option>${state.config.providers.map((provider) => `<option value="${provider.id}">${escapeHtml(provider.name)}</option>`).join("")}`;
  }
}

function renderDocuments(): void {
  qs("#documents-list").innerHTML = state.documents.length
    ? state.documents.map((document) => `<div class="list-item"><strong>${escapeHtml(document.name)}</strong><span>${document.chunkIds.length} chunks · ${escapeHtml(document.createdAt)}</span></div>`).join("")
    : `<div class="list-item">No documents ingested yet.</div>`;
}

function renderProviders(): void {
  qs("#providers-list").innerHTML = state.config.providers.length
    ? state.config.providers.map((provider) => `<div class="list-item">
      <strong>${escapeHtml(provider.name)}</strong>
      <span>${escapeHtml(provider.publicKey)}</span>
      <span>${escapeHtml(provider.capabilities.join(", "))}</span>
      <div class="actions">
        <button data-test-provider="${provider.id}">Test completion</button>
        <button data-remove-provider="${provider.id}">Remove</button>
      </div>
      <span>${escapeHtml(provider.lastStatus ?? "")}</span>
    </div>`).join("")
    : `<div class="list-item">No remote providers registered.</div>`;
  qsa<HTMLButtonElement>("[data-test-provider]").forEach((button) => button.addEventListener("click", async () => {
    const response = await api("/provider/test", { id: button.dataset.testProvider });
    state = response.state as AppState;
    renderProviders();
  }));
  qsa<HTMLButtonElement>("[data-remove-provider]").forEach((button) => button.addEventListener("click", async () => {
    const response = await api("/provider/remove", { id: button.dataset.removeProvider });
    state = response.state as AppState;
    renderAll();
  }));
}

function renderGallery(images?: GeneratedImage[]): void {
  const generated = images?.map((image) => ({ prompt: image.prompt, src: `data:image/png;base64,${image.dataBase64}` })) ?? [];
  qs("#gallery").innerHTML = generated.map((image) => `<figure><img src="${image.src}" alt="${escapeAttr(image.prompt)}" /><figcaption>${escapeHtml(image.prompt)}</figcaption></figure>`).join("");
}

function renderChat(): void {
  const log = qs("#chat-log");
  log.innerHTML = "";
  for (const message of state.chat.slice(-30)) appendMessage(message.role, message.content, message.route ?? message.at);
}

async function runTranscriptPrompt(instruction: string): Promise<void> {
  const result = qs("#audio-result");
  result.textContent = "Asking QVAC...";
  try {
    const response = await api("/audio/transcript-prompt", { instruction, route: routeFromSelect("audio-route", "llm") });
    result.textContent = String(response.answer);
  } catch (error) {
    showError(result, error);
  }
}

async function runVoiceTurn(): Promise<void> {
  const entry = appendVoice("Running voice assistant...");
  try {
    const blob = new Blob(recordedChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
    const response = await api("/voice/turn", { file: (await filesToUploads([new File([blob], `voice-${Date.now()}.webm`, { type: blob.type })]))[0], route: routeFromSelect("voice-route", "llm") });
    const turn = response.turn as { transcript: string; response: string };
    entry.textContent = `You: ${turn.transcript}\n\nAssistant: ${turn.response}`;
    new Audio(`data:audio/wav;base64,${response.audioBase64}`).play().catch(() => undefined);
  } catch (error) {
    showError(entry, error);
  }
}

async function refreshState(): Promise<void> {
  const response = await api("/state");
  state = response.state as AppState;
  providerPublicKey = response.providerPublicKey as string | undefined;
  statuses = (response.statuses as typeof statuses | undefined) ?? [];
}

async function api(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok || data.ok === false) throw new Error(String(data.error ?? response.statusText));
  return data;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function filesToUploads(files: FileList | File[] | null, limit = Infinity): Promise<UploadInput[]> {
  const selected = [...(files ?? [])].slice(0, limit);
  return await Promise.all(selected.map(async (file) => ({
    name: file.name,
    type: file.type,
    dataBase64: arrayBufferToBase64(await file.arrayBuffer())
  })));
}

function routeFromSelect(selectId: string, capability: Capability, providerSelectId?: string): RouteRequest {
  return {
    capability,
    mode: input(`#${selectId}`, HTMLSelectElement).value as RouteMode,
    providerId: providerSelectId ? input(`#${providerSelectId}`, HTMLSelectElement).value || undefined : undefined
  };
}

function parseCapabilities(value: string): Capability[] {
  const parsed = value.split(",").map((item) => item.trim()).filter((item): item is Capability => CAPABILITIES.includes(item as Capability));
  return parsed.length ? parsed : ["llm"];
}

function appendMessage(role: "user" | "assistant", content: string, meta: string): { content: HTMLElement; meta: HTMLElement } {
  const wrapper = document.createElement("article");
  wrapper.className = "message";
  const strong = document.createElement("strong");
  strong.textContent = role === "user" ? "You" : "QVAC";
  const contentNode = document.createElement("div");
  contentNode.textContent = content;
  const metaNode = document.createElement("div");
  metaNode.className = "meta";
  metaNode.textContent = meta;
  wrapper.append(strong, contentNode, metaNode);
  qs("#chat-log").append(wrapper);
  wrapper.scrollIntoView({ block: "end" });
  return { content: contentNode, meta: metaNode };
}

function appendVoice(content: string): HTMLElement {
  const node = document.createElement("article");
  node.className = "message";
  node.textContent = content;
  qs("#voice-log").append(node);
  return node;
}

function openView(id: string): void {
  qsa<HTMLButtonElement>(".tab").forEach((button) => button.classList.toggle("active", button.dataset.view === id));
  qsa<HTMLElement>(".view").forEach((view) => view.classList.toggle("active", view.id === id));
}

function showError(target: Element, error: unknown): void {
  target.textContent = errorMessage(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toast(message: string): void {
  const node = qs("#toast");
  node.textContent = message;
  node.classList.add("visible");
  setTimeout(() => node.classList.remove("visible"), 4200);
}

function qs<T extends Element = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing element ${selector}`);
  return node;
}

function qsa<T extends Element = HTMLElement>(selector: string): T[] {
  return [...document.querySelectorAll<T>(selector)];
}

function input<T extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLFormElement | HTMLButtonElement = HTMLInputElement>(
  selector: string,
  ctor?: { new (): T }
): T {
  const node = qs<T>(selector);
  if (ctor && !(node instanceof ctor)) throw new Error(`Expected ${selector} to be ${ctor.name}`);
  return node;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary);
}

type UploadInput = {
  name: string;
  type?: string;
  dataBase64: string;
};

type GeneratedImage = {
  prompt: string;
  dataBase64: string;
};

type Capability = (typeof CAPABILITIES)[number];
type RouteMode = "local" | "provider" | "auto" | "fallback";
type RouteRequest = {
  capability: Capability;
  mode: RouteMode;
  providerId?: string;
};
type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  at: string;
  route?: string;
  providerPublicKey?: string;
  attachments?: string[];
};
type ProviderConfig = {
  id: string;
  name: string;
  publicKey: string;
  capabilities: Capability[];
  lastStatus?: string;
};
type AppState = {
  config: {
    models: Record<Capability, { enabled: boolean; modelSrc: string; modelType: string; modelConfig: Record<string, unknown> }>;
    providers: ProviderConfig[];
    defaultRoute: RouteMode;
  };
  chat: ChatMessage[];
  documents: Array<{ id: string; name: string; chunkIds: string[]; createdAt: string }>;
  chunks: Array<{ documentId: string; text: string }>;
  transcripts: Array<{ text: string }>;
};
