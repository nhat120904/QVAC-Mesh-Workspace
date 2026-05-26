# QVAC Mesh Workspace

QVAC Mesh Workspace is a local-first Pear desktop app that uses the QVAC SDK as its only AI backend. It opens without configured models, stores workspace data in Pear app storage, and shows setup guidance for every missing capability instead of crashing.

## What It Demonstrates

- Streaming LLM completion and chat
- Multimodal image chat with one or two image attachments
- TXT/MD ingestion, QVAC embeddings, local vector storage, and RAG answers with source references
- Audio upload, transcription, transcript summary/action extraction, and transcript-to-RAG
- Translation through QVAC NMT or configured local LLM fallback
- Push-to-talk STT -> LLM -> TTS voice turns
- QVAC diffusion image generation with a local gallery
- QVAC delegated inference provider/consumer flow with multiple remote providers

## Install

Requirements:

- Node.js 22.17 or newer
- macOS 14+ arm64, Linux Ubuntu 22+, Windows 10+, or another QVAC-supported platform
- Pear Runtime. The first `pear` run may install it and ask you to open the runtime app once.

```sh
npm install
npm test
```

## Run In Pear Dev Mode

```sh
npm run pear:dev
```

If Pear was installed during the first run and exits with PATH instructions, open the runtime once and then run:

```sh
export PATH="$HOME/Library/Application Support/pear/bin:$PATH"
npm run pear:dev
```

The visible app title is `QVAC Mesh Workspace`.

## Model Configuration

Open `Model config` in the app. Each capability has:

- `enabled`: load and use this model when requested
- `modelSrc`: local file path, HTTP URL, `pear://` URL, QVAC registry constant, or other QVAC-supported model source
- `modelType`: QVAC model type, for example `llamacpp-completion`, `llamacpp-embedding`, `whispercpp-transcription`, `nmtcpp-translation`, `onnx-tts`, or `sdcpp-generation`
- `modelConfig`: JSON passed to `loadModel`

Default examples are prefilled but disabled. Enable only what you want to test.

Common starting points:

- LLM: `QWEN3_600M_INST_Q4`, modelType `llamacpp-completion`
- Embeddings: `EMBEDDINGGEMMA_300M_Q4_0`, modelType `llamacpp-embedding`
- Multimodal: `SMOLVLM2_500M_MULTIMODAL_Q8_0`, modelType `llamacpp-completion`, with `projectionModelSrc`
- Transcription: `WHISPER_EN_TINY_Q8_0`, modelType `whispercpp-transcription`
- Translation: QVAC Marian/Indic model constants, modelType `nmtcpp-translation`
- TTS: Chatterbox/Supertonic constants, modelType `onnx-tts`, with required companion sources
- Image generation: `SD_V2_1_1B_Q4_0` or another QVAC diffusion source, modelType `sdcpp-generation`

The QVAC adapter resolves exported SDK constants by name, so `QWEN3_600M_INST_Q4` and local paths both work.

## Local Completion Demo

1. Open `Model config`.
2. Enable `llm`.
3. Set `modelSrc` to a QVAC registry constant or local GGUF path.
4. Save config.
5. Open `Chat`.
6. Choose route `local`.
7. Send a prompt.

The first request may download/load the model. Loading progress and errors appear on the Dashboard.

## RAG Demo

1. Enable `embeddings` and `llm`.
2. Open `Documents/RAG`.
3. Upload a `.txt` or `.md` file.
4. Click `Ingest with QVAC embeddings`.
5. Ask a question.

The app chunks text locally, calls QVAC `embed`, stores vectors locally, retrieves top chunks by cosine similarity, and asks the LLM with numbered source context.

## Multimodal Demo

1. Enable `multimodal`.
2. Configure a multimodal LLM and matching `projectionModelSrc`.
3. Open `Multimodal`.
4. Upload one or two images.
5. Ask a question or compare the images.

## Audio And Voice Demo

