import * as qvac from "@qvac/sdk";
import type { CompletionEvent, LoadModelOptions, ModelProgressUpdate } from "@qvac/sdk";
import { setupText } from "./defaults.js";
import type {
  AppConfig,
  Capability,
  CompletionInput,
  ModelLoadStatus,
  ProviderConfig,
  RouteMode,
  RouteRequest,
  RoutedResult
} from "./types.js";

type ModelSource = string | Record<string, unknown>;
type ProgressListener = (status: ModelLoadStatus) => void;

export class SetupRequiredError extends Error {
  readonly capability: Capability;

  constructor(capability: Capability, reason?: string) {
    super(`${capability} is not configured. ${reason ?? setupText[capability]}`);
    this.name = "SetupRequiredError";
    this.capability = capability;
  }
}

export class QvacWorkspace {
  private config: AppConfig;
  private readonly loaded = new Map<string, string>();
  private readonly statuses = new Map<string, ModelLoadStatus>();
  private providerPublicKey: string | undefined;
  private listener: ProgressListener | undefined;

  constructor(config: AppConfig) {
    this.config = config;
  }

  setConfig(config: AppConfig): void {
    this.config = config;
  }

  onStatus(listener: ProgressListener): void {
    this.listener = listener;
  }

  getStatuses(): ModelLoadStatus[] {
    return [...this.statuses.values()];
  }

  async unloadAll(): Promise<void> {
    const ids = [...new Set(this.loaded.values())];
    this.loaded.clear();
    await Promise.allSettled(ids.map((modelId) => qvac.unloadModel({ modelId })));
  }

  async complete(input: CompletionInput, routeRequest: RouteRequest): Promise<RoutedResult<string>> {
    return this.withRoute(routeRequest, async (route) => {
      const capability = input.attachments?.length ? "multimodal" : routeRequest.capability;
      const modelId = await this.load(capability, route);
      const history = [
        ...(input.history ?? []).map((message) => ({ role: message.role, content: message.content })),
        {
          role: "user",
          content: input.prompt,
          attachments: input.attachments?.map((path) => ({ path }))
        }
      ];
      const run = qvac.completion({
        modelId,
        history,
        stream: true,
        captureThinking: true
      });

      for await (const event of run.events) {
        this.handleCompletionEvent(event, input.onToken);
      }

      const final = await run.final;
      return { value: final.contentText, stats: final.stats };
    });
  }

  async embedTexts(texts: string[], routeRequest?: Partial<RouteRequest>): Promise<number[][]> {
    const request: RouteRequest = {
      capability: "embeddings",
      mode: routeRequest?.mode ?? "local",
      providerId: routeRequest?.providerId
    };
    const result = await this.withRoute(request, async (route) => {
      const modelId = await this.load("embeddings", route);
      const { embedding: vectors, stats } = await qvac.embed({ modelId, text: texts });
      return { value: vectors, stats };
    });
    return result.value;
  }

  async transcribe(audioPath: string, routeRequest: RouteRequest): Promise<RoutedResult<string>> {
    return this.withRoute(routeRequest, async (route) => {
      const modelId = await this.load("transcription", route);
      const text = await qvac.transcribe({ modelId, audioChunk: audioPath });
      return { value: text };
    });
  }

  async translate(
    text: string,
    from: string,
    to: string,
    routeRequest: RouteRequest
  ): Promise<RoutedResult<string>> {
    const translationModel = this.config.models.translation;
    if (translationModel.enabled && translationModel.modelSrc.trim()) {
      return this.withRoute(routeRequest, async (route) => {
        const modelId = await this.load("translation", route);
        const params =
          translationModel.modelType === "llm" || translationModel.modelType === "llamacpp-completion"
            ? { modelId, text, stream: true, modelType: translationModel.modelType, from, to }
            : { modelId, text, stream: true, modelType: translationModel.modelType };
        const result = qvac.translate(params as Parameters<typeof qvac.translate>[0]);
        return { value: await result.text, stats: await result.stats };
      });
    }

    const prompt = `Translate the following text from ${from} to ${to}. Return only the translation.\n\n${text}`;
    return this.complete({ prompt }, { ...routeRequest, capability: "llm" });
  }

  async speak(text: string, routeRequest: RouteRequest): Promise<RoutedResult<number[]>> {
    return this.withRoute(routeRequest, async (route) => {
      const modelId = await this.load("tts", route);
      const result = qvac.textToSpeech({
        modelId,
        text,
        inputType: "text",
        stream: false
      });
      return { value: await result.buffer };
    });
  }

  async generateImage(
    prompt: string,
    width: number,
    height: number,
    steps: number,
    routeRequest: RouteRequest,
    onProgress?: (message: string) => void
  ): Promise<RoutedResult<Uint8Array[]>> {
    return this.withRoute(routeRequest, async (route) => {
      const modelId = await this.load("image", route);
      const result = qvac.diffusion({ modelId, prompt, width, height, steps });
      void (async () => {
        for await (const tick of result.progressStream) {
          onProgress?.(`Diffusion step ${tick.step}/${tick.totalSteps}`);
        }
      })();
      return { value: await result.outputs, stats: await result.stats };
    });
  }

