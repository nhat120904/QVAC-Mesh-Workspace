import type { RagChunk, StoredDocument } from "./types.js";
import { uid } from "./storage.js";

export type EmbeddingClient = {
  embedTexts(texts: string[]): Promise<number[][]>;
};

export type RetrievedChunk = RagChunk & {
  score: number;
};

export function chunkText(text: string, maxChars = 1200, overlap = 180): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!normalized) return [];

  const chunks: string[] = [];
  let index = 0;
  while (index < normalized.length) {
    const end = Math.min(index + maxChars, normalized.length);
    let sliceEnd = end;
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf("\n\n", end);
      if (boundary > index + maxChars * 0.45) sliceEnd = boundary;
    }
    const chunk = normalized.slice(index, sliceEnd).trim();
    if (chunk) chunks.push(chunk);
    if (sliceEnd >= normalized.length) break;
    index = Math.max(0, sliceEnd - overlap);
  }
  return chunks;
}

export async function buildDocumentChunks(
  client: EmbeddingClient,
  document: StoredDocument,
  text: string
): Promise<RagChunk[]> {
  const parts = chunkText(text);
  if (parts.length === 0) return [];
  const vectors = await client.embedTexts(parts);
  return parts.map((part, index) => ({
    id: uid(),
    documentId: document.id,
    documentName: document.name,
    index,
    text: part,
    embedding: vectors[index] ?? []
  }));
}

export function retrieveTopChunks(chunks: RagChunk[], queryEmbedding: number[], topK = 5): RetrievedChunk[] {
  return chunks
    .map((chunk) => ({ ...chunk, score: cosineSimilarity(chunk.embedding, queryEmbedding) }))
    .filter((chunk) => Number.isFinite(chunk.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function buildRagPrompt(question: string, chunks: RetrievedChunk[]): string {
  const context = chunks
    .map((chunk, index) => {
      return `[${index + 1}] ${chunk.documentName} chunk ${chunk.index + 1}\n${chunk.text}`;
    })
    .join("\n\n");

  return [
    "Answer the question using only the provided sources.",
    "Cite sources inline as [1], [2], etc. If the sources do not contain the answer, say what is missing.",
    "",
    "Sources:",
    context || "No sources retrieved.",
    "",
    `Question: ${question}`
  ].join("\n");
}

export function formatSources(chunks: RetrievedChunk[]): string {
  return chunks
    .map((chunk, index) => `[${index + 1}] ${chunk.documentName} chunk ${chunk.index + 1} score ${chunk.score.toFixed(3)}`)
    .join("\n");
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return Number.NEGATIVE_INFINITY;
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aMag += av * av;
    bMag += bv * bv;
  }
  if (aMag === 0 || bMag === 0) return Number.NEGATIVE_INFINITY;
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
}
