// One error shape for every provider, with a short code the panel maps to a
// message: auth, rate, network, model, context, refusal, request.
export class ProviderError extends Error {
  constructor(message, { code = 'request', status = 0, hint = '' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

// A single tool call's assembled input JSON is capped so a runaway or
// malicious stream can't grow an unbounded string in memory.
export const MAX_TOOL_INPUT = 256 * 1024;

export function mapHttpError(status, body, provider) {
  let message = `${provider} returned HTTP ${status}`;
  try {
    const j = typeof body === 'string' ? JSON.parse(body) : body;
    message = j?.error?.message || j?.message || j?.error || message;
    if (typeof message !== 'string') message = JSON.stringify(message);
  } catch { if (typeof body === 'string' && body.trim()) message = body.slice(0, 200); }
  let code = 'request';
  if (status === 401 || status === 403) code = 'auth';
  else if (status === 429) code = 'rate';
  else if (status === 404) code = 'model';
  else if (status === 400 && /context|too long|too many tokens|maximum context|max_tokens/i.test(message)) code = 'context';
  return new ProviderError(message, { code, status });
}

// A fetch that threw: the network, CORS, or a blocked origin.
export function networkError(provider, err) {
  const hint = provider === 'ollama'
    ? 'The request never reached the server. If the Base URL is a relay, check that it is deployed (relay/README.md); a local Ollama must allow this origin through OLLAMA_ORIGINS.'
    : '';
  return new ProviderError(`Could not reach ${provider}: ${err?.message || err}`, { code: 'network', hint });
}
