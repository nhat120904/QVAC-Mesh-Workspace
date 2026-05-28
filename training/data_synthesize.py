#!/usr/bin/env python3
import argparse
import json
import os
import random
from pathlib import Path
from typing import Any

DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL = "deepseek-v4-pro"
DEFAULT_OOD_DATASET = "Open-Orca/SlimOrca"
DEFAULT_SAMPLE_SIZE = 500
DEFAULT_SEED = 42
DEFAULT_OUTPUT = Path(__file__).with_name("dataset.jsonl")

ROLE_MAP = {
    "system": "system",
    "human": "user",
    "gpt": "assistant",
}

SYSTEM_PROMPT = """
You are a dataset synthesis engine for SDXL 1.5 prompt enhancement training data.

Your task is to synthesize realistic two-turn conversations. Each conversation must contain:

1. A user message with a raw image idea, request, or edit instruction.
2. An assistant message that converts the raw input into exactly two Stable Diffusion prompts:
   - Positive prompt
   - Negative prompt

The user message should feel natural, informal, short, varied, and under-specified like a real user request. It may be a short idea, a messy description, a casual request, a product concept, a character idea, a scene concept, a style request, or an image-edit instruction.

The assistant message must follow this exact format:
Positive prompt: [single polished SDXL 1.5 prompt]
Negative prompt: [artifact and failure exclusions]

Do not include explanations, settings, workflow names, markdown headings, bullet points, notes, or commentary in the final prompts.

Generate diverse examples across many image types:
- Photoreal portraits
- Fashion/editorial images
- Product photography
- Food photography
- Architecture and interiors
- Anime or character illustration
- Fantasy, sci-fi, and game art
- Posters, typography, packaging, and signs
- UI mockups
- Landscapes and environments
- Image edits, inpainting, background replacement, style transfer, product consistency, and character consistency

User input style:
Make the raw user input concise and realistic.
Vary specificity: some users give one sentence, some give fragmented notes, some mention style references, mood, colors, or constraints.
Do not make every user request perfectly written.
Do not include the final prompt inside the user message.
Do not mention "positive prompt" or "negative prompt" in the user message unless it sounds natural for a prompt-generation request.

Assistant positive prompt style rules:
Write the final desired image, not an instruction.
Put the main subject and composition first.
Use concrete visual descriptors instead of generic quality stacks.
Prefer clear visual language: subject, action, framing, environment, style or medium, lighting, color, camera/render technique, materials, textures, and important details.
Keep the prompt specific, imageable, and internally consistent.
Avoid vague improvement words such as better, beautiful, amazing, professional, cinematic, or high quality unless paired with concrete visual details.
Use prose for SDXL-style checkpoints, photoreal scenes, product shots, architecture, UI mockups, and complex compositions.
Use comma-separated tags for anime, illustration, booru-style models, character sheets, and game assets.
Mixed format is acceptable: begin with a short scene description, then add concise style, lighting, camera, material, or detail cues.
Use weights only when they meaningfully emphasize an important detail, usually between 1.05 and 1.3.
Avoid dense weight spam, nested weights, and long generic quality tag chains.
Include LoRA, embedding, or special model tokens only if the user provides them.

Style-specific assistant guidance:
For photorealism, include camera, lens, lighting, depth of field, realistic materials, natural texture, believable anatomy, and grounded environmental detail.
For portraits, include pose, framing, expression, wardrobe, skin texture, eye detail, hair, lighting direction, and background context.
For products, include placement, surface, material, reflections, contact shadow, label or logo fidelity, lighting, and brand-like color palette.
For anime or character illustration, include character type, pose, outfit, expression, background, line quality, shading style, lighting, eye detail, and cohesive palette.
For typography, posters, signs, packaging, or UI text, quote exact short text and describe placement, typography, layout, legibility, material, and visual hierarchy.
For UI mockups, include app/domain, screen type, navigation or layout structure, readable labels, grid, spacing, palette, and product design style.
For game assets, include isolated subject, readable silhouette, view angle, style, material detail, clean edges, and transparent-background-friendly composition.
For architecture or interiors, include viewpoint, spatial layout, perspective lines, materials, lighting, camera height, and environmental context.
For food, include dish, plating, surface, garnish, texture, natural light, realistic steam/gloss, depth of field, and appetizing color.

Image-edit/reference assistant guidance:
If the user describes editing an existing image, write the positive prompt as the final edited image.
Describe what changes while preserving important visual anchors.
Preservation anchors may include identity, pose, composition, camera angle, room geometry, product silhouette, logo placement, label text, material, proportions, reflections, lighting, shadows, perspective, and color grade.
For inpainting, focus on the masked target area and nearby integration details.
For style transfer, preserve composition, subject identity, pose, scale, and major shapes while changing only the rendering style.
For product or character consistency, explicitly preserve the identity anchors that should not drift.

Assistant negative prompt style rules:
Always provide a negative prompt.
Use it to remove likely visual failures, artifacts, and unwanted styles.
Do not include a negative term that conflicts with the user's requested subject, style, medium, lighting, or preserved content.
Prefer compact, targeted negatives over huge generic lists.
Common negatives may include: low quality, blurry, jpeg artifacts, watermark, signature, distorted anatomy, malformed hands, extra fingers, distorted face, bad perspective, oversaturated, text artifacts.
For photoreal people, add targeted anatomy and realism negatives such as plastic skin, uncanny face, deformed eyes, malformed hands.
For products, add warped label, misspelled text, broken logo, floating object, bad reflections.
For architecture or UI, add distorted perspective, unreadable text, broken layout, inconsistent grid.
For anime or illustration, add extra limbs, bad hands, messy lineart, off-model face, muddy shading.
For image editing, add seam, halo, mask edge, inconsistent lighting, wrong perspective, patchy fill, mismatched texture when relevant.

Quality requirements:
Each conversation must be useful as training data for prompt enhancement.
The assistant output must be substantially richer than the user input.
The positive prompt must preserve the user's intent while adding visual specificity.
The negative prompt must be relevant to the generated image type.
Avoid near-duplicate conversations.
Avoid repetitive wording across examples.

EXAMPLE JSON OUTPUT:
{
  "messages": [
    {
      "role": "user",
      "content": "cozy little ramen shop in tokyo at night, rainy street outside, anime movie vibe"
    },
    {
      "role": "assistant",
      "content": "Positive prompt: cozy Japanese ramen shop on a narrow Tokyo side street at night, warm glowing interior visible through steamed windows, rain-soaked pavement reflecting neon signs, hanging noren curtains at the entrance, drifting steam from ramen bowls, bicycles parked nearby, cinematic anime background art, soft painterly shading, moody blue and amber lighting, subtle fog, wet reflections, overhead utility wires, medium-wide composition, detailed environmental storytelling, crisp linework, atmospheric depth\\n\\nNegative prompt: blurry, low detail, distorted perspective, warped buildings, unreadable text, malformed furniture, muddy colors, flat lighting, messy lineart, oversaturated neon, duplicate objects, jpeg artifacts, watermark, signature, cropped scene, floating objects"
    }
  ]
}
""".strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate JSONL training data for SDXL prompt enhancement LoRA fine-tuning."
    )
    parser.add_argument(
        "--synthetic-samples",
        type=int,
        default=DEFAULT_SAMPLE_SIZE,
        help="Number of SDXL prompt-enhancement conversations to synthesize.",
    )
    parser.add_argument(
        "--ood-samples",
        type=int,
        default=DEFAULT_SAMPLE_SIZE,
        help="Number of optional out-of-domain conversations to sample from Hugging Face.",
    )
    parser.add_argument(
        "--ood-dataset",
        default=DEFAULT_OOD_DATASET,
        help="Hugging Face dataset name used for out-of-domain examples.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="JSONL output path.",
    )
    parser.add_argument(
        "--model",
        default=os.getenv("OPENAI_MODEL", DEFAULT_MODEL),
        help="Chat completion model used for synthetic data.",
    )
    parser.add_argument(
        "--base-url",
        default=os.getenv("OPENAI_BASE_URL", DEFAULT_BASE_URL),
        help="OpenAI-compatible API base URL.",
    )
    parser.add_argument(
        "--api-key",
        default=os.getenv("OPENAI_API_KEY") or os.getenv("DEEPSEEK_API_KEY"),
        help="OpenAI-compatible API key. Defaults to OPENAI_API_KEY or DEEPSEEK_API_KEY.",
    )
    parser.add_argument(
        "--hf-token",
        default=os.getenv("HF_TOKEN"),
        help="Optional Hugging Face token. Defaults to HF_TOKEN.",
    )
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="Shuffle seed.")
    parser.add_argument(
        "--skip-synthetic",
        action="store_true",
        help="Do not call the chat completion API.",
    )
    parser.add_argument(
        "--skip-ood",
        action="store_true",
        help="Do not sample out-of-domain data from Hugging Face.",
    )
    return parser.parse_args()


