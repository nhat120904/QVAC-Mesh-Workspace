import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { defaultConfig } from "./defaults.js";
import type { AppConfig, AppState } from "./types.js";

const STORE_FILE = "workspace.json";

export function getStorageRoot(): string {
  const pearStorage = (globalThis as unknown as { Pear?: { app?: { storage?: string } } }).Pear?.app?.storage;
  if (pearStorage) return pearStorage;
  return join(process.cwd(), ".qvac-mesh-workspace");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function uid(): string {
  return randomUUID();
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "file";
}

export function initialState(): AppState {
  return {
    config: structuredClone(defaultConfig),
    chat: [],
    documents: [],
    chunks: [],
    transcripts: [],
    voiceTurns: [],
    gallery: []
  };
}

export class LocalStore {
  readonly root: string;
  private readonly storePath: string;

  constructor(root = getStorageRoot()) {
    this.root = root;
    this.storePath = join(root, STORE_FILE);
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(this.dir("uploads"), { recursive: true });
    await mkdir(this.dir("gallery"), { recursive: true });
    await mkdir(this.dir("audio"), { recursive: true });
    if (!existsSync(this.storePath)) {
      await this.save(initialState());
    }
  }

  dir(name: string): string {
    return join(this.root, name);
  }

  async load(): Promise<AppState> {
    await this.init();
    const raw = await readFile(this.storePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppState>;
    return mergeState(parsed);
  }

  async save(state: AppState): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async saveUploadedFile(file: File, bucket = "uploads"): Promise<string> {
    await mkdir(this.dir(bucket), { recursive: true });
    const ext = extname(file.name);
    const path = join(this.dir(bucket), `${Date.now()}-${sanitizeFileName(file.name || `upload${ext}`)}`);
    const existingPath = file.path;
    if (existingPath && existsSync(existingPath)) {
      await copyFile(existingPath, path);
      return path;
    }
    const data = Buffer.from(await file.arrayBuffer());
    await writeFile(path, data);
    return path;
  }

  async writeBinary(bucket: string, name: string, bytes: Uint8Array): Promise<string> {
    await mkdir(this.dir(bucket), { recursive: true });
    const path = join(this.dir(bucket), sanitizeFileName(name));
    await writeFile(path, bytes);
    return path;
  }

  async writeText(bucket: string, name: string, text: string): Promise<string> {
    await mkdir(this.dir(bucket), { recursive: true });
    const path = join(this.dir(bucket), sanitizeFileName(name));
    await writeFile(path, text, "utf8");
    return path;
  }
}

function mergeState(parsed: Partial<AppState>): AppState {
  const state = initialState();
  const config = mergeConfig(parsed.config);
  return {
    ...state,
    ...parsed,
    config,
    chat: parsed.chat ?? [],
    documents: parsed.documents ?? [],
    chunks: parsed.chunks ?? [],
    transcripts: parsed.transcripts ?? [],
    voiceTurns: parsed.voiceTurns ?? [],
    gallery: parsed.gallery ?? []
  };
}

function mergeConfig(config?: Partial<AppConfig>): AppConfig {
  const defaults = structuredClone(defaultConfig);
  if (!config) return defaults;
  return {
    ...defaults,
    ...config,
    models: {
      ...defaults.models,
      ...(config.models ?? {})
    },
    providers: config.providers ?? []
  };
}
