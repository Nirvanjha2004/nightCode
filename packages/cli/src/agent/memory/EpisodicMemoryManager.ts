import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { EpisodicMemory } from "./types";

export class EpisodicMemoryManager {
  private memoryCache: EpisodicMemory[] = [];
  private readonly episodicFile: string;
  private readonly jinaApiKey: string;
  private readonly jinaModel: string;

  constructor(
    episodicFile = "memory/episodic/events.jsonl",
    jinaModel = "jina-embeddings-v3"
  ) {
    this.episodicFile = episodicFile;
    this.jinaModel = jinaModel;

    const key = process.env.JINA_API_KEY;
    if (!key) throw new Error("JINA_API_KEY not set in environment");
    this.jinaApiKey = key;

    // ensure directory exists before any write
    const dir = path.dirname(this.episodicFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.loadMemoryIntoRAM();
  }

  // --- embedding ---
  private async getEmbedding(text: string): Promise<number[]> {
    const res = await fetch("https://api.jina.ai/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.jinaApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.jinaModel,
        input: [text],
      }),
    });

    if (!res.ok) {
      throw new Error(`Jina embedding failed: ${res.status} ${await res.text()}`);
    }

    const data  : any = await res.json();
    return data.data[0].embedding;
  }

  // --- boot load ---
  private loadMemoryIntoRAM(): void {
    if (!fs.existsSync(this.episodicFile)) {
      this.memoryCache = [];
      return;
    }
    const lines = fs
      .readFileSync(this.episodicFile, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);

    this.memoryCache = lines.map((line) => JSON.parse(line));
    console.log(`[MemoryManager] Loaded ${this.memoryCache.length} episodic memories`);
  }

  // --- write path ---
  async addEpisodicMemory(
    text: string,
    metadata?: Record<string, any>
  ): Promise<EpisodicMemory> {
    const embedding = await this.getEmbedding(text);
    const entry: EpisodicMemory = {
      id: randomUUID(),
      text,
      embedding,
      timestamp: Date.now(),
      metadata,
    };

    this.memoryCache.push(entry);
    fs.appendFileSync(this.episodicFile, JSON.stringify(entry) + "\n");

    return entry;
  }

  // --- similarity ---
  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0,
      normA = 0,
      normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += (a[i] ?? 0.0) * (b[i] ?? 0.0);
      normA += (a[i] ?? 0.0) * (a[i] ?? 0.0);
      normB += (b[i] ?? 0.0) * (b[i] ?? 0.0);
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // --- retrieval ---
  async retrieveRelevantMemories(
    query: string,
    topK = 5
  ): Promise<EpisodicMemory[]> {
    if (this.memoryCache.length === 0) return [];

    const queryEmbedding = await this.getEmbedding(query);

    const scored = this.memoryCache.map((mem) => ({
      memory: mem,
      score: this.cosineSimilarity(queryEmbedding, mem.embedding),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.memory);
  }

  // --- utility ---
  get size(): number {
    return this.memoryCache.length;
  }
}