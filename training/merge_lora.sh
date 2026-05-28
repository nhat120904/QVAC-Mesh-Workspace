#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

LLAMA_CPP_DIR="${LLAMA_CPP_DIR:-"${SCRIPT_DIR}/qvac-fabric-llm.cpp"}"
EXPORT_BIN="${EXPORT_BIN:-"${LLAMA_CPP_DIR}/build/bin/llama-export-lora"}"
MODEL="${MODEL:-"${SCRIPT_DIR}/models/qwen3-0.6b-q8_0.gguf"}"
ADAPTER="${ADAPTER:-"${SCRIPT_DIR}/trained_adapter.gguf"}"
OUTPUT_MODEL="${OUTPUT_MODEL:-"${SCRIPT_DIR}/qwen3-0.6b-q8_0-prompt-enhancer.gguf"}"

if [[ ! -x "${EXPORT_BIN}" ]]; then
  echo "Missing llama-export-lora at ${EXPORT_BIN}" >&2
  echo "Build qvac-fabric-llm.cpp first, or set LLAMA_CPP_DIR/EXPORT_BIN." >&2
  exit 1
fi

if [[ ! -f "${MODEL}" ]]; then
  echo "Missing model at ${MODEL}" >&2
  echo "Download the GGUF model first, or set MODEL=/path/to/model.gguf." >&2
  exit 1
fi

if [[ ! -f "${ADAPTER}" ]]; then
  echo "Missing LoRA adapter at ${ADAPTER}" >&2
  echo "Run lora_ift.sh first, or set ADAPTER=/path/to/trained_adapter.gguf." >&2
  exit 1
fi

exec "${EXPORT_BIN}" \
  -m "${MODEL}" \
  --lora "${ADAPTER}" \
  -o "${OUTPUT_MODEL}" \
  "$@"
