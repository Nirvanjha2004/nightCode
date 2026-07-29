import fs from "fs";
import path from "path";

interface ProceduralRule {
  id: number;
  rule: string;
  createdAt: number;
  trigger?: string; // optional context tag, e.g. "editing .ts files"
}

export class ProceduralMemoryManager {
  private rules: ProceduralRule[] = [];
  private readonly filePath: string;
  private nextId = 1;

  constructor(filePath = "memory/procedural.md") {
    this.filePath = filePath;

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.rules = [];
      this.persist();
      return;
    }

    const raw = fs.readFileSync(this.filePath, "utf-8");
    // parse lines like: "1. [editing .ts files] Always run tsc after edit"
    const lines = raw.split("\n").filter((l) => /^\d+\./.test(l.trim()));

    this.rules = lines.map((line) => {
      const match = line.match(/^(\d+)\.\s*(?:\[(.+?)\]\s*)?(.+)$/);
      if (!match) return null;
      const [, id, trigger, rule] = match;
      return {
        // Yaha check karna :- i have added randomUUID to handle cases where id is not a number or is undefined
        id: parseInt(id || crypto.randomUUID(), 10),
        trigger: trigger || undefined,
        rule: rule?.trim() || "",
        createdAt: Date.now(), // not preserved across reloads, acceptable for MVP
      };
    }).filter(Boolean) as ProceduralRule[];

    this.nextId = this.rules.length > 0 ? Math.max(...this.rules.map((r) => r.id)) + 1 : 1;
  }

  private persist(): void {
    const lines = this.rules.map((r) => {
      const trigger = r.trigger ? `[${r.trigger}] ` : "";
      return `${r.id}. ${trigger}${r.rule}`;
    });
    fs.writeFileSync(this.filePath, lines.join("\n") + "\n");
  }

  addRule(rule: string, trigger?: string): ProceduralRule {
    const entry: ProceduralRule = {
      id: this.nextId++,
      rule,
      trigger,
      createdAt: Date.now(),
    };
    this.rules.push(entry);
    this.persist();
    return entry;
  }

  removeRule(id: number): void {
    this.rules = this.rules.filter((r) => r.id !== id);
    this.persist();
  }

  getAllRules(): ProceduralRule[] {
    return this.rules;
  }

  // direct prompt injection — this is the whole point of procedural memory
  toPromptString(): string {
    if (this.rules.length === 0) return "";
    const lines = this.rules.map((r) => {
      const trigger = r.trigger ? `[${r.trigger}] ` : "";
      return `${r.id}. ${trigger}${r.rule}`;
    });
    return `## Learned rules\n${lines.join("\n")}`;
  }

  get size(): number {
    return this.rules.length;
  }
}