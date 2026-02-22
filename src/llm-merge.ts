/**
 * LLM-based merge for conflicts that can't be auto-resolved.
 *
 * Uses an OpenAI-compatible endpoint (e.g., copilot-proxy) to intelligently
 * merge conflicting changes by understanding semantic intent.
 */

export interface LLMMergeOptions {
  /** OpenAI-compatible API base URL (default: OPENAI_BASE_URL or http://localhost:6433) */
  baseURL?: string;
  /** Model to use (default: OPENAI_MODEL or gpt-4o) */
  model?: string;
  /** API key for authentication (default: OPENAI_API_KEY) */
  apiKey?: string;
  /** Temperature for generation (default: 0) */
  temperature?: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

const MERGE_SYSTEM_PROMPT = `You are a precise text merge assistant. Your task is to intelligently merge two versions of text that have both been modified from a common base.

Rules:
1. Preserve ALL meaningful changes from both versions
2. When both versions change the same content differently, combine the intents (e.g., if one adds bold and one restructures, do both)
3. Never lose information - if text was added on either side, include it
4. Maintain consistent formatting and style
5. Output ONLY the merged text, no explanations or markdown code blocks`;

/**
 * Attempts to merge conflicting text using an LLM.
 *
 * @param base - The common ancestor text
 * @param local - The local (your) version
 * @param remote - The remote (their) version
 * @param options - LLM configuration options
 * @returns The merged text, or null if the LLM call fails
 */
export async function llmMergeText(
  base: string,
  local: string,
  remote: string,
  options: LLMMergeOptions = {},
): Promise<string | null> {
  const baseURL =
    options.baseURL ?? process.env.OPENAI_BASE_URL ?? "http://localhost:6433";
  const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-4o";
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const temperature = options.temperature ?? 0;

  const messages: ChatMessage[] = [
    { role: "system", content: MERGE_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Merge these two versions that diverged from a common base.

=== BASE (original) ===
${base}

=== LOCAL (my changes) ===
${local}

=== REMOTE (their changes) ===
${remote}

=== MERGED OUTPUT ===`,
    },
  ];

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as ChatCompletionResponse;
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}
