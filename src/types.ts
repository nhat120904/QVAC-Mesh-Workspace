export const CAPABILITIES = [
  "llm",
  "embeddings",
  "multimodal",
  "transcription",
  "translation",
  "tts",
  "image"
] as const;

export type Capability = (typeof CAPABILITIES)[number];
export type RouteMode = "local" | "provider" | "auto" | "fallback";

export type ModelConfig = {
  enabled: boolean;
  modelSrc: string;
  modelType: string;
  modelConfig: Record<string, unknown>;
};

export type ProviderConfig = {
  id: string;
  name: string;
  publicKey: string;
  capabilities: Capability[];
  lastStatus?: string;
  lastSeenAt?: string;
};

export type AppConfig = {
  models: Record<Capability, ModelConfig>;
  providers: ProviderConfig[];
  defaultRoute: RouteMode;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  at: string;
  route?: string;
  providerPublicKey?: string;
  attachments?: string[];
};

export type StoredDocument = {
  id: string;
  name: string;
  path: string;
  chunkIds: string[];
  createdAt: string;
};

export type RagChunk = {
  id: string;
  documentId: string;
  documentName: string;
  index: number;
  text: string;
  embedding: number[];
};

export type Transcript = {
  id: string;
  name: string;
  audioPath: string;
  text: string;
  createdAt: string;
};

export type VoiceTurn = {
  id: string;
  audioPath: string;
  transcript: string;
  response: string;
  ttsPath?: string;
  createdAt: string;
};

export type GalleryImage = {
  id: string;
  prompt: string;
  path: string;
  createdAt: string;
};

export type AppState = {
  config: AppConfig;
  chat: ChatMessage[];
  documents: StoredDocument[];
  chunks: RagChunk[];
  transcripts: Transcript[];
  voiceTurns: VoiceTurn[];
  gallery: GalleryImage[];
};

export type RouteRequest = {
  capability: Capability;
  mode: RouteMode;
  providerId?: string;
};

export type RoutedResult<T> = {
  value: T;
  route: "local" | "provider";
  provider?: ProviderConfig;
  stats?: unknown;
};

export type CompletionInput = {
  prompt: string;
  history?: ChatMessage[];
  attachments?: string[];
  onToken?: (token: string) => void;
};

export type ModelLoadStatus = {
  key: string;
  state: "idle" | "loading" | "loaded" | "error";
  message: string;
};
