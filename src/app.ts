const API_BASE = "http://localhost:38471";
const CAPABILITIES = ["llm", "embeddings", "multimodal", "transcription", "translation", "tts", "image"] as const;

const setupText: Record<Capability, string> = {
  llm: "Enable the LLM and set modelSrc to a QVAC registry constant (e.g. QWEN3_600M_INST_Q4), local GGUF path, HTTP URL, or pear:// URL.",
  embeddings: "Enable embeddings with a llama.cpp embedding model such as EMBEDDINGGEMMA_300M_Q4_0 or a local GGUF embedding model.",
  multimodal: "Enable multimodal with an image-capable LLM plus modelConfig.projectionModelSrc for the matching mmproj GGUF.",
  transcription: "Enable transcription with a Whisper or Parakeet model. WAV files are the most reliable input.",
  translation: "Enable translation with an NMT model, or rely on the LLM fallback when the LLM is configured.",
  tts: "Enable TTS and provide all required ONNX TTS companion model sources plus a referenceAudioSrc when using Chatterbox.",
  image: "Enable image generation with a QVAC diffusion model. FLUX and SD families may require companion modelConfig sources."
};

let state: AppState;
let providerPublicKey: string | undefined;
let statuses: ModelLoadStatus[] = [];
let mediaRecorder: MediaRecorder | undefined;
let recordedChunks: Blob[] = [];

void boot().catch((error) => {
  const target = document.querySelector("#status-cards");
  if (target) {
    target.innerHTML = `<article class="status-card"><span class="status-pill bad">Boot error</span><h3>Renderer failed</h3><p>${escapeHtml(errorMessage(error))}</p></article>`;
  }
});

async function boot(): Promise<void> {
  setApiStatus("connecting", "Connecting...");
  await waitForState();
  setApiStatus("online", "API ready");
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
      setApiStatus("connecting", `Waiting for local API (${attempt}/30)`);
      await delay(300);
    }
  }
  setApiStatus("offline", "API offline");
  throw lastError;
}

function setApiStatus(state: "connecting" | "online" | "offline", label: string): void {
  const dot = document.querySelector<HTMLElement>("#api-dot");
  const labelNode = document.querySelector<HTMLElement>("#api-label");
  const titlebarStatus = document.querySelector<HTMLElement>("#titlebar-status");
  if (dot) dot.className = `status-dot ${state === "online" ? "online" : state === "offline" ? "offline" : ""}`;
  if (labelNode) labelNode.textContent = label;
  if (titlebarStatus) titlebarStatus.textContent = label;
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
    toast("Refreshed.");
  });
  const quickSetup = async (): Promise<void> => {
    try {
      toast("Enabling small defaults — models will auto-download on first use.");
      const response = await api("/config/auto-setup", { capabilities: ["llm", "embeddings", "transcription"] });
      applyStatePayload(response);
      renderAll();
      toast("Defaults enabled. Try the Chat tab now.");
    } catch (error) {
      toast(errorMessage(error));
    }
  };
  qs("#quick-setup").addEventListener("click", quickSetup);
  qs("#quick-setup-banner").addEventListener("click", quickSetup);
  qs("#clear-progress").addEventListener("click", () => {
    statuses = [];
    renderProgress();
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
      const response = await api("/config/save", { config: state.config });
      applyStatePayload(response);
      renderAll();
      toast("Model config saved.");
    } catch (error) {
      toast(errorMessage(error));
    }
  });
  qs("#reset-config").addEventListener("click", async () => {
    if (!confirm("Reset every capability to defaults? Your provider list will be kept.")) return;
    try {
      const providers = state.config.providers;
      const response = await api("/config/reset", {});
      applyStatePayload(response);
      if (providers.length) {
        for (const provider of providers) {
          await api("/provider/add", { name: provider.name, publicKey: provider.publicKey, capabilities: provider.capabilities });
        }
        await refreshState();
      }
      renderAll();
      toast("Reset to defaults.");
    } catch (error) {
      toast(errorMessage(error));
    }
  });
}