For upload transcription:

1. Enable `transcription`.
2. Open `Audio`.
3. Upload an audio file. WAV is the most reliable input.
4. Transcribe, summarize, extract action items, or add the transcript to RAG.

For voice assistant:

1. Enable `transcription`, `llm`, and `tts`.
2. Open `Voice`.
3. Click `Start recording`, speak, then `Stop and run assistant`.

The recorded audio, transcript, assistant response, and generated WAV are saved locally.

## Translation Demo

1. Enable `translation`, or enable `llm` for fallback translation.
2. Open `Translation`.
3. Enter source and target language codes.
4. Paste input text, or use the quick-fill buttons for the latest chat answer, transcript, or document.
5. Translate text.

For NMT models, language direction is usually configured in `modelConfig` at load time. For LLM fallback, the app prompts the LLM with source and target language codes.

## Image Generation Demo

1. Enable `image`.
2. Configure a QVAC diffusion model and required companion model config.
3. Open `Image generation`.
4. Enter prompt, width, height, and steps.
5. Generate.

Images are saved to the local gallery under Pear app storage.

## Provider / Consumer Demo

Device B as provider:

1. Install and run this app.
2. Open `Mesh/P2P`.
3. Click `Start provider`.
4. Copy the displayed provider public key.

Device A as consumer:

1. Install and run this app.
2. Configure the same model capability you want to delegate, for example `llm`.
3. Open `Mesh/P2P`.
4. Add Device B's public key.
5. Set capabilities such as `llm,embeddings`.
6. Open `Chat`, choose route `provider` or `auto`, and send a prompt.

Delegation uses QVAC `loadModel({ delegate: { providerPublicKey } })`; inference calls use the same QVAC APIs as local mode.

## 3-Device Mesh Demo

- Device A: UI client
- Device B: LLM/RAG provider
- Device C: image/transcription provider

Steps:

1. On Device B, enable `llm` and `embeddings`, start provider, copy public key.
2. On Device C, enable `image` and/or `transcription`, start provider, copy public key.
3. On Device A, add both provider keys in `Mesh/P2P`.
4. Set Device B capabilities to `llm,embeddings`.
5. Set Device C capabilities to `image,transcription`.
6. In each app area, choose route `auto` or `provider`.
7. Use the provider selector when you want a specific device.

Route behavior:

- `local`: only this device
- `provider`: selected or first capable provider
- `auto`: provider when a capable provider exists, otherwise local
- `fallback`: try provider, then retry locally on failure

## Local Data

The app uses `Pear.app.storage` when running in Pear. Outside Pear, it falls back to `.qvac-mesh-workspace` in the project directory. Stored data includes:

- `workspace.json`
- uploaded documents/images/audio
- transcripts and voice turns
- generated images
- local RAG chunks and vectors

No OpenAI, Anthropic, Google, Replicate, RunPod, or cloud AI APIs are used.

## Troubleshooting

- App opens but a feature says setup is required: enable and configure the matching model in `Model config`.
- First model use is slow: QVAC may download and load model files. Watch Dashboard loading state.
- Provider connect is slow: first cold DHT bootstrap can take 15-45 seconds.
- Provider route fails: confirm both devices are online, the provider key is exact, and the provider has compatible QVAC models configured.
- Browser-recorded voice audio fails transcription: retry with WAV upload or configure a transcription model that supports the recorded format.
- TTS validation fails: Chatterbox and Supertonic require companion model sources in `modelConfig`; fill all required fields.
- Pear app name errors: Pear app identifiers must be lowercase. The internal Pear name is `qvac-mesh-workspace`; the visible app title remains `QVAC Mesh Workspace`.

## References

- QVAC SDK and delegated inference: https://docs.qvac.tether.io/
- QVAC source and examples: https://github.com/tetherto/qvac
- Pear desktop development: https://docs.pears.com/
- QVAC model organization: https://huggingface.co/qvac
