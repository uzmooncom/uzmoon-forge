import { safeStorage } from "electron";
import fs from "fs";
import path from "path";

/** Opaque key → encrypted blob store backed by a single JSON file */
export class SecretStore {
  private readonly filePath: string;
  private cache: Record<string, string> = {};

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "secrets.enc");
    this.load();
  }

  private load(): void {
    // If main file is missing, attempt recovery from the .tmp file written
    // just before a crash (belt-and-suspenders alongside atomic rename).
    if (!fs.existsSync(this.filePath)) {
      const tmp = this.filePath + ".tmp";
      if (fs.existsSync(tmp)) {
        try { fs.renameSync(tmp, this.filePath); } catch { /* ignore */ }
      }
      if (!fs.existsSync(this.filePath)) return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      this.cache = JSON.parse(raw) as Record<string, string>;
    } catch {
      this.cache = {};
    }
  }

  private save(): void {
    const tmp = this.filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.cache), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmp, this.filePath);
  }

  set(key: string, plaintext: string): void {
    if (safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(plaintext);
      this.cache[key] = buf.toString("base64");
    } else {
      // Fallback: store with basic obfuscation (not true encryption)
      // but never plaintext-log the value
      const buf = Buffer.from(plaintext, "utf8");
      this.cache[key] = "b64:" + buf.toString("base64");
    }
    this.save();
  }

  get(key: string): string | null {
    const val = this.cache[key];
    if (val === undefined) return null;

    if (safeStorage.isEncryptionAvailable()) {
      try {
        const buf = Buffer.from(val, "base64");
        return safeStorage.decryptString(buf);
      } catch {
        return null;
      }
    } else {
      if (val.startsWith("b64:")) {
        return Buffer.from(val.slice(4), "base64").toString("utf8");
      }
      return null;
    }
  }

  has(key: string): boolean {
    return this.cache[key] !== undefined;
  }

  delete(key: string): void {
    delete this.cache[key];
    this.save();
  }
}