function bindChat(): void {
  const fileInput = input("#chat-image", HTMLInputElement);
  fileInput.addEventListener("change", () => {
    const label = qs("#chat-image-label");
    const count = fileInput.files?.length ?? 0;
    label.textContent = count > 0 ? `${count} image${count > 1 ? "s" : ""}` : "Attach";
  });

  const form = input("#chat-form", HTMLFormElement);
  const sendButton = form.querySelector<HTMLButtonElement>("button[type=submit]");
  let inFlight = false;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (inFlight) return;
    const promptValue = input("#chat-input", HTMLTextAreaElement).value.trim();
    if (!promptValue) return;
    inFlight = true;
    if (sendButton) sendButton.disabled = true;
    input("#chat-input", HTMLTextAreaElement).value = "";
    const mode = input("#chat-mode", HTMLSelectElement).value;
    const files = mode === "multimodal" ? await filesToUploads(fileInput.files) : [];
    const capability: Capability = mode === "multimodal" || files.length ? "multimodal" : "llm";
    const route = routeFromSelect("chat-route", capability, "chat-provider");

    appendMessage({ role: "user", content: promptValue });
    const assistantNode = appendMessage({ role: "assistant", content: "", streaming: true });

    try {
      await streamChat(
        {
          prompt: promptValue,
          mode,
          attachments: files,
          route
        },
        {
          onToken: (text) => {
            assistantNode.appendText(text);
          },
          onStatus: (status) => {
            statuses = [...statuses.filter((entry) => entry.key !== status.key), status];
            renderProgress();
            if (status.state === "loading") {
              assistantNode.setPlaceholder(status.message);
            }
          },
          onDone: (message) => {
            assistantNode.finalize({
              content: message.content,
              meta: message.providerPublicKey ? `${message.route ?? ""} · ${shortKey(message.providerPublicKey)}` : message.route ?? ""
            });
          }
        }
      );
      await refreshState();
      renderDashboard();
    } catch (error) {
      assistantNode.setError(errorMessage(error));
    } finally {
      fileInput.value = "";
      qs("#chat-image-label").textContent = "Attach";
      inFlight = false;
      if (sendButton) sendButton.disabled = false;
    }
  });

  qs("#chat-new-session").addEventListener("click", async () => {
    if (inFlight) {
      toast("Wait for the current reply to finish.");
      return;
    }
    if (!confirm("Start a new chat session? Current history will be cleared.")) return;
    try {
      const response = await api("/chat/clear", {});
      applyStatePayload(response);
      renderChat();
      toast("New session started.");
    } catch (error) {
      toast(errorMessage(error));
    }
  });

  input("#chat-input", HTMLTextAreaElement).addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      input("#chat-form", HTMLFormElement).requestSubmit();
    }
  });
}

type StreamHandlers = {
  onToken: (text: string) => void;
  onStatus: (status: ModelLoadStatus) => void;
  onDone: (message: ChatMessage) => void;
};