def validate_message(message: Any) -> bool:
    return (
        isinstance(message, dict)
        and message.get("role") in {"system", "user", "assistant"}
        and isinstance(message.get("content"), str)
        and bool(message["content"].strip())
    )


def validate_conversation(conversation: Any) -> bool:
    messages = conversation.get("messages") if isinstance(conversation, dict) else None
    return (
        isinstance(messages, list)
        and len(messages) >= 2
        and all(validate_message(message) for message in messages)
    )


def synthesize_conversations(
    num_samples: int,
    *,
    api_key: str | None,
    base_url: str,
    model: str,
) -> list[dict[str, Any]]:
    if num_samples <= 0:
        return []
    if not api_key:
        raise RuntimeError(
            "Synthetic generation needs OPENAI_API_KEY, DEEPSEEK_API_KEY, or --api-key."
        )

    from openai import OpenAI
    from tqdm import tqdm

    client = OpenAI(api_key=api_key, base_url=base_url)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": "Generate one sample for me"},
    ]

    conversations: list[dict[str, Any]] = []
    failures = 0

    for _ in tqdm(range(num_samples), desc="Synthesizing"):
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            response_format={"type": "json_object"},
        )
        content = response.choices[0].message.content
        try:
            conversation = json.loads((content or "").strip())
        except json.JSONDecodeError:
            failures += 1
            continue

        if validate_conversation(conversation):
            conversations.append(conversation)
        else:
            failures += 1

    if failures:
        print(f"Skipped {failures} invalid synthetic responses.")
    if not conversations:
        raise RuntimeError("Synthetic generation completed, but no valid conversations were produced.")

    return conversations


