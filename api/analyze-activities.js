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
const MAX_PHOTOS = 20;

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

const TOOL = {
  name: "record_activities",
  description: "Record the distinct activities the children were doing in the day's photos.",
  input_schema: {
    type: "object",
    properties: {
      activities: {
        type: "array",
        description: "At most one entry per category. Put every photo showing that category into that entry. Leave out categories already logged by teachers.",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: KINDS, description: "The category this activity belongs to. Use 'Other' only when none of the others fit." },
            title: { type: "string", description: "Short, specific name, e.g. 'Leaf painting', 'Building block towers'. Max 6 words." },
            details: { type: "string", description: "One warm, factual sentence for parents describing what the children did. No names, no guesses about feelings beyond what is visible." },
            photos: { type: "array", items: { type: "integer" }, description: "Photo numbers (as labeled) that show this activity." }
          },
          required: ["kind", "title", "details", "photos"]
        }
      }
    },
    required: ["activities"]
  }
};

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
  if (!process.env.ANTHROPIC_API_KEY) return send(res, 503, { error: "Photo recognition isn't switched on yet: ANTHROPIC_API_KEY is not set in Vercel." });
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

    // 2. The center's children and that day's photos
    const kids = await sbFetch(`/rest/v1/children?select=id,name&center_id=eq.${encodeURIComponent(centerId)}`, token);
    if (!kids.length) return send(res, 200, { added: 0, activities: [], note: "No children in this center yet." });
    const nameOf = Object.fromEntries(kids.map((k) => [k.id, k.name]));
    const ids = kids.map((k) => k.id).join(",");
    let photos = await sbFetch(`/rest/v1/photos?select=id,child_id,path,created_at&taken_on=eq.${date}&child_id=in.(${ids})&order=created_at.desc&limit=${MAX_PHOTOS}`, token);
    photos = photos.reverse();   // oldest first, so photo numbers follow the day
    if (!photos.length) return send(res, 200, { added: 0, activities: [], note: "No photos for this day yet." });

    // 3. Short-lived links the model can fetch
    const signed = await sbFetch("/storage/v1/object/sign/photos", token, { method: "POST", body: JSON.stringify({ expiresIn: 600, paths: photos.map((p) => p.path) }) });
    const urlFor = {};
    (signed || []).forEach((s) => { if (s.signedURL && !s.error) urlFor[s.path] = SUPABASE_URL + "/storage/v1" + s.signedURL; });
    const usable = photos.filter((p) => urlFor[p.path]);
    if (!usable.length) return send(res, 200, { added: 0, activities: [], note: "Couldn't open the photos." });

    // 4. What teachers already logged that day (kept as is; the model skips these)
    const existing = await sbFetch(`/rest/v1/activities?select=kind,title,details,source&center_id=eq.${encodeURIComponent(centerId)}&act_date=eq.${date}&source=neq.ai`, token);

    // 5. Ask Claude
    const content = [];
    usable.forEach((p, i) => {
      content.push({ type: "text", text: `Photo ${i + 1} (child: ${nameOf[p.child_id] || "unknown"})` });
      content.push({ type: "image", source: { type: "url", url: urlFor[p.path] } });
    });
    content.push({
      type: "text",
      text: [
        `These are photos from one day (${date}) at a small home daycare and preschool for children aged 10 months to 5 years.`,
        "Check every photo against each of these activity categories:\n" + CATEGORIES.map(([k, d]) => `- ${k}: ${d}`).join("\n"),
        "Return at most one entry per category, listing all the photos that show it. If one photo clearly shows two categories, it may appear in both.",
        "Ignore photos that don't show a clear activity (e.g. just a portrait, a nap or a meal). Use 'Other' only when nothing else fits.",
        existing.length
          ? "Teachers already logged these activities today. Do NOT return entries for these categories:\n" + existing.map((a) => `- ${a.kind}: ${a.title || a.kind}${a.details ? " (" + a.details + ")" : ""}`).join("\n")
          : "Teachers haven't logged any activities today.",
        "Describe only what is visible. Never mention children's names or appearance in the title or details. If there is nothing new, return an empty list.",
        "Call record_activities with the result."
      ].join("\n\n")
    });
    const ar = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, tools: [TOOL], tool_choice: { type: "tool", name: TOOL.name }, messages: [{ role: "user", content }] })
    });
    const aj = await ar.json();
    if (!ar.ok) return send(res, 502, { error: "Photo recognition failed: " + ((aj && aj.error && aj.error.message) || ar.status) });
    const call = (aj.content || []).find((c) => c.type === "tool_use" && c.name === TOOL.name);
    const found = (call && call.input && Array.isArray(call.input.activities)) ? call.input.activities : [];

    // 6. Turn the result into activity rows: one per category, never a category a teacher already logged
    const taken = new Set(existing.map((a) => a.kind));
    const byKind = new Map();
    for (const a of found) {
      const kind = KINDS.includes(a.kind) ? a.kind : "Other";
      if (taken.has(kind)) continue;
      if (!byKind.has(kind)) byKind.set(kind, { ...a, kind, photos: [] });
      const m = byKind.get(kind); m.photos = [...new Set([...m.photos, ...(a.photos || [])])];
    }
    const rows = [];
    for (const a of byKind.values()) {
      const ps = (a.photos || []).map((n) => usable[n - 1]).filter(Boolean);
      if (!ps.length) continue;
      const first = ps.reduce((m, p) => (p.created_at < m ? p.created_at : m), ps[0].created_at);
      const local = new Date(Date.parse(first) - (Number(tz) || 0) * 60000);   // tz_offset_min = Date.getTimezoneOffset()
      const hhmm = `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
      rows.push({
        center_id: centerId, act_date: date, act_time: hhmm,
        kind: KINDS.includes(a.kind) ? a.kind : "Other",
        title: String(a.title || "").slice(0, 80) || null,
        details: String(a.details || "").slice(0, 400) || null,
        child_ids: [...new Set(ps.map((p) => p.child_id))],
        photo_ids: ps.map((p) => p.id),
        source: "ai", created_by: "Recognized from photos"
      });
    }

    // 7. Replace earlier photo-recognized entries for that day; teacher entries are untouched
    await sbFetch(`/rest/v1/activities?center_id=eq.${encodeURIComponent(centerId)}&act_date=eq.${date}&source=eq.ai`, token, { method: "DELETE" });
    if (rows.length) await sbFetch("/rest/v1/activities", token, { method: "POST", body: JSON.stringify(rows), headers: { Prefer: "return=minimal" } });

    return send(res, 200, { added: rows.length, photos: usable.length, activities: rows.map((r) => ({ kind: r.kind, title: r.title, children: r.child_ids.map((id) => nameOf[id]) })) });
  } catch (e) {
    return send(res, e.status === 401 ? 401 : 500, { error: e.message || "Something went wrong." });
  }
};