async function streamChat(
  body: { prompt: string; mode: string; attachments: UploadInput[]; route: RouteRequest },
  handlers: StreamHandlers
): Promise<void> {
  const response = await fetch(`${API_BASE}/chat/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.body) throw new Error("Streaming not supported by this runtime.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let errorMsg: string | undefined;
  let assistantMessage: ChatMessage | undefined;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      switch (event.type) {
        case "token":
          handlers.onToken(String(event.text ?? ""));
          break;
        case "status":
          handlers.onStatus(event.status as ModelLoadStatus);
          break;
        case "info":
          handlers.onStatus({ key: "info", state: "loading", message: String(event.message ?? "") });
          break;
        case "done":
          assistantMessage = event.message as ChatMessage;
          if (event.state) state = event.state as AppState;
          break;
        case "user":
          break;
        case "error":
          errorMsg = String(event.error ?? "Unknown error");
          break;
      }
    }
  }
  if (errorMsg) throw new Error(errorMsg);
  if (assistantMessage) handlers.onDone(assistantMessage);
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
        route: routeFromSelect("rag-route", "embeddings", "rag-provider")
      });
      state = response.state as AppState;
      renderDocuments();
      result.textContent = `Ingested ${file.name}: ${response.chunks} chunks stored locally.`;
    } catch (error) {
      showError(result, error);
    }
  });

  qs("#clear-documents").addEventListener("click", async () => {
    if (!state.documents.length) return;
    if (!confirm(`Remove all ${state.documents.length} ingested document(s) and their chunks?`)) return;
    try {
      const response = await api("/documents/clear", {});
      applyStatePayload(response);
      renderDocuments();
      qs("#rag-answer").textContent = "All documents cleared.";
    } catch (error) {
      toast(errorMessage(error));
    }
  });

  input("#rag-form", HTMLFormElement).addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = input("#rag-question", HTMLTextAreaElement).value.trim();
    if (!question) return;
    const result = qs("#rag-answer");
    result.textContent = "Retrieving chunks and asking QVAC...";
    try {
      const response = await api("/rag/answer", { question, route: routeFromSelect("rag-route", "llm", "rag-provider") });
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
        route: routeFromSelect("audio-route", "transcription", "audio-provider")
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
        route: routeFromSelect("translation-route", "translation", "translation-provider")
      });
      result.textContent = String(response.answer);
    } catch (error) {
      showError(result, error);
    }
  });
}

function bindVoice(): void {
  qs("#voice-record").addEventListener("click", async () => {
    try {
      recordedChunks = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) recordedChunks.push(event.data);
      });
      mediaRecorder.start();
      input("#voice-record", HTMLButtonElement).disabled = true;
      input("#voice-stop", HTMLButtonElement).disabled = false;
    } catch (error) {
      toast(errorMessage(error));
    }
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
  const form = input("#image-form", HTMLFormElement);
  const button = input("#image-generate", HTMLButtonElement);
  const progress = qs<HTMLElement>("#image-progress");
  const fill = qs<HTMLElement>("#image-progress-fill");
  const label = qs<HTMLElement>("#image-progress-label");
  let inFlight = false;

  const setProgress = (percent: number, text: string): void => {
    progress.hidden = false;
    fill.style.width = `${Math.max(2, Math.min(100, percent))}%`;
    label.textContent = text;
  };
  const resetProgress = (): void => {
    progress.hidden = true;
    fill.style.width = "0%";
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (inFlight) return;
    const prompt = input("#image-prompt", HTMLTextAreaElement).value.trim();
    if (!prompt) return;
    inFlight = true;
    button.disabled = true;
    setProgress(2, "Preparing…");
    try {
      await streamImage(
        {
          prompt,
          width: Number(input("#image-width").value),
          height: Number(input("#image-height").value),
          steps: Number(input("#image-steps").value),
          route: routeFromSelect("image-route", "image", "image-provider")
        },
        {
          onStatus: (status) => {
            statuses = [...statuses.filter((entry) => entry.key !== status.key), status];
            renderProgress();
            if (status.state === "loading") setProgress(5, status.message);
          },
          onProgress: (step, total, elapsedMs) => {
            const pct = total > 0 ? Math.round((step / total) * 100) : 0;
            setProgress(pct, `Step ${step}/${total} · ${(elapsedMs / 1000).toFixed(1)}s`);
          },
          onDone: (images) => {
            state.gallery = [
              ...images.map((image) => ({ prompt: image.prompt, dataBase64: image.dataBase64 })),
              ...(state.gallery ?? [])
            ];
            renderGallery(images);
            setProgress(100, "Done");
            setTimeout(resetProgress, 800);
          }
        }
      );
    } catch (error) {
      resetProgress();
      toast(errorMessage(error));
    } finally {
      inFlight = false;
      button.disabled = false;
    }
  });
}

type ImageStreamHandlers = {
  onStatus: (status: ModelLoadStatus) => void;
  onProgress: (step: number, total: number, elapsedMs: number) => void;
  onDone: (images: GeneratedImage[]) => void;
};

async function streamImage(
  body: { prompt: string; width: number; height: number; steps: number; route: RouteRequest },
  handlers: ImageStreamHandlers
): Promise<void> {
  const response = await fetch(`${API_BASE}/image/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.body) throw new Error("Streaming not supported by this runtime.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let errorMsg: string | undefined;
  let imageList: GeneratedImage[] | undefined;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      switch (event.type) {
        case "status":
          handlers.onStatus(event.status as ModelLoadStatus);
          break;
        case "progress":
          handlers.onProgress(Number(event.step ?? 0), Number(event.totalSteps ?? 0), Number(event.elapsedMs ?? 0));
          break;
        case "done":
          imageList = event.images as GeneratedImage[];
          if (event.state) state = event.state as AppState;
          break;
        case "error":
          errorMsg = String(event.error ?? "Unknown error");
          break;
      }
    }
  }
  if (errorMsg) throw new Error(errorMsg);
  if (imageList) handlers.onDone(imageList);
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
    try {
      await api("/provider/stop", {});
      providerPublicKey = undefined;
      qs("#provider-public-key").textContent = "Provider not running.";
      renderDashboard();
    } catch (error) {
      toast(errorMessage(error));
    }
  });
  renderProviderCapabilityCheckboxes();
  input("#provider-form", HTMLFormElement).addEventListener("submit", async (event) => {
    event.preventDefault();
    const checked = qsa<HTMLInputElement>("#provider-capabilities input[type=checkbox]:checked")
      .map((node) => node.value)
      .filter((value): value is Capability => CAPABILITIES.includes(value as Capability));
    if (checked.length === 0) {
      toast("Select at least one capability for the provider.");
      return;
    }
    const response = await api("/provider/add", {
      name: input("#provider-name").value,
      publicKey: input("#provider-key").value,
      capabilities: checked
    });
    state = response.state as AppState;
    input("#provider-name", HTMLInputElement).value = "";
    input("#provider-key", HTMLInputElement).value = "";
    renderProviderCapabilityCheckboxes();
    renderAll();
  });
}

