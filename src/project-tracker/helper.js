"use strict";
// The chat helper for one project. It can read the project, the list and the project's repo folders. It can only PROPOSE changes
// (add a note, mark a note for review, change the status): they come back as proposals and nothing is saved until the owner presses Apply.
const L = require("./lists");

const MAX_TURNS = 6, MAX_FILE = 24000, MAX_DIR = 80, MAX_HISTORY = 24;
const STATUS_HELP = "Active = worked on regularly (within the last few days). Queued (stored as maintenance) = needs slight changes soon: glitches, faulty features, theme upgrades, open questions. Hiatus = stopped for now or good enough, more planned later. Closed = no more work planned (completed → archive, abandoned → delete).";

const TOOLS = [
  { name: "get_project", description: "The project you are talking about: details, status, notes (with ids and states), repo folders, last worked date.", schema: { type: "object", properties: {} } },
  { name: "list_projects", description: "Every live project in this list: id, name, category and status. Use it to compare or find another project.", schema: { type: "object", properties: {} } },
  { name: "list_repo_folder", description: "List a folder in one of this project's GitHub repos (only repos listed in the project's paths).", schema: { type: "object", properties: { repo: { type: "string", description: "owner/repo" }, path: { type: "string", description: "folder path, empty for the root" } }, required: ["repo"] } },
  { name: "read_repo_file", description: "Read a text file from one of this project's GitHub repos (first ~24 KB).", schema: { type: "object", properties: { repo: { type: "string" }, path: { type: "string" } }, required: ["repo", "path"] } },
  { name: "propose_add_note", description: "Propose adding a note to this project. The owner must press Apply.", schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "propose_mark_note_review", description: "Propose marking an existing note as done so the owner can confirm and clear it. Use the note id from get_project.", schema: { type: "object", properties: { noteId: { type: "string" } }, required: ["noteId"] } },
  { name: "propose_set_status", description: "Propose a new status: active, maintenance (shown as Queued), hiatus or closed. For closed also say closedAs: completed or abandoned.", schema: { type: "object", properties: { status: { type: "string", enum: ["active", "maintenance", "hiatus", "closed"] }, closedAs: { type: "string", enum: ["completed", "abandoned"] } }, required: ["status"] } },
];

const systemPrompt = (p, list) => [
  "You are the project helper inside Project Tracker, a private tool the owner uses to keep track of the apps and projects he builds. You are talking about one project: \"" + p.name + "\" (list: " + list.name + ").",
  "Be brief and concrete. Use the tools to look things up instead of guessing; say plainly when you couldn't find something.",
  "You cannot change anything yourself. To add a note, mark a note as done, or change the status, call the matching propose_ tool. The owner sees a button and decides. Don't claim a change is made.",
  "Statuses: " + STATUS_HELP,
  "Notes are the owner's to-dos for the project. When you finish one, propose marking it for review so he can confirm and clear it.",
  "Repo tools only reach the repos in this project's paths, read-only.",
].join("\n");

const view = (p, eff) => ({ id: p.id, name: p.name, category: p.category, description: p.desc, status: p.status, shownAs: eff.status, closedAs: p.closedAs || undefined, lastWorked: eff.last || undefined, repos: (p.paths || []).map(x => x.repo + ":" + x.path), notes: (p.notes || []).map(n => ({ id: n.id, text: n.text, state: n.state, added: String(n.at).slice(0, 10) })) });

const okRepo = s => typeof s === "string" && /^[A-Za-z0-9_.-]{1,60}\/[A-Za-z0-9_.-]{1,100}$/.test(s);
const okPath = s => typeof s === "string" && s.length <= 300 && !s.split("/").includes("..") && !/[\u0000-\u001f]/.test(s);

