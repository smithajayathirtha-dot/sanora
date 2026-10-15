// Sanora: recognize activities from a day's photos and record them in the Activities section.
//
// POST /api/analyze-activities   { center_id, date: "YYYY-MM-DD", tz_offset_min }
// Header: Authorization: Bearer <the signed-in teacher's Supabase access token>
//
// - Runs as the signed-in teacher: Supabase access rules decide which photos it can see and
//   which activities it can write, exactly as in the app. No service key is used.
// - Activities that teachers entered are never changed. Earlier photo-recognized ('ai') entries
//   for that day are replaced by the new result, so re-running after more uploads stays tidy.
//
// Environment (Vercel → Project → Settings → Environment Variables):
//   ANTHROPIC_API_KEY  (required)
//   ANTHROPIC_MODEL    (optional, default claude-sonnet-5-5)
//   SUPABASE_URL, SUPABASE_ANON_KEY (optional; default to the values in app/config.js)

const SUPABASE_URL = process.env.SUPABASE_URL || "https://fzuupmauwfgrbsmvsmrj.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_PIYNPbVjx1RlIdPOqVoO5g_Nr5mLlx7";
const ANTHROPIC_URL = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1/messages";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const HALF_DAY_END = "12:45";   // half-day children are picked up after lunch
const MAX_PHOTOS = 20;
// Tolerate a key pasted with spaces, a line break or surrounding quotes
const RAW_KEY = (process.env.ANTHROPIC_API_KEY || "").trim().replace(/^["']|["']$/g, "").trim();
// If extra text was pasted around the key (e.g. "Use this key: sk-ant-..."), pick out the key itself
const API_KEY = (RAW_KEY.match(/sk-ant-[A-Za-z0-9_-]+/) || [RAW_KEY])[0];

// The same categories teachers pick from in the Activities tab, with what counts as each
const CATEGORIES = [
  ["Circle time", "children sitting together in a circle or group on the floor or rug with a teacher: greetings, calendar, songs, sharing"],
  ["Art & craft", "painting, drawing, coloring, crayons, markers, glue, cutting, collage, play dough sculpting, making crafts"],
  ["Music & movement", "singing, dancing, instruments (drums, shakers, xylophone), movement games, stretching or yoga"],
  ["Story time", "a book being read or looked at, children listening to a story, puppets or storytelling"],
  ["Outdoor play", "playing outside: playground, slide, swings, sandbox, riding toys, ball games, garden, nature walk"],
  ["Sensory play", "sensory bins or tables, water play, sand or rice or bean bins, slime, play dough squishing, textures, bubbles"],
  ["Learning", "puzzles, blocks and building, shapes, colors, counting, letters and numbers, sorting and matching, pretend play, science"],
  ["Other", "a clear activity that fits none of the categories above"]
];
const KINDS = CATEGORIES.map((c) => c[0]);

// Tool definition: when the center has a typical-day schedule, each activity is placed in one of its blocks
function makeTool(slots) {
  const item = {
    type: "object",
    properties: {
      kind: { type: "string", enum: KINDS, description: "The category this activity belongs to. Use 'Other' only when none of the others fit." },
      title: { type: "string", description: "Short, specific name, e.g. 'Leaf painting', 'Building block towers'. Max 6 words." },
      details: { type: "string", description: "One warm, factual sentence for parents describing what the children did. No names, no guesses about feelings beyond what is visible." },
      photos: { type: "array", items: { type: "integer" }, description: "Photo numbers (as labeled) that show this activity." }
    },
    required: ["kind", "title", "details", "photos"]
  };
  if (slots.length) {
    item.properties.block = { type: "integer", enum: slots.map((_, i) => i + 1), description: "Number of the typical-day block this activity belongs to." };
    item.required.push("block");
  }
  return {
    name: "record_activities",
    description: "Record the distinct activities the children were doing in the day's photos.",
    input_schema: { type: "object", properties: { activities: { type: "array", description: slots.length ? "At most one entry per schedule block." : "At most one entry per category.", items: item } }, required: ["activities"] }
  };
}
const hm = (t) => (t ? String(t).slice(0, 5) : "");
const fmt12 = (t) => { const [h, m] = hm(t).split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };

async function sbFetch(path, token, init = {}) {
  const r = await fetch(SUPABASE_URL + path, {
    ...init,
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) }
  });
  const text = await r.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) { const e = new Error((body && (body.message || body.error)) || `Supabase ${r.status}`); e.status = r.status; throw e; }
  return body;
}

