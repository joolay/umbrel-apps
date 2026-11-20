"use strict";
const assert = require("assert"), makeAi = require("./ai"), helper = require("./helper"), L = require("./lists");
const list = L.cleanList({ version: 1, name: "App development", categories: ["X"], projects: [
  { id: "p1", name: "Diner Bell", category: "X", status: "maintenance", rank: 10, paths: [{ repo: "joolay/umbrel-apps", path: "src/diner-bell" }], notes: [{ id: "n1", text: "Fix the logo", state: "open" }] },
  { id: "p2", name: "Other", category: "X", status: "active", rank: 20 }] });
const project = list.projects[0];
(async () => {
  // --- settings: the key an app was given in Portal Admin ---
  const pr = p => ({ portal: { prefs: p } });
  assert.strictEqual(makeAi.resolve(pr({})), null);
  assert.deepStrictEqual(makeAi.pub(makeAi.resolve(pr({ "ai.provider": "anthropic", "ai.apiKey": "sk-ant-1234" }))), { provider: "anthropic", model: "claude-sonnet-5-5", last4: "1234" });
  assert.strictEqual(makeAi.resolve(pr({ "ai.provider": "openai", "ai.apiKey": "k" })), null, "openai needs a model");
  assert.strictEqual(makeAi.resolve(pr({ "ai.provider": "custom", "ai.model": "m", "ai.baseUrl": "http://localhost:11434/v1/" })).baseUrl, "http://localhost:11434/v1");

  // --- provider formats ---
  const sent = []; let queue = [];
  const fake = async (url, init) => { sent.push([url, JSON.parse(init.body), init.headers]); const r = queue.shift(); return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.body }; };
  const ai = makeAi({ fetchImpl: fake });
  const msgs = [{ role: "user", text: "hi" }, { role: "assistant", text: "", calls: [{ id: "c1", name: "get_project", input: {} }] }, { role: "tool", results: [{ id: "c1", name: "get_project", output: "{}" }] }];
  queue = [{ body: { content: [{ type: "text", text: "Hello" }, { type: "tool_use", id: "t9", name: "list_projects", input: {} }] } }];
  let r = await ai.chat({ provider: "anthropic", apiKey: "K", model: "m", baseUrl: "https://api.anthropic.com" }, { system: "S", messages: msgs, tools: helper.TOOLS });
  assert.deepStrictEqual(r, { text: "Hello", calls: [{ id: "t9", name: "list_projects", input: {} }] });
  assert.strictEqual(sent[0][0], "https://api.anthropic.com/v1/messages"); assert.strictEqual(sent[0][2]["x-api-key"], "K"); assert.strictEqual(sent[0][1].system, "S");
  assert.deepStrictEqual(sent[0][1].messages[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "{}" }] });
  assert.strictEqual(sent[0][1].tools[0].input_schema.type, "object");
  queue = [{ body: { choices: [{ message: { content: null, tool_calls: [{ id: "x", type: "function", function: { name: "get_project", arguments: "{\"a\":1}" } }] } }] } }];
  r = await ai.chat({ provider: "gemini", apiKey: "G", model: "gm", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" }, { system: "S", messages: msgs, tools: helper.TOOLS });
  assert.deepStrictEqual(r.calls, [{ id: "x", name: "get_project", input: { a: 1 } }]);
  const o = sent[1][1]; assert.strictEqual(o.messages[0].role, "system"); assert.strictEqual(o.messages[2].tool_calls[0].function.name, "get_project"); assert.deepStrictEqual(o.messages[3], { role: "tool", tool_call_id: "c1", content: "{}" });
  assert.strictEqual(sent[1][2].authorization, "Bearer G"); assert.ok(sent[1][0].endsWith("/openai/chat/completions"));
  queue = [{ status: 401, body: { error: { message: "nope" } } }];
  await assert.rejects(() => ai.chat({ provider: "openai", apiKey: "x", model: "m", baseUrl: "https://api.openai.com/v1" }, { messages: [{ role: "user", text: "a" }] }), e => e.code === "bad_key" && /refused/.test(e.message));
  queue = [{ status: 429, body: {} }]; await assert.rejects(() => ai.chat({ provider: "openai", apiKey: "x", model: "m", baseUrl: "u" }, { messages: [{ role: "user", text: "a" }] }), e => e.code === "rate_limited");

  // --- the helper: reads freely, only proposes changes, can't leave the project's own repos ---
  const script = [
    { text: "", calls: [{ id: "a", name: "get_project", input: {} }, { id: "b", name: "read_repo_file", input: { repo: "evil/other", path: "x" } }, { id: "c", name: "read_repo_file", input: { repo: "joolay/umbrel-apps", path: "../etc" } }] },
    { text: "", calls: [{ id: "d", name: "propose_add_note", input: { text: "Check the icon too" } }, { id: "e", name: "propose_mark_note_review", input: { noteId: "n1" } }, { id: "f", name: "propose_set_status", input: { status: "closed" } }, { id: "g", name: "propose_mark_note_review", input: { noteId: "nope" } }, { id: "h", name: "list_repo_folder", input: { repo: "joolay/umbrel-apps", path: "src/diner-bell" } }] },
    { text: "Done. I've suggested three changes.", calls: [] }];
  const seen = []; const scripted = { chat: async (cfg, { messages }) => { seen.push(messages.length); return script.shift(); } };
  const fetched = []; const ghFetch = async (u, i) => { fetched.push([u, i.headers.authorization]); return { ok: true, status: 200, json: async () => [{ type: "file", name: "server.js", size: 10 }, { type: "dir", name: "public" }] }; };
  const out = await helper.run({ ai: scripted, cfg: {}, list, project, worked: "", autoGlobal: true, fetchImpl: ghFetch, ghToken: "TRK", ghRepo: "joolay/tracking-data" }, [{ role: "user", text: "What's left?" }]);
  assert.strictEqual(out.text, "Done. I've suggested three changes.");
  assert.deepStrictEqual(out.proposals.map(p => p.kind), ["add_note", "note_review", "set_status"]); assert.strictEqual(out.proposals[2].closedAs, "completed");
  assert.strictEqual(fetched.length, 1); assert.strictEqual(fetched[0][1], undefined, "the tracking-data token is never sent to other repos"); assert.ok(fetched[0][0].endsWith("/repos/joolay/umbrel-apps/contents/src/diner-bell"));
  assert.deepStrictEqual(seen, [1, 3, 5], "tool results are fed back each turn");
  // errors from tools come back to the model as text, not crashes
  const s2 = [{ text: "", calls: [{ id: "a", name: "read_repo_file", input: { repo: "evil/other", path: "x" } }] }, { text: "ok", calls: [] }]; let fed;
  await helper.run({ ai: { chat: async (c, { messages }) => { fed = messages; return s2.shift(); } }, cfg: {}, list, project, fetchImpl: ghFetch }, [{ role: "user", text: "go" }]);
  assert.match(fed[fed.length - 1].results[0].output, /^Error: Only this project's own repos/);
  // a model that never stops is cut off
  const loopy = { chat: async () => ({ text: "", calls: [{ id: "z", name: "get_project", input: {} }] }) };
  assert.match((await helper.run({ ai: loopy, cfg: {}, list, project }, [{ role: "user", text: "x" }])).text, /stopped after several steps/);
  await assert.rejects(() => helper.run({ ai: scripted, cfg: {}, list, project }, []), /Say something/);
  console.log("chat ok");
})().catch(e => { console.error(e); process.exit(1); });
