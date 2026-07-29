// types.ts
export type EpisodicMemory = {
  id: string;           // uuid
  text: string;          // raw event description
  embedding: number[];    // e.g. 768-dim from Jina
  timestamp: number;
  metadata?: Record<string, any>; // e.g. { file: "x.ts", action: "edit" }
}