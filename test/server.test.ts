import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { extractRegisteredModelId } from "../src/qvacClient.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..", "..");
const backendEntry = resolve(projectRoot, "dist", "src", "backendServer.js");

test("extractRegisteredModelId pulls the model id from a wrapped error", () => {
  const wrapped = new Error('Failed to load model: Model with ID "abc123def456" is already registered');
  assert.equal(extractRegisteredModelId(wrapped), "abc123def456");

  const bare = 'Model with ID "deadbeef" is already registered';
  assert.equal(extractRegisteredModelId(bare), "deadbeef");

  assert.equal(extractRegisteredModelId("something else"), undefined);
});

async function startBackend(port: number, storage: string): Promise<ChildProcess> {
  const proc = spawn(process.execPath, [backendEntry], {
    env: { ...process.env, QVAC_MESH_API_PORT: String(port), QVAC_MESH_STORAGE: storage },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise<void>((resolve, reject) => {
    let resolved = false;
    const onData = (chunk: Buffer): void => {
      if (chunk.toString().includes("listening on")) {
        resolved = true;
        proc.stdout?.off("data", onData);
        resolve();
      }
    };
    proc.stdout?.on("data", onData);
    proc.once("exit", (code) => {
      if (!resolved) reject(new Error(`backend exited early (code=${code})`));
    });
    setTimeout(() => {
      if (!resolved) reject(new Error("backend did not become ready in time"));
    }, 8000);
  });
  return proc;
}

async function stopBackend(proc: ChildProcess): Promise<void> {
  proc.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 3000);
  });
}

type ApiResponse = Record<string, unknown> & { ok: boolean; error?: string };

async function call(port: number, path: string, body?: unknown): Promise<ApiResponse> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return (await response.json()) as ApiResponse;
}

test("backend exposes /state, /chat/clear, /config/auto-setup, /config/reset", async () => {
  const port = 38500 + Math.floor(Math.random() * 100);
  const storage = await mkdtemp(join(tmpdir(), "qvac-srv-"));
  const proc = await startBackend(port, storage);
  try {
    const state = await call(port, "/state");
    assert.equal(state.ok, true, `unexpected /state response: ${JSON.stringify(state)}`);
    assert.ok(state.state, "/state must include state");

    const auto = await call(port, "/config/auto-setup", { capabilities: ["llm", "embeddings"] });
    assert.equal(auto.ok, true);
    const autoState = (auto.state as { config: { models: Record<string, { enabled: boolean }> } }).config.models;
    assert.equal(autoState.llm.enabled, true);
    assert.equal(autoState.embeddings.enabled, true);

    const cleared = await call(port, "/chat/clear", {});
    assert.equal(cleared.ok, true, `unexpected /chat/clear response: ${JSON.stringify(cleared)}`);
    assert.deepEqual((cleared.state as { chat: unknown[] }).chat, []);

    const reset = await call(port, "/config/reset", {});
    assert.equal(reset.ok, true);
    const resetState = (reset.state as { config: { models: Record<string, { modelConfig: Record<string, unknown> }> } }).config.models;
    assert.equal(resetState.translation.modelConfig.engine, "Bergamot");
    assert.equal(resetState.tts.modelConfig.ttsEngine, "supertonic");

    const unknown = await call(port, "/nope");
    assert.equal(unknown.ok, false);
    assert.match(String(unknown.error), /Unknown API route/);

    const ingest = await call(port, "/documents/ingest", {
      name: "test.md",
      text: "alpha\n\nbeta\n\ngamma",
      route: { capability: "embeddings", mode: "local" }
    });
    if (ingest.ok) {
      const docId = ((ingest.state as { documents: Array<{ id: string }> }).documents[0] ?? {}).id;
      if (docId) {
        const removed = await call(port, "/documents/remove", { id: docId });
        assert.equal(removed.ok, true);
        assert.equal((removed.state as { documents: unknown[] }).documents.length, 0);
      }
    }

    const cleared2 = await call(port, "/documents/clear", {});
    assert.equal(cleared2.ok, true);
    assert.equal((cleared2.state as { documents: unknown[] }).documents.length, 0);

    const imageStreamResp = await fetch(`http://127.0.0.1:${port}/image/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "", route: { capability: "image", mode: "local" } })
    });
    assert.equal(imageStreamResp.headers.get("content-type"), "application/x-ndjson");
    const text = await imageStreamResp.text();
    assert.match(text, /"type":"error"/, "empty prompt should stream error event");
  } finally {
    await stopBackend(proc);
    await rm(storage, { recursive: true, force: true });
  }
});
