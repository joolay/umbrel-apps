"use strict";
// Talks to the person's own AI provider with the key they saved in Portal Admin (My settings > AI). Two wire formats cover every provider:
// Anthropic's own, and the OpenAI chat format that OpenAI, Gemini, OpenRouter and custom addresses all speak.
// Messages are kept in one neutral shape so the chat loop doesn't care which provider answers:
//   { role: "user", text }   { role: "assistant", text, calls: [{ id, name, input }] }   { role: "tool", results: [{ id, name, output }] }
const PRESETS = {
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", model: "gemini-3.8-flash" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "" },
  nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1", model: "" },
  custom: { baseUrl: "", model: "" },
};
class AiError extends Error { constructor(code, message, status) { super(message); this.code = code; this.status = status || 502; } }

// The key the person chose for this app (an app's own choice wins over their default; Portal Admin has already merged the two).
function resolve(user) {
  const pr = (user && user.portal && user.portal.prefs) || {};
  const key = typeof pr["ai.apiKey"] === "string" ? pr["ai.apiKey"].trim() : "", provider = PRESETS[pr["ai.provider"]] ? pr["ai.provider"] : "";
  if (!provider) return null;
  const model = (typeof pr["ai.model"] === "string" ? pr["ai.model"].trim() : "") || PRESETS[provider].model;
  const baseUrl = provider === "custom" ? String(pr["ai.baseUrl"] || "").trim() : PRESETS[provider].baseUrl;
  if (!model || !baseUrl || (!key && provider !== "custom")) return null;
  return { provider, apiKey: key, model, baseUrl: baseUrl.replace(/\/+$/, ""), last4: key.slice(-4) };
}
const pub = c => c && { provider: c.provider, model: c.model, last4: c.last4 };

const parse = s => { try { const v = JSON.parse(s || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } };

function toAnthropic(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant") { const c = []; if (m.text) c.push({ type: "text", text: m.text }); for (const k of m.calls || []) c.push({ type: "tool_use", id: k.id, name: k.name, input: k.input || {} }); out.push({ role: "assistant", content: c.length ? c : [{ type: "text", text: "…" }] }); }
    else out.push({ role: "user", content: m.results.map(r => ({ type: "tool_result", tool_use_id: r.id, content: String(r.output) })) });
  }
  return out;
}
function toOpenAI(messages, system) {
  const out = system ? [{ role: "system", content: system }] : [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "assistant") out.push({ role: "assistant", content: m.text || null, ...(m.calls && m.calls.length ? { tool_calls: m.calls.map(k => ({ id: k.id, type: "function", function: { name: k.name, arguments: JSON.stringify(k.input || {}) } })) } : {}) });
    else for (const r of m.results) out.push({ role: "tool", tool_call_id: r.id, content: String(r.output) });
  }
  return out;
}

module.exports = function makeAi({ fetchImpl = fetch } = {}) {
  async function post(url, headers, body) {
    let r;
    try { r = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) }); }
    catch (e) { throw new AiError("unreachable", "Couldn't reach the AI provider (" + (e.cause?.code || e.message) + ").", 502); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const why = j.error && (j.error.message || j.error);
      throw new AiError(r.status === 401 || r.status === 403 ? "bad_key" : r.status === 429 ? "rate_limited" : "provider_error",
        r.status === 401 || r.status === 403 ? "The provider refused your key. Check it in Portal Admin > My settings > AI." : r.status === 429 ? "The provider says you're over its limit or out of credit." : "The provider answered " + r.status + (why ? ": " + String(why).slice(0, 200) : "") + ".", 502);
    }
    return j;
  }
  // One turn: returns { text, calls: [{ id, name, input }] }.
  async function chat(cfg, { system, messages, tools = [], maxTokens = 1024 }) {
    if (cfg.provider === "anthropic") {
      const j = await post(cfg.baseUrl + "/v1/messages", { "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01" },
        { model: cfg.model, max_tokens: maxTokens, system, messages: toAnthropic(messages), ...(tools.length ? { tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema })) } : {}) });
      const blocks = Array.isArray(j.content) ? j.content : [];
      return { text: blocks.filter(b => b.type === "text").map(b => b.text).join("\n").trim(), calls: blocks.filter(b => b.type === "tool_use").map(b => ({ id: b.id, name: b.name, input: b.input || {} })) };
    }
    const j = await post(cfg.baseUrl + "/chat/completions", cfg.apiKey ? { authorization: "Bearer " + cfg.apiKey } : {},
      { model: cfg.model, max_tokens: maxTokens, messages: toOpenAI(messages, system), ...(tools.length ? { tools: tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } })) } : {}) });
    const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
    return { text: typeof m.content === "string" ? m.content.trim() : Array.isArray(m.content) ? m.content.map(p => p.text || "").join("").trim() : "", calls: (m.tool_calls || []).map((k, i) => ({ id: k.id || "call" + i, name: k.function && k.function.name, input: parse(k.function && k.function.arguments) })).filter(k => k.name) };
  }
  return { chat };
};
module.exports.resolve = resolve; module.exports.pub = pub; module.exports.AiError = AiError; module.exports.PRESETS = PRESETS;