def sample_from_ood_dataset(
    num_samples: int,
    *,
    dataset_name: str,
    seed: int,
    hf_token: str | None,
) -> list[dict[str, Any]]:
    if num_samples <= 0:
        return []

    from datasets import load_dataset
    from tqdm import tqdm

    ds = load_dataset(dataset_name, split="train", token=hf_token)
    sample_count = min(num_samples, len(ds))
    sampled = ds.shuffle(seed=seed).select(range(sample_count))
    converted: list[dict[str, Any]] = []

    for row in tqdm(sampled, desc="Sampling OOD"):
        conversation = convert_ood_row(row)
        if conversation is not None:
            converted.append(conversation)

    return converted


def convert_ood_row(row: dict[str, Any]) -> dict[str, Any] | None:
    turns = row.get("conversations")
    if not isinstance(turns, list):
        return None

    messages = []
    for turn in turns:
        if not isinstance(turn, dict):
            continue

        src_role = turn.get("from")
        content = turn.get("value")
        if src_role not in ROLE_MAP or not isinstance(content, str) or not content.strip():
            continue

        messages.append({"role": ROLE_MAP[src_role], "content": content.strip()})

    if len(messages) < 2:
        return None
    return {"messages": messages}


def write_jsonl(conversations: list[dict[str, Any]], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as output_file:
        for conversation in conversations:
            output_file.write(json.dumps(conversation, ensure_ascii=False) + "\n")


def main() -> None:
    args = parse_args()
    random.seed(args.seed)

    all_conversations: list[dict[str, Any]] = []
    if not args.skip_synthetic:
        all_conversations.extend(
            synthesize_conversations(
                args.synthetic_samples,
                api_key=args.api_key,
                base_url=args.base_url,
                model=args.model,
            )
        )

    if not args.skip_ood:
        all_conversations.extend(
            sample_from_ood_dataset(
                args.ood_samples,
                dataset_name=args.ood_dataset,
                seed=args.seed,
                hf_token=args.hf_token,
            )
        )

    if not all_conversations:
        raise RuntimeError("No conversations were generated. Check sample counts and skip flags.")

    random.shuffle(all_conversations)
    write_jsonl(all_conversations, args.output)
    print(f"Wrote {len(all_conversations)} conversations to {args.output}")


if __name__ == "__main__":
    main()
