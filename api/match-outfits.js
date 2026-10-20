// Sanora: place group photos where no face could be matched, by comparing CLOTHING with today's outfits.
//
// POST /api/match-outfits   { center_id, refs: [{ child_id, image }], photos: [{ n, image }] }
//   refs   = clothing crops (chin down, no face) of children already matched by face in today's upload,
//            one per child, made on the teacher's phone. Only children with photo matching turned on.
//   photos = the photos that had no face match (small JPEGs), base64 without the data: prefix.
// Header: Authorization: Bearer <the signed-in teacher's Supabase access token>
//
// The model only compares outfits (colors, prints, patterns, clothing items). It never sees names and is
// told not to use faces. Children are labeled "Outfit 1, 2, ..." and mapped back to ids here.
// Returns { matches: [{ n, child_ids: [...] }] }.

const SUPABASE_URL = process.env.SUPABASE_URL || "https://fzuupmauwfgrbsmvsmrj.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_PIYNPbVjx1RlIdPOqVoO5g_Nr5mLlx7";
const ANTHROPIC_URL = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1/messages";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const RAW_KEY = (process.env.ANTHROPIC_API_KEY || "").trim().replace(/^["']|["']$/g, "").trim();
const API_KEY = (RAW_KEY.match(/sk-ant-[A-Za-z0-9_-]+/) || [RAW_KEY])[0];
const MAX_REFS = 15, MAX_PHOTOS = 12, MAX_B64 = 3_500_000;   // stay under Vercel's 4.5 MB request limit

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
const isB64 = (s) => typeof s === "string" && s.length > 100 && /^[A-Za-z0-9+/=]+$/.test(s.slice(0, 200));

const TOOL = {
  name: "record_outfit_matches",
  description: "For each numbered photo, list the reference outfits that are clearly worn by a child in that photo.",
  input_schema: {
    type: "object",
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            photo: { type: "integer", description: "Photo number as labeled." },
            outfits: { type: "array", items: { type: "integer" }, description: "Outfit numbers clearly visible in this photo. Empty if none or unsure." }
          },
          required: ["photo", "outfits"]
        }
      }
    },
    required: ["matches"]
  }
};

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
  if (!API_KEY) return send(res, 503, { error: "ANTHROPIC_API_KEY is not set in Vercel." });
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return send(res, 401, { error: "Sign in first." });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { center_id: centerId, refs = [], photos = [] } = body || {};
  if (!centerId || !/^[a-z0-9-]{1,60}$/.test(centerId)) return send(res, 400, { error: "center_id is required." });
  if (!Array.isArray(refs) || !Array.isArray(photos) || !refs.length || !photos.length) return send(res, 200, { matches: [] });
  if (refs.length > MAX_REFS || photos.length > MAX_PHOTOS) return send(res, 400, { error: `At most ${MAX_REFS} outfits and ${MAX_PHOTOS} photos per request.` });
  if (![...refs, ...photos].every((x) => isB64(x && x.image))) return send(res, 400, { error: "Images must be base64 JPEGs." });
  if ([...refs, ...photos].reduce((n, x) => n + x.image.length, 0) > MAX_B64) return send(res, 413, { error: "Images too large." });

  try {
    // Staff only, for their own center; references must be that center's children with photo matching on
    const prof = await sbFetch("/rest/v1/rpc/my_profile", token, { method: "POST", body: "{}" });
    if (!prof || !["admin", "head", "teacher"].includes(prof.role)) return send(res, 403, { error: "Only teachers can do this." });
    if (prof.role !== "admin" && prof.center_id !== centerId) return send(res, 403, { error: "That isn't your center." });
    const ids = [...new Set(refs.map((r) => String(r.child_id)))].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
    if (!ids.length) return send(res, 200, { matches: [] });
    const ok = await sbFetch(`/rest/v1/children?select=id&center_id=eq.${encodeURIComponent(centerId)}&photo_match_ok=is.true&id=in.(${ids.join(",")})`, token);
    const allowed = new Set((ok || []).map((k) => k.id));
    const useRefs = refs.filter((r) => allowed.has(String(r.child_id)));
    if (!useRefs.length) return send(res, 200, { matches: [] });

    const content = [];
    useRefs.forEach((r, i) => {
      content.push({ type: "text", text: `Outfit ${i + 1}:` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: r.image } });
    });
    photos.forEach((p, i) => {
      content.push({ type: "text", text: `Photo ${i + 1}:` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: p.image } });
    });
    content.push({ type: "text", text: [
      "These are photos from one day at a small daycare. Each 'Outfit' image is a crop of the clothes one child is wearing today (each outfit is a different child).",
      "For each Photo, decide which outfits are clearly worn by a child in it, comparing only the clothing: colors, prints, patterns, logos, and the type of garment (dress, t-shirt, pants, shorts, socks, shoes).",
      "Do not use faces or try to recognize anyone. Children can wear similar colors, so only list an outfit when the clothing clearly matches in several details. If unsure, leave it out.",
      "Return every photo, with an empty list when no outfit clearly matches. Call the record_outfit_matches tool. If you can't use the tool, reply with only JSON: {\"matches\": [{\"photo\": 1, \"outfits\": [2]}]}."
    ].join("\n") });

    const ar = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 800, tools: [TOOL], tool_choice: { type: "auto" }, messages: [{ role: "user", content }] })
    });
    const aj = await ar.json();
    if (!ar.ok) return send(res, 502, { error: "Outfit matching failed: " + ((aj && aj.error && aj.error.message) || ar.status) });
    const call = (aj.content || []).find((c) => c.type === "tool_use" && c.name === TOOL.name);
    let found = call && call.input && Array.isArray(call.input.matches) ? call.input.matches : null;
    if (!found) {
      const text = (aj.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const m = text.match(/\{[\s\S]*\}/);
      try { const parsed = m ? JSON.parse(m[0]) : null; found = parsed && Array.isArray(parsed.matches) ? parsed.matches : []; } catch { found = []; }
    }
    const matches = [];
    for (const m of found) {
      const p = photos[(Number(m.photo) || 0) - 1];
      if (!p) continue;
      const kids = [...new Set((m.outfits || []).map((o) => useRefs[(Number(o) || 0) - 1]).filter(Boolean).map((r) => String(r.child_id)))];
      if (kids.length) matches.push({ n: p.n, child_ids: kids });
    }
    return send(res, 200, { matches });
  } catch (e) {
    return send(res, e.status === 401 ? 401 : 500, { error: e.message || "Something went wrong." });
  }
};
