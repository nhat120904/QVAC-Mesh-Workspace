import type { AppConfig, Capability, ModelConfig } from "./types.js";

const modelDefaults: Record<Capability, ModelConfig> = {
  llm: {
    enabled: false,
    modelSrc: "QWEN3_600M_INST_Q4",
    modelType: "llamacpp-completion",
    modelConfig: { ctx_size: 2048, gpu_layers: 99, predict: 256, reasoning_budget: 0 }
  },
  embeddings: {
    enabled: false,
    modelSrc: "EMBEDDINGGEMMA_300M_Q4_0",
    modelType: "llamacpp-embedding",
    modelConfig: {}
  },
  multimodal: {
    enabled: false,
    modelSrc: "SMOLVLM2_500M_MULTIMODAL_Q8_0",
    modelType: "llamacpp-completion",
    modelConfig: {
      ctx_size: 1024,
      projectionModelSrc: "MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0"
    }
  },
  transcription: {
    enabled: false,
    modelSrc: "WHISPER_EN_TINY_Q8_0",
    modelType: "whispercpp-transcription",
    modelConfig: {
      language: "en",
      translate: false,
      no_timestamps: true
    }
  },
  translation: {
    enabled: false,
    modelSrc: "MARIAN_EN_HI_INDIC_200M_Q4_0",
    modelType: "nmtcpp-translation",
    modelConfig: { engine: "IndicTrans2" }
  },
  tts: {
    enabled: false,
    modelSrc: "TTS_LANGUAGE_MODEL_EN_CHATTERBOX_FP32",
    modelType: "onnx-tts",
    modelConfig: {
      ttsEngine: "chatterbox",
      language: "en",
      ttsTokenizerSrc: "TTS_TOKENIZER_EN_CHATTERBOX",
      ttsSpeechEncoderSrc: "TTS_SPEECH_ENCODER_EN_CHATTERBOX_FP32",
      ttsEmbedTokensSrc: "TTS_EMBED_TOKENS_EN_CHATTERBOX_FP32",
      ttsConditionalDecoderSrc: "TTS_CONDITIONAL_DECODER_EN_CHATTERBOX_FP32",
      ttsLanguageModelSrc: "TTS_LANGUAGE_MODEL_EN_CHATTERBOX_FP32",
      referenceAudioSrc: ""
    }
  },
  image: {
    enabled: false,
    modelSrc: "SD_V2_1_1B_Q4_0",
    modelType: "sdcpp-generation",
    modelConfig: { device: "gpu" }
  }
};

export const defaultConfig: AppConfig = {
  models: modelDefaults,
  providers: [],
  defaultRoute: "local"
};

export const setupText: Record<Capability, string> = {
  llm: "Enable the LLM model and set modelSrc to a local GGUF path, QVAC registry constant, HTTP URL, pear:// URL, or supported registry ref.",
  embeddings: "Enable embeddings and configure a llama.cpp-compatible embedding model such as EMBEDDINGGEMMA_300M_Q4_0 or a local GGUF embedding model.",
  multimodal: "Enable multimodal and configure an image-capable LLM plus modelConfig.projectionModelSrc for the matching mmproj GGUF.",
  transcription: "Enable transcription and configure a Whisper or Parakeet model. WAV files are the most reliable input.",
  translation: "Enable translation with an NMT model, or leave disabled and use the local LLM fallback when the LLM is configured.",
  tts: "Enable TTS and provide all required ONNX TTS companion model sources plus a referenceAudioSrc when using Chatterbox.",
  image: "Enable image generation and configure a QVAC diffusion model. FLUX and SD families may require companion modelConfig sources."
};