const send = (res, status, obj) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
const isDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  if (!API_KEY) return send(res, 503, { error: "Photo recognition isn't switched on yet: ANTHROPIC_API_KEY is not set in Vercel." });
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return send(res, 401, { error: "Sign in first." });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { center_id: centerId, date, tz_offset_min: tz = 0 } = body || {};
  if (!centerId || !/^[a-z0-9-]{1,60}$/.test(centerId) || !isDate(date)) return send(res, 400, { error: "center_id and date (YYYY-MM-DD) are required." });

  try {
    // 1. Only staff may run this, and only for a center they work in
    const prof = await sbFetch("/rest/v1/rpc/my_profile", token, { method: "POST", body: "{}" });
    const role = prof && prof.role;
    if (!["admin", "head", "teacher"].includes(role)) return send(res, 403, { error: "Only teachers can do this." });
    if (role !== "admin" && prof.center_id !== centerId) return send(res, 403, { error: "That isn't your center." });

    // 2. The center's typical-day schedule, its children, and that day's photos
    const centers = await sbFetch(`/rest/v1/centers?select=schedule&id=eq.${encodeURIComponent(centerId)}`, token);
    const schedule = (centers && centers[0] && Array.isArray(centers[0].schedule)) ? centers[0].schedule : [];
    const slots = schedule.filter((b) => b.activity);
    const kids = await sbFetch(`/rest/v1/children?select=id,name,half_day&center_id=eq.${encodeURIComponent(centerId)}`, token);
    if (!kids.length) return send(res, 200, { added: 0, activities: [], note: "No children in this center yet." });
    const nameOf = Object.fromEntries(kids.map((k) => [k.id, k.name]));
    const halfDay = new Set(kids.filter((k) => k.half_day).map((k) => k.id));
    // A photo showing only half-day children (picked up after lunch) belongs to a morning block
    const onlyHalfDay = (p) => { const k = p.members.map((m) => m.child_id).filter(Boolean); return k.length > 0 && k.every((id) => halfDay.has(id)); };
    const ids = kids.map((k) => k.id).join(",");
    // The children's photos plus the center's class pool (group photos where no child was recognized)
    const who = `or=(child_id.in.(${ids}),and(child_id.is.null,center_id.eq.${encodeURIComponent(centerId)}))`;
    const all = await sbFetch(`/rest/v1/photos?select=id,child_id,path,created_at,group_id&taken_on=eq.${date}&${who}&order=created_at.desc&limit=200`, token);
    // A group photo saved for several children is one picture: send it once, labeled with all of them
    const groups = new Map();
    for (const p of all) {
      const key = p.group_id || p.id;
      if (!groups.has(key)) groups.set(key, { path: p.path, created_at: p.created_at, members: [] });
      groups.get(key).members.push(p);
    }
    const pics = [...groups.values()].slice(0, MAX_PHOTOS).reverse();   // newest 20, then oldest first
    if (!pics.length) return send(res, 200, { added: 0, activities: [], note: "No photos for this day yet." });

    // 3. Short-lived links the model can fetch
    const signed = await sbFetch("/storage/v1/object/sign/photos", token, { method: "POST", body: JSON.stringify({ expiresIn: 600, paths: pics.map((p) => p.path) }) });
    const urlFor = {};
    (signed || []).forEach((x) => { if (x.signedURL && !x.error) urlFor[x.path] = SUPABASE_URL + "/storage/v1" + x.signedURL; });
    const usable = pics.filter((p) => urlFor[p.path]);
    if (!usable.length) return send(res, 200, { added: 0, activities: [], note: "Couldn't open the photos." });

    // 4. What teachers already logged that day (kept as is; the model skips these)
    const existing = await sbFetch(`/rest/v1/activities?select=kind,title,details,act_time,source&center_id=eq.${encodeURIComponent(centerId)}&act_date=eq.${date}&source=neq.ai`, token);

    // 5. Ask Claude
    const localTime = (iso) => { const d = new Date(Date.parse(iso) - (Number(tz) || 0) * 60000); return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
    const content = [];
    usable.forEach((p, i) => {
      const who = [...new Set(p.members.map((m) => nameOf[m.child_id]).filter(Boolean))].join(", ") || "not identified (class photo)";
      const half = slots.length && onlyHalfDay(p) ? `; ${who} ${p.members.length > 1 ? "are" : "is"} on a half day (picked up at ${fmt12(HALF_DAY_END)}), so this is a morning activity` : "";
      content.push({ type: "text", text: `Photo ${i + 1} (children: ${who}; uploaded at ${fmt12(localTime(p.created_at))}${half})` });
      content.push({ type: "image", source: { type: "url", url: urlFor[p.path] } });
    });
    const tool = makeTool(slots);
    const lines = [
      `These are photos from one day (${date}) at a small home daycare and preschool for children aged 10 months to 5 years.`,
      "Activity categories:\n" + CATEGORIES.map(([k, d]) => `- ${k}: ${d}`).join("\n")
    ];
    if (slots.length) {
      lines.push("The center follows this typical day. Place each activity in the block it belongs to:\n" +
        slots.map((b, i) => `${i + 1}. ${fmt12(b.start)}–${fmt12(b.end)} ${b.title}${b.details ? ": " + b.details : ""} (usual categories: ${(b.kinds || []).join(", ")})`).join("\n"));
      lines.push("Return at most one entry per block, listing all the photos that show it. Choose the block from what the photo shows; " +
        "when two blocks fit (for example outdoor play in the morning or the afternoon), pick the one that ends before the photo's upload time, since a photo can't be uploaded before it was taken.");
    } else {
      lines.push("Return at most one entry per category, listing all the photos that show it.");
    }
    lines.push("Ignore photos that don't show a clear activity (e.g. just a portrait, arrival, a nap, a snack or a meal). Use 'Other' only when nothing else fits.");
    lines.push(existing.length
      ? "Teachers already logged these activities today. Do NOT return entries for them:\n" + existing.map((a) => `- ${a.act_time ? fmt12(a.act_time) + " " : ""}${a.kind}: ${a.title || a.kind}${a.details ? " (" + a.details + ")" : ""}`).join("\n")
      : "Teachers haven't logged any activities today.");
    lines.push("Describe only what is visible. Never mention children's names or appearance in the title or details. If there is nothing new, return an empty list.");
    lines.push("Call the record_activities tool with the result. If you can't use the tool, reply with only JSON in the form {\"activities\": [...]}.");
    content.push({ type: "text", text: lines.join("\n\n") });

    const ar = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, tools: [tool], tool_choice: { type: "auto" }, messages: [{ role: "user", content }] })
    });
    const aj = await ar.json();
    if (!ar.ok) {
      const m = (aj && aj.error && aj.error.message) || String(ar.status);
      const hint = ar.status === 401 ? ` (the key in Vercel starts "${API_KEY.slice(0, 7)}…" and is ${API_KEY.length} characters; a Claude API key starts "sk-ant-")` : "";
      return send(res, 502, { error: "Photo recognition failed: " + m + hint });
    }
    // Prefer the tool call; fall back to JSON in a text reply
    const call = (aj.content || []).find((c) => c.type === "tool_use" && c.name === tool.name);
    let found = (call && call.input && Array.isArray(call.input.activities)) ? call.input.activities : null;
    if (!found) {
      const text = (aj.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const m = text.match(/\{[\s\S]*\}/);
      try { const parsed = m ? JSON.parse(m[0]) : null; found = parsed && Array.isArray(parsed.activities) ? parsed.activities : []; } catch { found = []; }
    }

    // 6. Turn the result into activity rows.
    //    With a schedule: one per block, timed at the block's start; skip blocks a teacher already logged an activity in.
    //    Without one: one per category, timed by the first photo's upload; skip categories a teacher already logged.
    const inBlock = (t, b) => t && hm(t) >= hm(b.start) && hm(t) < hm(b.end);
    const merged = new Map();
    for (const a of found) {
      const kind = KINDS.includes(a.kind) ? a.kind : "Other";
      let key, time;
      if (slots.length) {
        let b = slots[(Number(a.block) || 0) - 1];
        if (!b) continue;
        // Half-day children are gone by the afternoon: move their photos' activity to the matching morning block
        const ps0 = (a.photos || []).map((n) => usable[n - 1]).filter(Boolean);
        if (hm(b.start) >= HALF_DAY_END && ps0.length && ps0.every(onlyHalfDay)) {
          const am = slots.filter((x) => hm(x.start) < HALF_DAY_END);
          b = am.find((x) => (x.kinds || []).includes(kind)) || am[am.length - 1] || b;
        }
        if (existing.some((e) => inBlock(e.act_time, b) || (!e.act_time && (b.kinds || []).includes(e.kind) && e.kind === kind))) continue;
        key = "b" + b.start; time = hm(b.start);
      } else {
        if (existing.some((e) => e.kind === kind)) continue;
        key = "k" + kind; time = null;
      }
      if (!merged.has(key)) merged.set(key, { ...a, kind, time, photos: [] });
      const m = merged.get(key); m.photos = [...new Set([...m.photos, ...(a.photos || [])])];
    }
    // Children seen in the photos; class-pool photos only (no child identified) count as the whole class
    const kidsOf = (members) => { const k = [...new Set(members.map((m) => m.child_id).filter(Boolean))]; return k.length ? k : null; };
    const rows = [];
    for (const a of merged.values()) {
      const ps = (a.photos || []).map((n) => usable[n - 1]).filter(Boolean);
      if (!ps.length) continue;
      const members = ps.flatMap((p) => p.members);
      const time = a.time || localTime(ps.reduce((m, p) => (p.created_at < m ? p.created_at : m), ps[0].created_at));
      rows.push({
        center_id: centerId, act_date: date, act_time: time,
        kind: a.kind,
        title: String(a.title || "").slice(0, 80) || null,
        details: String(a.details || "").slice(0, 400) || null,
        child_ids: kidsOf(members),
        photo_ids: members.map((m) => m.id),
        source: "ai", created_by: "Recognized from photos"
      });
    }

    // 7. Replace earlier photo-recognized entries for that day; teacher entries are untouched
    await sbFetch(`/rest/v1/activities?center_id=eq.${encodeURIComponent(centerId)}&act_date=eq.${date}&source=eq.ai`, token, { method: "DELETE" });
    if (rows.length) await sbFetch("/rest/v1/activities", token, { method: "POST", body: JSON.stringify(rows), headers: { Prefer: "return=minimal" } });

    return send(res, 200, { added: rows.length, photos: usable.length, activities: rows.map((r) => ({ kind: r.kind, title: r.title, time: r.act_time, children: r.child_ids ? r.child_ids.map((id) => nameOf[id]) : ["Whole class"] })) });
  } catch (e) {
    return send(res, e.status === 401 ? 401 : 500, { error: e.message || "Something went wrong." });
  }
};