function renderProviderCapabilityCheckboxes(): void {
  const root = document.querySelector<HTMLElement>("#provider-capabilities");
  if (!root) return;
  const legend = root.querySelector("legend")?.outerHTML ?? "<legend>Capabilities this provider offers</legend>";
  root.innerHTML =
    legend +
    CAPABILITIES.map(
      (capability) =>
        `<label class="capability-checkbox"><input type="checkbox" value="${capability}" /> ${escapeHtml(capability)}</label>`
    ).join("");
}

function renderAll(): void {
  renderRouteSelectors();
  renderConfig();
  renderDashboard();
  renderDocuments();
  renderProviders();
  renderGallery();
  renderChat();
  renderProgress();
  renderOnboarding();
}

function renderOnboarding(): void {
  const banner = qs("#onboarding-banner");
  const enabled = CAPABILITIES.filter((capability) => state.config.models[capability].enabled);
  banner.classList.toggle("hidden", enabled.length > 0);
}

function renderDashboard(): void {
  const enabled = CAPABILITIES.filter((capability) => state.config.models[capability].enabled);
  const cards = [
    {
      title: "Device",
      pill: providerPublicKey ? "provider on" : "local",
      pillKind: providerPublicKey ? "ok" : "",
      body: ["Storage: local app storage", providerPublicKey ? `Provider key: ${shortKey(providerPublicKey)}` : "Provider not running."]
    },
    {
      title: "Models",
      pill: enabled.length ? `${enabled.length} enabled` : "setup needed",
      pillKind: enabled.length ? "ok" : "warn",
      body: enabled.length
        ? enabled.map((capability) => `${capability}: ${state.config.models[capability].modelSrc}`)
        : ["No capabilities enabled.", "Click Quick setup to load small defaults."]
    },
    {
      title: "Mesh",
      pill: `${state.config.providers.length} provider${state.config.providers.length === 1 ? "" : "s"}`,
      pillKind: state.config.providers.length ? "ok" : "",
      body: state.config.providers.length
        ? state.config.providers.map((provider) => `${provider.name}: ${provider.capabilities.join(", ")}`)
        : ["Add provider public keys to delegate inference."]
    }
  ];
  qs("#status-cards").innerHTML = cards
    .map(
      (card) => `<article class="status-card">
    <span class="status-pill ${escapeAttr(card.pillKind)}">${escapeHtml(card.pill)}</span>
    <h3>${escapeHtml(card.title)}</h3>
    ${card.body.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
  </article>`
    )
    .join("");
}

