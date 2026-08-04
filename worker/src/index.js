/**
 * Clips2Story live storyboard planner -- Cloudflare Worker.
 *
 * The ONLY server-side piece of this demo (see ../../README.md and
 * docs/design-plan.md). It is deliberately minimal: it does not embed
 * text, does not do retrieval, does not render video, and holds no model of
 * its own. The browser (assets/js/semantic-search.js) already ran retrieval
 * client-side and sends the resulting candidate pool; this Worker's only
 * jobs are:
 *
 *   1. Build the exact Clips2Story-NF prompt (Appendix B of the paper,
 *      verbatim) from that pool + the reviewer's keyword.
 *   2. Call the LLM once.
 *   3. Validate the response against hard constraints (every clip_id must
 *      be one that was actually offered; every trim must be within the
 *      clip's own duration) and remap the LLM's clip-relative start/end
 *      offsets back to absolute positions in the source video.
 *   4. Rate-limit and cache in KV so repeated/concurrent identical
 *      requests are instant and don't re-spend LLM budget.
 *
 * No GPU, no persistent process, no state beyond two small KV namespaces.
 */

const SYSTEM_PROMPT =
  "You are an expert AI video editor and planning assistant. Convert the user's editing request into a storyboard (sequence of footage segments) in strict JSON.";

const RULES_AND_SCHEMA = `TASK
Produce an ordered sequence of footage segments. Each item in the sequence has a "segments" list containing the footage segments that tell the story.

You may select, skip, trim, or reorder clips as needed. When trimming, define the exact start_time and end_time (relative to the start of that clip, in seconds, from 0 up to the clip's own duration) to extract the specific part of the clip you want to use, while respecting transcript sentence boundaries. Choose as many sequence items as needed so that the total runtime is approximately 3-5 minutes.

RULES
1. Compose a coherent story arc with a strong hook, clear progression, and a satisfying payoff. Infer intent from the user request, including topic, tone, and pacing.
2. Select footage using transcript, caption, background, and entity evidence; prefer strong matches. Ensure that the sequence of clips flows naturally to tell the story.
3. Choose clips and precisely define their start_time/end_time (relative to that clip, 0 = clip start) to trim the footage to the exact moments needed. Do not trim mid-sentence. If a clip contains speech, the start_time and end_time must exactly match transcript timestamp brackets, never intermediate points. Do not feel constrained to use the full clip duration.
4. Choose as many segments as needed so that the total runtime, defined as the sum of all selected clip durations, is approximately 3-5 minutes.
5. Do not invent any clips. Do not invent or output timestamps outside the bounds of the original clip duration (0 to the clip's listed duration).
6. For each selected segment, include "duration" (computed as end_time - start_time) and "transcript" containing only the transcript text that falls within the selected time span, preserving speaker labels and relative timestamps when present.
   - Do not paraphrase, summarize, or invent transcript text.
   - If no transcript is available for that clip or trimmed segment, output "transcript": "".

HARD CONSTRAINTS
- Each segment's clip_id must exactly match an available clip.
- Do not invent clips.
- start_time and end_time are relative to the clip itself (0 to the clip's duration), not to the source video.
- Output must be valid JSON only, with no markdown or extra text.

OUTPUT SCHEMA (STRICT)
[
  {
    "segments": [
      {
        "clip_id": "c_91f2a3",
        "start_time": 0.0,
        "end_time": 0.0,
        "duration": 0.0,
        "transcript": ""
      }
    ]
  }
]

Output only the JSON array, with no markdown and no extra text.`;

