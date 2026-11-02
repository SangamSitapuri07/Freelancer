import { AppError } from "./errors.js";
import { getAiConfig } from "./utils.js";

export async function createChatCompletion({ messages, temperature, maxTokens }) {
  const config = getAiConfig();
  if (!config.apiKey) {
    throw new AppError(
      "The AI provider is not configured on this server. Set AI_API_KEY and restart.",
      "AI_NOT_CONFIGURED",
      503,
    );
  }

  const body = {
    model: config.model,
    messages: [{ role: "system", content: config.systemPrompt }, ...messages],
    temperature: temperature ?? 0.2,
    max_tokens: maxTokens ?? 2048,
    stream: false,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await response.text();

    if (!response.ok) {
      throw new AppError(
        `AI provider returned HTTP ${response.status}`,
        "AI_PROVIDER_ERROR",
        502,
        { providerStatus: response.status, body: raw.slice(0, 800) },
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AppError("AI provider returned invalid JSON", "AI_INVALID_RESPONSE", 502);
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new AppError("AI provider returned an empty response", "AI_EMPTY_RESPONSE", 502);
    }

    const usage = parsed.usage || {};
    return {
      content,
      model: parsed.model || config.model,
      usage: {
        promptTokens: Number(usage.prompt_tokens) || 0,
        completionTokens: Number(usage.completion_tokens) || 0,
        totalTokens: Number(usage.total_tokens) || 0,
      },
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error.name === "AbortError") {
      throw new AppError("AI request timed out", "AI_TIMEOUT", 504);
    }
    throw new AppError("AI request failed", "AI_REQUEST_FAILED", 502, {
      message: error.message,
    });
  } finally {
    clearTimeout(timeout);
  }
}