function renderProgress(): void {
  const panel = qs<HTMLElement>("#model-progress-panel");
  const list = qs("#model-progress-list");
  const recent = statuses.slice(-6);
  if (recent.length === 0) {
    panel.hidden = true;
    list.innerHTML = "";
    return;
  }
  panel.hidden = false;
  list.innerHTML = recent
    .map(
      (status) => `<div class="progress-row">
      <span class="progress-label">${escapeHtml(labelForStatus(status))}</span>
      <span class="progress-msg" title="${escapeAttr(status.message)}">${escapeHtml(status.message)}</span>
      <span class="progress-state ${escapeAttr(status.state)}">${escapeHtml(status.state)}</span>
    </div>`
    )
    .join("");
}

function labelForStatus(status: ModelLoadStatus): string {
  try {
    const parsed = JSON.parse(status.key) as { capability?: string };
    if (parsed.capability) return parsed.capability;
  } catch {
    // fall through
  }
  return status.key === "info" ? "info" : "model";
}

function renderConfig(): void {
  qs("#config-grid").innerHTML = CAPABILITIES.map((capability) => {
    const model = state.config.models[capability];
    return `<section class="panel config-card">
      <h3>${escapeHtml(capability)} <span class="cap-pill ${model.enabled ? "on" : ""}">${model.enabled ? "enabled" : "off"}</span></h3>
      <label class="enabled-row"><input id="config-${capability}-enabled" type="checkbox" ${model.enabled ? "checked" : ""} /> Enable this capability</label>
      <label>modelSrc<input id="config-${capability}-src" value="${escapeAttr(model.modelSrc)}" /></label>
      <label>modelType<input id="config-${capability}-type" value="${escapeAttr(model.modelType)}" /></label>
      <label>modelConfig JSON<textarea id="config-${capability}-json" spellcheck="false">${escapeHtml(JSON.stringify(model.modelConfig, null, 2))}</textarea></label>
      <p class="hint">${escapeHtml(setupText[capability])}</p>
    </section>`;
  }).join("");
}

function renderRouteSelectors(): void {
  for (const id of ["chat-route", "rag-route", "multimodal-route", "audio-route", "translation-route", "voice-route", "image-route"]) {
    const node = document.querySelector<HTMLSelectElement>(`#${id}`);
    if (!node) continue;
    const current = node.value || "local";
    node.innerHTML = ["local", "provider", "auto", "fallback"]
      .map((mode) => `<option value="${mode}" ${mode === current ? "selected" : ""}>${mode}</option>`)
      .join("");
  }
  for (const id of ["chat-provider", "multimodal-provider", "rag-provider", "audio-provider", "translation-provider", "voice-provider", "image-provider"]) {
    const node = document.querySelector<HTMLSelectElement>(`#${id}`);
    if (!node) continue;
    node.innerHTML = `<option value="">First capable</option>${state.config.providers
      .map((provider) => `<option value="${provider.id}">${escapeHtml(provider.name)}</option>`)
      .join("")}`;
  }
}

