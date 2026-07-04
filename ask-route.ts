// ────────────────────────────────────────────────────────────────────────────
// app/api/ask/route.ts  —  Next.js App Router serverless endpoint
//
// Auditron's GPT layer. Runs on Vercel. The OpenAI key lives here (server-side)
// and is NEVER shipped to the browser.
//
// Contract: the browser has already parsed files and computed a `ComputedAnswer`
// locally (numbers, table, steps). It sends that here. GPT's ONLY job is to
// narrate it as an Amazon expert. GPT may not invent, alter, or recompute any
// number. temperature: 0. If GPT fails, the browser still shows the computed
// answer — so a failure here degrades to "no prose", never "no answer".
// ────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge"; // fast cold starts

interface ComputedAnswer {
  headline: string;
  facts: string[];
  table: { cols: string[]; rows: (string | number)[][] } | null;
  steps: string[];
  intent?: string;
}

interface Body {
  computed: ComputedAnswer;
  question: string;
  account?: string;
  history?: { role: "user" | "assistant"; content: string }[];
}

const SYSTEM = `You are Auditron — a Senior Director of Amazon Advertising and Retail Media with 15+ years across Vendor Central and Seller Central. You advise brand managers and VPs. Your voice is decisive, quantified, and executive. You never hedge.

ABSOLUTE RULES (breaking any makes your answer worthless):

1. NUMBERS ARE SACRED. Every number, dollar amount, percentage, ASIN, keyword, and campaign name in your reply MUST appear verbatim in the DATA block below. Never invent, estimate, re-round, recalculate, or infer a figure that isn't in the DATA. If it's not in the DATA, don't say it.

2. YOU DO NOT DO MATH. The engine already computed everything. You translate pre-computed facts into clear prose. If you feel the urge to calculate, stop — the number is already in the DATA.

3. LEAD WITH THE HEADLINE finding, plainly. Support with the facts. Close with the action.

4. BE DIRECTIVE. "Pause these 6 keywords to recover $1,847" — not "you may wish to review some keywords." Name the ASIN, quote the ACOS, state the dollar recovery.

5. DON'T REPRODUCE THE TABLE. A data table renders separately below your text. Reference it ("the table below ranks all 14") and highlight only the 1–3 rows that matter most.

6. ACCOUNT-AWARE. This is a {ACCOUNT} account — use the right vocabulary (Vendor: ordered revenue, shipped COGS, glance views; Seller: sessions, buy box, units). Never mix them.

7. LENGTH: 2–4 tight paragraphs, or a short lead + up to 5 bullet actions. No padding. If the DATA shows nothing to worry about, say so in one line.

8. NO disclaimers, no "as an AI", no apologies.

You are the expert the reader wishes they could hire. Sound like it.`;

function payload(c: ComputedAnswer, q: string): string {
  const tbl =
    c.table && c.table.rows.length
      ? `TABLE (${c.table.rows.length} rows, shown separately — reference, don't reproduce):
${c.table.cols.join(" | ")}
${c.table.rows.slice(0, 6).map((r) => r.join(" | ")).join("\n")}`
      : "TABLE: none";
  return `USER QUESTION: "${q}"

=== PRE-COMPUTED DATA (ground truth — every number you use must be here) ===
HEADLINE: ${c.headline}

FACTS:
${c.facts.map((f) => `• ${f}`).join("\n")}

${tbl}

RECOMMENDED NEXT STEPS:
${c.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}
=== END DATA ===

Write the expert response now. Lead with the headline, support with facts, close with prioritized actions. Every number verbatim from above.`;
}

export async function POST(req: NextRequest) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return NextResponse.json({ error: "OPENAI_API_KEY not set in Vercel env vars", source: "fallback" }, { status: 500 });

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON", source: "fallback" }, { status: 400 });
  }
  const { computed, question, account = "vendor", history = [] } = body;
  if (!computed || !question) return NextResponse.json({ error: "Missing computed or question", source: "fallback" }, { status: 400 });

  const messages = [
    { role: "system", content: SYSTEM.replace("{ACCOUNT}", account) },
    ...history.slice(-4),
    { role: "user", content: payload(computed, question) },
  ];

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "gpt-4o", messages, temperature: 0, max_tokens: 700, top_p: 1 }),
    });
    if (!r.ok) {
      const t = await r.text();
      return NextResponse.json({ error: `OpenAI ${r.status}: ${t}`, source: "fallback" }, { status: 502 });
    }
    const out = await r.json();
    const answer = out?.choices?.[0]?.message?.content?.trim();
    if (!answer) return NextResponse.json({ error: "Empty response", source: "fallback" }, { status: 502 });
    return NextResponse.json({ answer, source: "gpt" });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Network error", source: "fallback" }, { status: 502 });
  }
}