function buildClipsBlock(pool) {
  return pool
    .map((c) => {
      const transcript = (c.transcript || "").replace(/"/g, '\\"');
      const caption = (c.caption || "").replace(/"/g, '\\"');
      const entities = (c.entities || []).join(", ") || "none";
      return (
        `  - clip_id=${c.clipId}, duration=${c.duration.toFixed(2)}s\n` +
        `    transcript="${transcript}"\n` +
        `    caption="${caption}"\n` +
        `    background: ${c.background || "unknown"}\n` +
        `    entities: ${entities}`
      );
    })
    .join("\n\n");
}

function buildPrompt(keyword, pool) {
  const userRequest = `Create a catchy 3-5 minute mini-story about ${keyword}. Open with a strong hook, build curiosity and progression, and end with a satisfying payoff. Select and sequence footage that naturally builds this narrative.`;

  return (
    `${SYSTEM_PROMPT}\n\n` +
    `USER REQUEST\n${userRequest}\n\n` +
    `AVAILABLE CLIPS (UNORDERED POOL)\n` +
    `Each clip is independent raw footage. There is no implied chronological relationship by list order. ` +
    `Use only the provided clip_id strings when referencing clips in your timeline. Each clip includes transcript, caption, background, and entities.\n\n` +
    `${buildClipsBlock(pool)}\n\n` +
    `${RULES_AND_SCHEMA}`
  );
}

function jsonResponse(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

/** Strip control characters / normalize a raw LLM string response into JSON. */
function parseLlmJson(text) {
  const trimmed = text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  return JSON.parse(trimmed);
}

function flattenSegments(llmOutput) {
  if (!Array.isArray(llmOutput)) throw new Error("LLM output is not a JSON array");
  const segments = [];
  for (const item of llmOutput) {
    for (const seg of item.segments || []) segments.push(seg);
  }
  return segments;
}

/**
 * Hard-constraint validation + remap from clip-relative to absolute source
 * time. A single bad segment (invented clip_id, out-of-bounds trim) is
 * dropped, not treated as a reason to fail the entire storyboard -- for a
 * live reviewer-facing demo, "14 of 15 segments, one silently skipped" is a
 * much better failure mode than "502, please try again." Only throws if
 * literally nothing survives (nothing left to show).
 */
function validateAndRemap(segments, poolById) {
  const remapped = [];
  const dropped = [];

  for (const seg of segments) {
    const clip = poolById.get(seg.clip_id);
    if (!clip) {
      dropped.push({ clipId: seg.clip_id, reason: "unknown clip_id (not in the offered pool)" });
      continue;
    }
    const start = Number(seg.start_time);
    const end = Number(seg.end_time);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      dropped.push({ clipId: seg.clip_id, reason: `invalid start/end (${seg.start_time}-${seg.end_time})` });
      continue;
    }
    if (start < -0.05 || end > clip.duration + 0.05) {
      dropped.push({
        clipId: seg.clip_id,
        reason: `trim (${start}-${end}) outside clip duration (${clip.duration})`,
      });
      continue;
    }
    remapped.push({
      clipId: seg.clip_id,
      sourcePath: clip.sourcePath,
      startTime: clip.startTime + Math.max(0, start),
      endTime: clip.startTime + Math.min(clip.duration, end),
      duration: Math.min(clip.duration, end) - Math.max(0, start),
      transcript: seg.transcript || "",
      caption: clip.caption,
      background: clip.background,
      entities: clip.entities,
    });
  }

  if (remapped.length === 0) {
    throw new Error(
      `No valid segments survived validation (${dropped.length} dropped: ${dropped
        .map((d) => d.reason)
        .join("; ")})`
    );
  }
  return { segments: remapped, dropped };
}

/**
 * Matches src/pipeline/stage1_5_llm.py's _call_openai_5_2() in the main
 * research repo: the OpenAI Responses API (not Chat Completions), model
 * "gpt-5.2", `input` instead of `messages`. Kept in sync deliberately so
 * the live demo calls the LLM the same way the paper's actual pipeline
 * does, not a different endpoint that happens to also work.
 */
async function callLlm(env, prompt) {
  const model = env.LLM_MODEL || "gpt-5.2";
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      input: prompt,
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LLM call failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = await res.json();

  // Prefer the SDK-equivalent convenience field when the API includes it.
  let text = data.output_text;
  if (!text) {
    // Fall back to reconstructing from the raw output items, mirroring the
    // Python client's own fallback path in _call_openai_5_2().
    const items = data.output || data.outputs || [];
    text = items
      .flatMap((item) => item.content || [])
      .filter((c) => c.type === "output_text" || c.text)
      .map((c) => c.text || "")
      .join("");
  }
  if (!text) throw new Error("LLM response had no output_text content");
  return text;
}

async function rateLimitOk(env, ip) {
  if (!env.RATE_LIMIT) return true; // KV not bound (e.g. local dev) -- don't block
  const key = `rl:${ip}:${new Date().toISOString().slice(0, 13)}`; // per-IP, per-hour bucket
  const limit = Number(env.RATE_LIMIT_PER_HOUR || 8);
  const current = Number((await env.RATE_LIMIT.get(key)) || "0");
  if (current >= limit) return false;
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: 3600 });
  return true;
}

async function hashKey(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Use POST" }, 405, headers);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400, headers);
    }

    const { keyword, pool, videoId } = body || {};
    if (!keyword || typeof keyword !== "string" || keyword.length > 200) {
      return jsonResponse({ error: "Missing or invalid 'keyword'" }, 400, headers);
    }
    if (!Array.isArray(pool) || pool.length === 0 || pool.length > 200) {
      return jsonResponse({ error: "Missing or invalid 'pool'" }, 400, headers);
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!(await rateLimitOk(env, ip))) {
      return jsonResponse(
        { error: "Rate limit reached for this demo. Please try again in a bit, or browse the precomputed gallery below." },
        429,
        headers
      );
    }

    const normalizedKeyword = keyword.trim().toLowerCase();
    const cacheKey = `plan:${videoId || "unknown"}:${await hashKey(normalizedKeyword)}`;
    if (env.PLAN_CACHE) {
      const cached = await env.PLAN_CACHE.get(cacheKey, "json");
      if (cached) return jsonResponse({ ...cached, cached: true }, 200, headers);
    }

    const poolById = new Map(pool.map((c) => [c.clipId, c]));
    const prompt = buildPrompt(keyword, pool);

    try {
      const raw = await callLlm(env, prompt);
      const parsed = parseLlmJson(raw);
      const flat = flattenSegments(parsed);
      const { segments, dropped } = validateAndRemap(flat, poolById);

      const result = { segments, dropped, rawLlmOutput: parsed, prompt, cached: false };
      if (env.PLAN_CACHE) {
        await env.PLAN_CACHE.put(cacheKey, JSON.stringify(result), {
          expirationTtl: Number(env.CACHE_TTL_SECONDS || 86400),
        });
      }
      return jsonResponse(result, 200, headers);
    } catch (err) {
      return jsonResponse(
        { error: `Planning failed: ${err.message || String(err)}` },
        502,
        headers
      );
    }
  },
};