function renderDocuments(): void {
  qs("#documents-list").innerHTML = state.documents.length
    ? state.documents
        .map(
          (document) =>
            `<div class="list-item">
              <strong>${escapeHtml(document.name)}</strong>
              <span>${document.chunkIds.length} chunks · ${escapeHtml(document.createdAt)}</span>
              <div class="actions">
                <button data-remove-document="${escapeAttr(document.id)}" class="ghost small">Remove</button>
              </div>
            </div>`
        )
        .join("")
    : `<div class="list-item"><strong>No documents ingested yet.</strong><span>Upload a .txt or .md to enable RAG.</span></div>`;
  qsa<HTMLButtonElement>("[data-remove-document]").forEach((button) =>
    button.addEventListener("click", async () => {
      const id = button.dataset.removeDocument;
      if (!id) return;
      if (!confirm("Remove this document and its chunks?")) return;
      try {
        const response = await api("/documents/remove", { id });
        applyStatePayload(response);
        renderDocuments();
      } catch (error) {
        toast(errorMessage(error));
      }
    })
  );
}

function renderProviders(): void {
  qs("#providers-list").innerHTML = state.config.providers.length
    ? state.config.providers
        .map(
          (provider) => `<div class="list-item">
      <strong>${escapeHtml(provider.name)}</strong>
      <span>${escapeHtml(provider.publicKey)}</span>
      <span>Capabilities: ${escapeHtml(provider.capabilities.join(", "))}</span>
      <div class="actions">
        <button data-test-provider="${provider.id}">Test completion</button>
        <button data-remove-provider="${provider.id}" class="ghost">Remove</button>
      </div>
      ${provider.lastStatus ? `<span>${escapeHtml(provider.lastStatus)}</span>` : ""}
    </div>`
        )
        .join("")
    : `<div class="list-item"><strong>No remote providers registered.</strong><span>Paste a provider public key above to delegate inference.</span></div>`;
  qsa<HTMLButtonElement>("[data-test-provider]").forEach((button) =>
    button.addEventListener("click", async () => {
      try {
        const response = await api("/provider/test", { id: button.dataset.testProvider });
        state = response.state as AppState;
        renderProviders();
      } catch (error) {
        toast(errorMessage(error));
      }
    })
  );
  qsa<HTMLButtonElement>("[data-remove-provider]").forEach((button) =>
    button.addEventListener("click", async () => {
      const response = await api("/provider/remove", { id: button.dataset.removeProvider });
      state = response.state as AppState;
      renderAll();
    })
  );
}

function renderGallery(images?: GeneratedImage[]): void {
  const fromState = (state.gallery ?? []).slice(0, 12).map((image) => ({ prompt: image.prompt, src: "" }));
  const generated = images?.map((image) => ({ prompt: image.prompt, src: `data:image/png;base64,${image.dataBase64}` })) ?? [];
  const all = generated.length ? generated : fromState.filter((entry) => entry.src);
  qs("#gallery").innerHTML = all.length
    ? all
        .map(
          (image) =>
            `<figure><img src="${image.src}" alt="${escapeAttr(image.prompt)}" /><figcaption>${escapeHtml(image.prompt)}</figcaption></figure>`
        )
        .join("")
    : "";
}

function renderChat(): void {
  const log = qs("#chat-log");
  log.innerHTML = "";
  for (const message of state.chat.slice(-30)) {
    appendMessage({
      role: message.role,
      content: message.content,
      meta: message.providerPublicKey ? `${message.route ?? ""} · ${shortKey(message.providerPublicKey)}` : message.route ?? message.at
    });
  }
}

async function runTranscriptPrompt(instruction: string): Promise<void> {
  const result = qs("#audio-result");
  result.textContent = "Asking QVAC...";
  try {
    const response = await api("/audio/transcript-prompt", { instruction, route: routeFromSelect("audio-route", "llm", "audio-provider") });
    result.textContent = String(response.answer);
  } catch (error) {
    showError(result, error);
  }
}

