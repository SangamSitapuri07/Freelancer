import { getAiConfig } from "./utils.js";

export function computeCreditCost(usage = {}, maxTokens = 0) {
  const config = getAiConfig();
  const totalTokens =
    Number(usage.totalTokens) ||
    Number(usage.total_tokens) ||
    (Number(usage.promptTokens) + Number(usage.completionTokens)) ||
    (Number(usage.prompt_tokens) + Number(usage.completion_tokens)) ||
    Number(maxTokens) ||
    0;

  return config.creditsPerRequest + Math.max(1, Math.ceil(totalTokens / config.tokensPerCredit));
}
