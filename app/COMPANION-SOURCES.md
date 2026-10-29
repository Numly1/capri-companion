# Optional free AI services

Checked against official provider pages on 28 October 2026. The companion's finite offline responses require no AI API. Cloud availability and quotas can change; a free text API does not automatically include free speech synthesis.

## Ollama on the user's own computer

Local inference has no per-request service charge or cloud usage quota; speed and capacity depend on the user's hardware and downloaded model. Local API requests need no API key. Cloud models offered by Ollama have separate pricing, so select an explicitly local model when avoiding API costs.

- [Ollama pricing and local usage](https://ollama.com/pricing)
- [Official local API introduction](https://docs.ollama.com/api/introduction)
- Local native endpoint: `http://localhost:11434/api/chat`; OpenAI-compatible base URL: `http://localhost:11434/v1`.

## OpenRouter Free

The Free plan currently lists 50 API requests per day. `openrouter/free` selects from available free models; explicitly free model variants are another option. Free capacity is limited and may be unavailable under load. This is a quota, not unlimited free inference.

- [Official pricing](https://openrouter.ai/pricing/)
- [Official free-model collection and router](https://openrouter.ai/collections/free-models)
- [Official rate-limit documentation](https://openrouter.ai/docs/api_reference/limits)
- OpenAI-compatible base URL: `https://openrouter.ai/api/v1`.

## Groq Free Plan

Groq offers a Free tier with model-specific request and token limits. The account's Limits page is authoritative for the actual allowance. The currently published chat-model table includes `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, and `qwen/qwen3.8-27b`; model access can change. Do not assume an older model remains available on the free plan.

- [Official rate limits](https://console.groq.com/docs/rate-limits)
- [Official billing FAQ](https://console.groq.com/docs/billing-faqs)
- [Official OpenAI compatibility](https://console.groq.com/docs/openai)
- OpenAI-compatible base URL: `https://api.groq.com/openai/v1`.

## Gemini free tier and regional availability

Gemini has a free tier for selected models. Russia is not listed in the current supported regions for Google AI Studio/Gemini Developer API, so it is not the primary recommendation for a user located there. Do not assume account or regional availability from the existence of a free price tier.

- [Official Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Official supported regions](https://ai.google.dev/gemini-api/docs/available-regions)

The upstream project's license and attribution remain in `LICENSE`; this source note does not replace them.
