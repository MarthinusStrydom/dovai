import fs from "node:fs/promises";
import type { Extraction } from "./index.ts";

export async function extractText(filePath: string): Promise<Extraction> {
  const text = await fs.readFile(filePath, "utf8");
  return { text, method: "plain_text" };
}