  async startProvider(): Promise<string> {
    const response = await qvac.startQVACProvider();
    if (!response.success || !response.publicKey) {
      throw new Error(response.error ?? "QVAC provider did not return a public key.");
    }
    this.providerPublicKey = response.publicKey;
    return response.publicKey;
  }

  async stopProvider(): Promise<void> {
    const response = await qvac.stopQVACProvider();
    if (!response.success) throw new Error(response.error ?? "Unable to stop QVAC provider.");
    this.providerPublicKey = undefined;
  }

  getProviderPublicKey(): string | undefined {
    return this.providerPublicKey;
  }

  async testProvider(provider: ProviderConfig): Promise<string> {
    const result = await this.complete(
      { prompt: "Reply with exactly: QVAC provider ready." },
      { capability: "llm", mode: "provider", providerId: provider.id }
    );
    return `Provider responded through ${result.provider?.name ?? provider.name}: ${result.value}`;
  }

  private async withRoute<T>(
    routeRequest: RouteRequest,
    run: (route: ResolvedRoute) => Promise<{ value: T; stats?: unknown }>
  ): Promise<RoutedResult<T>> {
    const route = this.resolveRoute(routeRequest);
    try {
      const result = await run(route);
      return { ...result, route: route.provider ? "provider" : "local", provider: route.provider };
    } catch (error) {
      if (route.mode === "fallback" && route.provider) {
        const local = await run({ mode: "local" });
        return { ...local, route: "local" };
      }
      throw error;
    }
  }

  private resolveRoute(request: RouteRequest): ResolvedRoute {
    if (request.mode === "local") return { mode: "local" };
    const provider = this.pickProvider(request.capability, request.providerId);
    if (request.mode === "provider") {
      if (!provider) throw new SetupRequiredError(request.capability, "Select a provider with this capability first.");
      return { mode: "provider", provider };
    }
    if (request.mode === "auto") {
      return provider ? { mode: "provider", provider } : { mode: "local" };
    }
    return provider ? { mode: "fallback", provider } : { mode: "local" };
  }

  private pickProvider(capability: Capability, providerId?: string): ProviderConfig | undefined {
    if (providerId) return this.config.providers.find((provider) => provider.id === providerId);
    return this.config.providers.find((provider) => provider.capabilities.includes(capability));
  }

  private async load(capability: Capability, route: ResolvedRoute): Promise<string> {
    const model = this.config.models[capability];
    if (!model.enabled || !model.modelSrc.trim()) throw new SetupRequiredError(capability);

    const key = JSON.stringify({
      capability,
      src: model.modelSrc,
      type: model.modelType,
      config: model.modelConfig,
      provider: route.provider?.publicKey
    });
    const loaded = this.loaded.get(key);
    if (loaded) return loaded;

    this.setStatus(key, "loading", `Loading ${capability} model ${model.modelSrc}`);
    try {
      const options: LoadModelOptions = {
        modelSrc: this.resolveSource(model.modelSrc),
        modelType: model.modelType as LoadModelOptions["modelType"],
        modelConfig: this.resolveObjectSources(model.modelConfig),
        delegate: route.provider
          ? {
              providerPublicKey: route.provider.publicKey,
              timeout: 60_000,
              fallbackToLocal: false
            }
          : undefined,
        onProgress: (progress: ModelProgressUpdate) => {
          this.setStatus(key, "loading", formatProgress(capability, progress));
        }
      } as LoadModelOptions;
      const modelId = await qvac.loadModel(options);
      this.loaded.set(key, modelId);
      this.setStatus(key, "loaded", `${capability} model loaded as ${modelId}`);
      return modelId;
    } catch (error) {
      this.setStatus(key, "error", errorToMessage(error));
      throw error;
    }
  }

  private resolveSource(source: string): ModelSource {
    const trimmed = source.trim();
    const exports = qvac as unknown as Record<string, unknown>;
    const exported = exports[trimmed];
    if (exported && (typeof exported === "object" || typeof exported === "string")) {
      return exported as ModelSource;
    }
    return trimmed;
  }

  private resolveObjectSources(value: Record<string, unknown>): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === "") continue;
      if (typeof entry === "string") {
        output[key] = this.resolveSource(entry);
      } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        output[key] = this.resolveObjectSources(entry as Record<string, unknown>);
      } else {
        output[key] = entry;
      }
    }
    return output;
  }

  private handleCompletionEvent(event: CompletionEvent, onToken: CompletionInput["onToken"]): void {
    if (event.type === "contentDelta") onToken?.(event.text);
    if (event.type === "completionDone" && event.stopReason === "error") {
      throw new Error(event.error.message);
    }
  }

  private setStatus(key: string, state: ModelLoadStatus["state"], message: string): void {
    const status = { key, state, message };
    this.statuses.set(key, status);
    this.listener?.(status);
  }
}

type ResolvedRoute = {
  mode: RouteMode;
  provider?: ProviderConfig;
};

function formatProgress(capability: Capability, progress: ModelProgressUpdate): string {
  const percentage = "percentage" in progress && typeof progress.percentage === "number" ? ` ${progress.percentage.toFixed(1)}%` : "";
  return `Loading ${capability}${percentage}`;
}

export function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