async function runVoiceTurn(): Promise<void> {
  const entry = appendVoice("Running voice assistant...");
  try {
    const blob = new Blob(recordedChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
    const response = await api("/voice/turn", {
      file: (await filesToUploads([new File([blob], `voice-${Date.now()}.webm`, { type: blob.type })]))[0],
      route: routeFromSelect("voice-route", "llm", "voice-provider")
    });
    const turn = response.turn as { transcript: string; response: string };
    const note = response.ttsNote ? `\n\n(${response.ttsNote})` : "";
    entry.textContent = `You: ${turn.transcript}\n\nAssistant: ${turn.response}${note}`;
    if (response.audioBase64) {
      new Audio(`data:audio/wav;base64,${response.audioBase64}`).play().catch(() => undefined);
    }
  } catch (error) {
    showError(entry, error);
  }
}

async function refreshState(): Promise<void> {
  const response = await api("/state");
  applyStatePayload(response);
}

function applyStatePayload(response: Record<string, unknown>): void {
  state = response.state as AppState;
  providerPublicKey = (response.providerPublicKey as string | undefined) || undefined;
  const incoming = (response.statuses as ModelLoadStatus[] | undefined) ?? [];
  if (incoming.length) statuses = incoming;
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
  return await Promise.all(
    selected.map(async (file) => ({
      name: file.name,
      type: file.type,
      dataBase64: arrayBufferToBase64(await file.arrayBuffer())
    }))
  );
}

function routeFromSelect(selectId: string, capability: Capability, providerSelectId?: string): RouteRequest {
  return {
    capability,
    mode: input(`#${selectId}`, HTMLSelectElement).value as RouteMode,
    providerId: providerSelectId ? input(`#${providerSelectId}`, HTMLSelectElement).value || undefined : undefined
  };
}

type MessageHandle = {
  appendText: (text: string) => void;
  setPlaceholder: (text: string) => void;
  setError: (text: string) => void;
  finalize: (final: { content: string; meta?: string }) => void;
};

function appendMessage(options: { role: "user" | "assistant"; content: string; meta?: string; streaming?: boolean }): MessageHandle {
  const wrapper = document.createElement("article");
  wrapper.className = `message ${options.role}${options.streaming ? " streaming" : ""}`;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = options.role === "user" ? "You" : "Q";
  const body = document.createElement("div");
  body.style.flex = "1";
  body.style.minWidth = "0";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = options.content;
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = options.meta ?? "";
  body.append(bubble, meta);
  wrapper.append(avatar, body);
  const log = qs("#chat-log");
  log.append(wrapper);
  log.scrollTop = log.scrollHeight;

  let placeholderActive = options.streaming && !options.content;
  if (placeholderActive) bubble.textContent = "Thinking...";
  let accumulated = options.content;

  return {
    appendText(text) {
      if (placeholderActive) {
        bubble.textContent = "";
        accumulated = "";
        placeholderActive = false;
      }
      accumulated += text;
      bubble.textContent = accumulated;
      log.scrollTop = log.scrollHeight;
    },
    setPlaceholder(text) {
      if (placeholderActive) {
        bubble.textContent = text || "Thinking...";
        log.scrollTop = log.scrollHeight;
      }
    },
    setError(text) {
      wrapper.classList.remove("streaming");
      wrapper.classList.add("error");
      bubble.textContent = text;
      meta.textContent = "error";
    },
    finalize(final) {
      wrapper.classList.remove("streaming");
      bubble.textContent = final.content;
      meta.textContent = final.meta ?? "";
      log.scrollTop = log.scrollHeight;
    }
  };
}

function appendVoice(content: string): HTMLElement {
  const node = document.createElement("article");
  node.className = "message assistant";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "Q";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = content;
  node.append(avatar, bubble);
  qs("#voice-log").append(node);
  return bubble;
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

function shortKey(key: string): string {
  if (!key) return "";
  return key.length > 14 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key;
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
type ModelLoadStatus = {
  key: string;
  state: "idle" | "loading" | "loaded" | "error";
  message: string;
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
  voiceTurns: Array<unknown>;
  gallery: Array<{ prompt: string; dataBase64?: string }>;
};
