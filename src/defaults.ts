import type { AppConfig, Capability, ModelConfig } from "./types.js";

const modelDefaults: Record<Capability, ModelConfig> = {
  llm: {
    enabled: true,
    modelSrc: "QWEN3_600M_INST_Q4",
    modelType: "llamacpp-completion",
    modelConfig: { ctx_size: 4096, gpu_layers: 99, predict: 320, reasoning_budget: 0 }
  },
  embeddings: {
    enabled: true,
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
    enabled: true,
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
    modelSrc: "BERGAMOT_EN_VI",
    modelType: "nmtcpp-translation",
    modelConfig: {
      engine: "Bergamot",
      from: "en",
      to: "vi"
    }
  },
  tts: {
    enabled: false,
    modelSrc: "TTS_SUPERTONIC2_OFFICIAL_VOCODER_SUPERTONE_FP32",
    modelType: "onnx-tts",
    modelConfig: {
      ttsEngine: "supertonic",
      language: "en",
      ttsTextEncoderSrc: "TTS_SUPERTONIC2_OFFICIAL_TEXT_ENCODER_SUPERTONE_FP32",
      ttsDurationPredictorSrc: "TTS_SUPERTONIC2_OFFICIAL_DURATION_PREDICTOR_SUPERTONE_FP32",
      ttsVectorEstimatorSrc: "TTS_SUPERTONIC2_OFFICIAL_VECTOR_ESTIMATOR_SUPERTONE_FP32",
      ttsVocoderSrc: "TTS_SUPERTONIC2_OFFICIAL_VOCODER_SUPERTONE_FP32",
      ttsUnicodeIndexerSrc: "TTS_SUPERTONIC2_OFFICIAL_UNICODE_INDEXER_SUPERTONE_FP32",
      ttsTtsConfigSrc: "TTS_SUPERTONIC2_OFFICIAL_TTS_CONFIG_SUPERTONE",
      ttsVoiceStyleSrc: "TTS_SUPERTONIC2_OFFICIAL_VOICE_STYLE_SUPERTONE"
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
