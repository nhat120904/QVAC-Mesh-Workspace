# Qwen3 Prompt-Enhancer LoRA Training

This directory provides a lightweight distillation workflow for turning large-model reasoning into compact, task-specific on-device behavior.

The pipeline uses a larger reasoning model to synthesize high-quality instruction data, then fine-tunes a smaller Qwen3 GGUF model on that data for efficient local inference. This demo applies the pattern to an SDXL prompt enhancer: given a brief or under-specified image request, the model returns a refined positive prompt and a matching negative prompt.

The workflow consists of five steps:

1. Build `qvac-fabric-llm.cpp`.
2. Download the base Qwen3 GGUF model.
3. Generate `dataset.jsonl`.
4. Train a LoRA adapter.
5. Merge the adapter into a standalone GGUF model.

## Prerequisites

- `git`
- `cmake`
- `curl`
- `python3`
- A C++ build toolchain for your platform
- An OpenAI-compatible API key for synthetic data generation

Python dependencies:

```sh
cd training
python3 -m venv .venv
source .venv/bin/activate
pip install openai datasets tqdm
```

## Build qvac-fabric-llm.cpp

From this directory:

```sh
git clone https://github.com/tetherto/qvac-fabric-llm.cpp.git
cmake -S qvac-fabric-llm.cpp -B qvac-fabric-llm.cpp/build -DCMAKE_BUILD_TYPE=Release
cmake --build qvac-fabric-llm.cpp/build --config Release
```

Optional accelerator builds:

```sh
# Vulkan
cmake -S qvac-fabric-llm.cpp -B qvac-fabric-llm.cpp/build -DCMAKE_BUILD_TYPE=Release -DGGML_VULKAN=ON
cmake --build qvac-fabric-llm.cpp/build --config Release

# Metal
cmake -S qvac-fabric-llm.cpp -B qvac-fabric-llm.cpp/build -DCMAKE_BUILD_TYPE=Release -DGGML_METAL=ON
cmake --build qvac-fabric-llm.cpp/build --config Release
```

## Download Base Model

```sh
mkdir -p models
curl -L "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf" \
  -o models/qwen3-0.6b-q8_0.gguf
```

## Generate Dataset

Synthetic generation uses an OpenAI-compatible chat completions endpoint. By default, the script targets DeepSeek and reads `DEEPSEEK_API_KEY` or `OPENAI_API_KEY`.

```sh
export DEEPSEEK_API_KEY="..."
./data_synthesize.py --synthetic-samples 500 --ood-samples 500
```

Useful variants:

```sh
# Generate only SDXL prompt-enhancement examples.
./data_synthesize.py --ood-samples 0

# Sample only the optional out-of-domain data.
./data_synthesize.py --skip-synthetic --ood-samples 500

# Use another OpenAI-compatible provider.
OPENAI_API_KEY="..." OPENAI_BASE_URL="https://api.example.com/v1" OPENAI_MODEL="model-name" \
  ./data_synthesize.py
```

The script writes `dataset.jsonl` by default. Each line is a chat-format JSON object:

```json
{"messages":[{"role":"user","content":"..."},{"role":"assistant","content":"Positive prompt: ...\n\nNegative prompt: ..."}]}
```

## Train LoRA Adapter

```sh
./lora_ift.sh
```

Default inputs and outputs:

- Base model: `models/qwen3-0.6b-q8_0.gguf`
- Dataset: `dataset.jsonl`
- Adapter output: `trained_adapter.gguf`
- Checkpoints: `lora_checkpoints/`

Common overrides:

```sh
NUM_EPOCHS=3 LEARNING_RATE=3e-5 ./lora_ift.sh
MODEL=/path/to/base.gguf DATASET=/path/to/dataset.jsonl ./lora_ift.sh
LLAMA_CPP_DIR=/path/to/qvac-fabric-llm.cpp ./lora_ift.sh
```

Any extra arguments are passed through to `llama-finetune-lora`:

```sh
./lora_ift.sh --help
```

## Merge Adapter

```sh
./merge_lora.sh
```

Default output:

```txt
qwen3-0.6b-q8_0-prompt-enhancer.gguf
```

Common overrides:

```sh
ADAPTER=/path/to/trained_adapter.gguf OUTPUT_MODEL=/path/to/prompt-enhancer.gguf ./merge_lora.sh
```

## Files

- `data_synthesize.py`: configurable dataset generator.
- `dataset.jsonl`: current generated training dataset.
- `lora_ift.sh`: LoRA fine-tuning wrapper.
- `merge_lora.sh`: LoRA merge wrapper.
