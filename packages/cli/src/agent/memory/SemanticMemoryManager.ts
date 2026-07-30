import fs from "fs";
import path from "path";

export class SemanticMemoryManager {
  private facts: Record<string, any> = {};
  private readonly filePath: string;

  constructor(filePath = "memory/semantic.json") {
    this.filePath = filePath;

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.facts = {};
      this.persist(); // create empty file
      return;
    }
    const raw = fs.readFileSync(this.filePath, "utf-8");
    this.facts = raw.trim() ? JSON.parse(raw) : {};
  }

  private persist(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.facts, null, 2));
  }

  // dot-path get, e.g. "user.stack.db"
  get(keyPath: string): any {
    return keyPath.split(".").reduce((obj, key) => obj?.[key], this.facts as any);
  }

  // dot-path set, e.g. set("user.stack.db", "Postgres")
  set(keyPath: string, value: any): void {
    const keys = keyPath.split(".");
    let obj: any = this.facts;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (key === undefined) continue; // TS narrowing ke liye, practically kabhi hit nahi hoga

      if (typeof obj[key] !== "object" || obj[key] === null) {
        obj[key] = {};
      }
      obj = obj[key];
    }

    const lastKey = keys[keys.length - 1];
    if (lastKey === undefined) return; // e.g. keyPath khaali string tha
    obj[lastKey] = value;
    this.persist();
  }

  delete(keyPath: string): void {
    const keys = keyPath.split(".");
    let obj: any = this.facts;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (key === undefined) return;
      if (!obj[key]) return; // path doesn't exist
      obj = obj[key];
    }

    const lastKey = keys[keys.length - 1];
    if (lastKey === undefined) return;
    delete obj[lastKey];
    this.persist();
  }

  // full dump, useful for prompt injection
  getAll(): Record<string, any> {
    return this.facts;
  }

  // flatten for readable prompt injection
  toPromptString(): string {
    const lines: string[] = [];
    const walk = (obj: any, prefix = "") => {
      for (const key of Object.keys(obj)) {
        const value = obj[key];
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (typeof value === "object" && value !== null && !Array.isArray(value)) {
          walk(value, fullKey);
        } else {
          lines.push(`- ${fullKey}: ${JSON.stringify(value)}`);
        }
      }
    };
    walk(this.facts);
    return lines.join("\n");
  }
}