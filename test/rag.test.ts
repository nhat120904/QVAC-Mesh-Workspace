import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildDocumentChunks, buildRagPrompt, chunkText, retrieveTopChunks } from "../src/rag.js";
import { LocalStore, initialState, uid } from "../src/storage.js";
import type { StoredDocument } from "../src/types.js";

test("chunkText creates overlapping chunks without empty entries", () => {
  const text = `${"a".repeat(1000)}\n\n${"b".repeat(1000)}\n\n${"c".repeat(1000)}`;
  const chunks = chunkText(text, 1200, 100);
  assert.equal(chunks.length >= 3, true);
  assert.equal(chunks.every((chunk) => chunk.trim().length > 0), true);
});

test("buildDocumentChunks embeds and keeps document references", async () => {
  const document: StoredDocument = {
    id: uid(),
    name: "notes.md",
    path: "notes.md",
    chunkIds: [],
    createdAt: new Date(0).toISOString()
  };
  const chunks = await buildDocumentChunks(
    {
      embedTexts: async (texts) => texts.map((text) => [text.includes("alpha") ? 1 : 0, text.includes("beta") ? 1 : 0])
    },
    document,
    "alpha topic\n\nbeta topic"
  );
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.documentId, document.id);
  assert.deepEqual(chunks[0]?.embedding, [1, 1]);
});

test("retrieveTopChunks ranks by cosine similarity", () => {
  const chunks = [
    { id: "a", documentId: "doc", documentName: "A", index: 0, text: "alpha", embedding: [1, 0] },
    { id: "b", documentId: "doc", documentName: "B", index: 1, text: "beta", embedding: [0, 1] }
  ];
  const [top] = retrieveTopChunks(chunks, [1, 0], 1);
  assert.equal(top?.id, "a");
});

test("buildRagPrompt includes numbered source references", () => {
  const prompt = buildRagPrompt("What matters?", [
    {
      id: "a",
      documentId: "doc",
      documentName: "Guide",
      index: 0,
      text: "Use local data.",
      embedding: [1],
      score: 0.9
    }
  ]);
  assert.match(prompt, /\[1\] Guide chunk 1/);
  assert.match(prompt, /Question: What matters\?/);
});

test("buildRagPrompt truncates context to a hard char budget", () => {
  const big = "x".repeat(5000);
  const chunks = Array.from({ length: 5 }, (_, index) => ({
    id: String(index),
    documentId: "doc",
    documentName: `Doc${index}`,
    index,
    text: big,
    embedding: [1],
    score: 1
  }));
  const prompt = buildRagPrompt("question?", chunks, 800);
  assert.equal(prompt.length < 1400, true, `expected prompt under budget+headers, got ${prompt.length}`);
  assert.match(prompt, /Question: question\?/);
});

test("LocalStore migrates legacy translation engine and missing tts reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "qvac-mesh-"));
  try {
    await mkdir(root, { recursive: true });
    const broken = {
      config: {
        models: {
          llm: { enabled: true, modelSrc: "QWEN3_600M_INST_Q4", modelType: "llamacpp-completion", modelConfig: {} },
          embeddings: { enabled: false, modelSrc: "", modelType: "llamacpp-embedding", modelConfig: {} },
          multimodal: { enabled: false, modelSrc: "", modelType: "llamacpp-completion", modelConfig: {} },
          transcription: { enabled: false, modelSrc: "", modelType: "whispercpp-transcription", modelConfig: {} },
          translation: { enabled: true, modelSrc: "MARIAN_EN_HI_INDIC_200M_Q4_0", modelType: "nmtcpp-translation", modelConfig: { engine: "IndicTrans2" } },
          tts: { enabled: true, modelSrc: "TTS_LANGUAGE_MODEL_EN_CHATTERBOX_FP32", modelType: "onnx-tts", modelConfig: { ttsEngine: "chatterbox", referenceAudioSrc: "" } },
          image: { enabled: false, modelSrc: "", modelType: "sdcpp-generation", modelConfig: {} }
        },
        providers: [],
        defaultRoute: "local"
      }
    };
    await writeFile(join(root, "workspace.json"), JSON.stringify(broken), "utf8");
    const store = new LocalStore(root);
    const state = await store.load();
    assert.equal(state.config.models.translation.modelConfig.engine, "Bergamot", "translation engine should be normalised");
    assert.equal(state.config.models.translation.enabled, true, "enabled flag should be preserved");
    assert.notEqual(state.config.models.tts.modelConfig.referenceAudioSrc, "", "tts must drop empty referenceAudioSrc");
    assert.equal(state.config.models.tts.modelConfig.ttsEngine, "supertonic");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("LocalStore initializes a complete local state", async () => {
  const root = await mkdtemp(join(tmpdir(), "qvac-mesh-"));
  try {
    const store = new LocalStore(root);
    await store.init();
    const state = await store.load();
    assert.deepEqual(Object.keys(state.config.models).sort(), Object.keys(initialState().config.models).sort());
    assert.equal(state.chat.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