// ctx: { ai, cfg, list, project, worked, ghToken (for the tracking-data repo only), ghRepo, fetchImpl }
async function run(ctx, history) {
  const { ai, cfg, list, project } = ctx, fetchImpl = ctx.fetchImpl || fetch, proposals = [];
  const allowed = new Set((project.paths || []).map(x => x.repo.toLowerCase()));
  const eff = L.effective(project, ctx.worked || "", Date.now(), ctx.autoGlobal, ctx.days);
  async function gh(repo, p) {
    const headers = { accept: "application/vnd.github+json", "user-agent": "joolay-project-tracker" };
    if (ctx.ghToken && ctx.ghRepo && repo.toLowerCase() === ctx.ghRepo.toLowerCase()) headers.authorization = "Bearer " + ctx.ghToken;
    const r = await fetchImpl("https://api.github.com/repos/" + repo + "/contents/" + p.split("/").map(encodeURIComponent).join("/"), { headers, signal: AbortSignal.timeout(15000) });
    if (r.status === 404) throw new Error("Not found (or the repo is private).");
    if (r.status === 403 || r.status === 429) throw new Error("GitHub is rate limiting right now. Try again in a few minutes.");
    if (!r.ok) throw new Error("GitHub answered " + r.status + ".");
    return r.json();
  }
  async function exec(call) {
    const a = call.input || {};
    switch (call.name) {
      case "get_project": return JSON.stringify(view(project, eff));
      case "list_projects": return JSON.stringify(list.projects.filter(x => x.state === "live").map(x => ({ id: x.id, name: x.name, category: x.category, status: x.status })));
      case "list_repo_folder": case "read_repo_file": {
        if (!okRepo(a.repo) || !okPath(a.path || "")) throw new Error("That repo or path isn't valid.");
        if (!allowed.has(a.repo.toLowerCase())) throw new Error("Only this project's own repos can be read: " + ([...allowed].join(", ") || "none are set"));
        const j = await gh(a.repo, a.path || "");
        if (call.name === "list_repo_folder") { if (!Array.isArray(j)) throw new Error("That is a file, not a folder."); return JSON.stringify(j.slice(0, MAX_DIR).map(e => (e.type === "dir" ? e.name + "/" : e.name + " (" + e.size + " bytes)"))); }
        if (Array.isArray(j) || j.type !== "file") throw new Error("That is a folder, not a file.");
        if (!j.content || j.encoding !== "base64") throw new Error("That file is too large to read here.");
        const buf = Buffer.from(j.content, "base64"); if (buf.includes(0)) throw new Error("That looks like a binary file.");
        const t = buf.toString("utf8"); return t.length > MAX_FILE ? t.slice(0, MAX_FILE) + "\n…(cut off)" : t;
      }
      case "propose_add_note": { const text = L.str(a.text, 600); if (!text) throw new Error("The note is empty."); proposals.push({ id: "p" + (proposals.length + 1), kind: "add_note", text }); return "Proposed. The owner will see an Apply button."; }
      case "propose_mark_note_review": { const n = (project.notes || []).find(x => x.id === a.noteId); if (!n) throw new Error("No note with that id."); proposals.push({ id: "p" + (proposals.length + 1), kind: "note_review", noteId: n.id, text: n.text }); return "Proposed. The owner will see an Apply button."; }
      case "propose_set_status": { if (!L.STATUSES.includes(a.status)) throw new Error("Unknown status."); proposals.push({ id: "p" + (proposals.length + 1), kind: "set_status", status: a.status, closedAs: a.status === "closed" ? (a.closedAs === "abandoned" ? "abandoned" : "completed") : "" }); return "Proposed. The owner will see an Apply button."; }
      default: throw new Error("Unknown tool " + call.name);
    }
  }
  const msgs = history.slice(-MAX_HISTORY).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", text: String(m.text || "").slice(0, 4000) })).filter(m => m.text);
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") throw Object.assign(new Error("Say something first."), { code: "empty" });
  const system = systemPrompt(project, list); let text = "";
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const r = await ai.chat(cfg, { system, messages: msgs, tools: TOOLS });
    if (r.text) text = r.text;
    if (!r.calls.length) return { text: text || "(No answer.)", proposals };
    msgs.push({ role: "assistant", text: r.text, calls: r.calls });
    const results = [];
    for (const c of r.calls.slice(0, 6)) { let out; try { out = await exec(c); } catch (e) { out = "Error: " + e.message; } results.push({ id: c.id, name: c.name, output: out }); }
    msgs.push({ role: "tool", results });
  }
  return { text: (text ? text + "\n\n" : "") + "(I stopped after several steps. Ask me to carry on if you want more.)", proposals };
}
module.exports = { run, TOOLS, systemPrompt };
