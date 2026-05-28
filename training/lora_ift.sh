#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

LLAMA_CPP_DIR="${LLAMA_CPP_DIR:-"${SCRIPT_DIR}/qvac-fabric-llm.cpp"}"
FINETUNE_BIN="${FINETUNE_BIN:-"${LLAMA_CPP_DIR}/build/bin/llama-finetune-lora"}"
MODEL="${MODEL:-"${SCRIPT_DIR}/models/qwen3-0.6b-q8_0.gguf"}"
DATASET="${DATASET:-"${SCRIPT_DIR}/dataset.jsonl"}"
OUTPUT_ADAPTER="${OUTPUT_ADAPTER:-"${SCRIPT_DIR}/trained_adapter.gguf"}"
CHECKPOINT_DIR="${CHECKPOINT_DIR:-"${SCRIPT_DIR}/lora_checkpoints"}"

CONTEXT_SIZE="${CONTEXT_SIZE:-1024}"
BATCH_SIZE="${BATCH_SIZE:-128}"
UBATCH_SIZE="${UBATCH_SIZE:-128}"
GPU_LAYERS="${GPU_LAYERS:-999}"
FLASH_ATTN="${FLASH_ATTN:-off}"
LORA_RANK="${LORA_RANK:-8}"
LORA_ALPHA="${LORA_ALPHA:-16}"
LORA_MODULES="${LORA_MODULES:-attn_q,attn_k,attn_v,attn_o}"
LEARNING_RATE="${LEARNING_RATE:-5e-5}"
LR_MIN="${LR_MIN:-1e-7}"
LR_SCHEDULER="${LR_SCHEDULER:-cosine}"
WARMUP_RATIO="${WARMUP_RATIO:-0.05}"
CHECKPOINT_SAVE_STEPS="${CHECKPOINT_SAVE_STEPS:-100}"
NUM_EPOCHS="${NUM_EPOCHS:-1}"

if [[ ! -x "${FINETUNE_BIN}" ]]; then
  echo "Missing llama-finetune-lora at ${FINETUNE_BIN}" >&2
  echo "Build qvac-fabric-llm.cpp first, or set LLAMA_CPP_DIR/FINETUNE_BIN." >&2
  exit 1
fi

if [[ ! -f "${MODEL}" ]]; then
  echo "Missing model at ${MODEL}" >&2
  echo "Download the GGUF model first, or set MODEL=/path/to/model.gguf." >&2
  exit 1
fi

if [[ ! -f "${DATASET}" ]]; then
  echo "Missing dataset at ${DATASET}" >&2
  echo "Generate it with data_synthesize.py, or set DATASET=/path/to/dataset.jsonl." >&2
  exit 1
fi

mkdir -p "${CHECKPOINT_DIR}"

exec "${FINETUNE_BIN}" \
  -m "${MODEL}" \
  -f "${DATASET}" \
  --assistant-loss-only \
  -c "${CONTEXT_SIZE}" \
  -b "${BATCH_SIZE}" \
  -ub "${UBATCH_SIZE}" \
  -ngl "${GPU_LAYERS}" \
  -fa "${FLASH_ATTN}" \
  --lora-rank "${LORA_RANK}" \
  --lora-alpha "${LORA_ALPHA}" \
  --lora-modules "${LORA_MODULES}" \
  --learning-rate "${LEARNING_RATE}" \
  --lr-min "${LR_MIN}" \
  --lr-scheduler "${LR_SCHEDULER}" \
  --warmup-ratio "${WARMUP_RATIO}" \
  --checkpoint-save-steps "${CHECKPOINT_SAVE_STEPS}" \
  --checkpoint-save-dir "${CHECKPOINT_DIR}" \
  --output-adapter "${OUTPUT_ADAPTER}" \
  --num-epochs "${NUM_EPOCHS}" \
  "$@"
