# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install deps (Node 22.17+ required).
- `npm run build` — TypeScript compile via `tsc -p tsconfig.json` into `dist/`.
- `npm test` — builds then runs `node --test dist/test/*.test.js`. Run a single test file with `node --test dist/test/rag.test.js` (build first).
- `npm run pear:dev` — builds, then launches the Pear desktop app (`pear run --dev .`). Requires Pear Runtime on PATH (`export PATH="$HOME/Library/Application Support/pear/bin:$PATH"` on macOS if first install).

There is no lint/format tooling configured. TypeScript runs in `strict` mode (ES2022 / NodeNext); the compiler is the only static check.

Behavioral guidelines for edits live in [AGENTS.md](AGENTS.md) — bias toward surgical, minimum-diff changes; do not "improve" adjacent code or add speculative abstractions.

## Architecture

This is a **Pear desktop app** (Electron-based via `pear-electron`) that wraps a local Node backend exposing the **QVAC SDK** (`@qvac/sdk`) as its sole AI engine. The frontend is a single static `index.html` page; there is no framework or bundler.

Three-process / three-layer layout, all on `127.0.0.1`:

1. **Pear runtime + Bridge** (`index.js`) — entry point launched by `pear run`. Spawns the backend as a `bare-subprocess`, passing `QVAC_MESH_API_PORT` (default `38471`) and `QVAC_MESH_STORAGE` (resolves to `Pear.app.storage`, falling back to `./.qvac-mesh-workspace` outside Pear). Starts the Electron runtime pointed at `index.html`. Tears down the backend on exit.
2. **Backend HTTP server** ([src/backendServer.ts](src/backendServer.ts)) — plain `node:http` JSON API on the api port. The `route()` switch in this file is the canonical list of endpoints (`/state`, `/config/save`, `/chat/*`, `/rag/*`, `/audio/*`, `/voice/*`, `/translate`, `/image/*`, `/mesh/*`, etc.). Holds the singleton `AppState` (loaded via `LocalStore`) and a singleton `QvacWorkspace`. All requests return `{ ok, ...result }` or `{ ok: false, error }`.
3. **Frontend** ([index.html](index.html) + [src/app.ts](src/app.ts), compiled to `dist/src/app.js` and loaded by the page) — single-page UI that issues `fetch` calls to the backend at `http://localhost:38471`. The two ports allow-listed in `package.json` `pear.links` are this API.

### Key modules

- [src/qvacClient.ts](src/qvacClient.ts) — `QvacWorkspace` class. The **only place** that touches `@qvac/sdk`. Responsible for: lazy `loadModel` per capability, delegated-inference setup (`delegate: { providerPublicKey }`), the provider/consumer mesh lifecycle, and status events. New capabilities or routing modes (`local` / `provider` / `auto` / `fallback`) belong here.
- [src/storage.ts](src/storage.ts) — `LocalStore`: filesystem persistence under the storage root. Owns `workspace.json` plus subdirs for documents, images, audio, transcripts, voice turns, generated images, and RAG vectors. `uid()` / `nowIso()` are exported for use by the server.
- [src/rag.ts](src/rag.ts) — pure functions for chunking, cosine-similarity retrieval, and prompt assembly. Stateless; the backend wires it to the store and QVAC embed/completion calls.
- [src/audio.ts](src/audio.ts) — PCM16 → WAV header packing for voice turns.
- [src/defaults.ts](src/defaults.ts) — default `AppState` and per-capability default model configs (all `enabled: false`).
- [src/types.ts](src/types.ts) — shared type definitions for `AppState`, `Capability`, `ChatMessage`, `RouteRequest`, etc. **Both** backend and frontend (`src/app.ts`) import from here.

### Capabilities

The set of `Capability` strings (e.g. `llm`, `embeddings`, `multimodal`, `transcription`, `translation`, `tts`, `image`) is defined in [src/types.ts](src/types.ts) and threaded through `defaults`, `QvacWorkspace`, the backend routes, and the UI. Adding a capability requires updates in all four.

### Routing modes

Every inference-style endpoint accepts a `RouteRequest` with mode `local`, `provider`, `auto`, or `fallback`. The selection logic lives in `QvacWorkspace`; the README has the user-facing semantics.

## Constraints

- No cloud AI providers (OpenAI/Anthropic/Google/etc.). QVAC is the only backend — do not add other LLM SDKs.
- Pear app identifier must stay lowercase (`qvac-mesh-workspace`); the visible title `QVAC Mesh Workspace` is set in [index.html](index.html).
- Frontend code is plain TypeScript compiled to ESM under `dist/src/`; do not introduce a bundler or framework without explicit direction.
