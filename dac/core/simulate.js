/* ============================================================
   simulate.js ── 不足条件のシミュレーション
   instructions.md: 「構造化テキスト2に条件記述が不足する場合、追加条件により
   判定・義務がどう変わるかを代表的に例示し、シミュレーションできる」。
   - open: 規則に関与するが事実で確定していない（未記載 or unknown）入力リテラル
   - whatif: 各 open 条件を1つずつ確定させたときの判定・義務の変化（代表例）
   - sweep: open 真偽条件の組合せを総当りし、結果クラス（判定×義務集合）ごとに代表例
   ============================================================ */
"use strict";
const { judge } = require("./engine.js");
const { obligations } = require("./obligations.js");

function collectReferencedLiterals(rb) {
  const set = new Set();
  const addBody = body => (body || []).forEach(it => {
    if (typeof it === "string") set.add(it);
    else if (it.any) it.any.forEach(l => set.add(l));
  });
  (rb.strict || []).forEach(r => addBody(r.body));
  (rb.defeasible || []).forEach(r => addBody(r.body));
  (rb.undercut || []).forEach(r => addBody(r.body));
  (rb.obligations || []).forEach(o => { if (o.role) set.add(o.role); });
  return set;
}

function outcomeOf(facts, rb) {
  const j = judge(facts, rb);
  const o = obligations(facts, rb, j);
  const oblIds = o.applicable.map(a => a.id).sort();
  // 分類ティア（verdict_map.classes のうち受理された結論。例: CRA の tier_class_II）
  const classes = new Set((rb.verdict_map && rb.verdict_map.classes) || []);
  const tier = (j.dual.bands || []).filter(b => b.label === "IN" && classes.has(b.claim)).map(b => b.claim);
  return {
    verdict: j.verdict, band4: j.dual.band4Verdict, provisional: j.provisional,
    tier: tier.length ? tier.join("+") : null,
    obligationIds: oblIds, obligationCount: oblIds.length, role: o.role, roleAssumed: o.roleAssumed
  };
}

function candidateValues(def) {
  if (def.datatype === "enum") {
    // 列挙は代表値1つ（先頭）で「該当用途あり」を例示。false（非該当）は baseline 側で表現。
    return [{ value: (def.enum || [])[0], note: "代表値" }];
  }
  return [{ value: true }, { value: false }];
}

function simulate(facts, rb, literals, opts = {}) {
  const maxSweepVars = opts.maxSweepVars || 4;
  const litDefs = {};
  (literals.literals || []).forEach(d => litDefs[d.id] = d);
  const referenced = collectReferencedLiterals(rb);

  const baseline = outcomeOf(facts, rb);

  // open = 規則に関与する input リテラルで、事実が未確定（未記載 / unknown）
  const open = [];
  for (const d of (literals.literals || [])) {
    if (d.kind !== "input") continue;
    if (!referenced.has(d.id)) continue;
    const f = facts[d.id];
    const undecided = !f || f.confidence === "unknown" || f.value === undefined || f.value === null;
    if (undecided) open.push(d);
  }

  // whatif: 1条件ずつ確定
  const whatif = [];
  for (const d of open) {
    for (const cand of candidateValues(d)) {
      const facts2 = { ...facts, [d.id]: { value: cand.value, confidence: "confirmed", _simulated: true } };
      const out = outcomeOf(facts2, rb);
      whatif.push({
        literal: d.id, label: d.label, value: cand.value, note: cand.note || null,
        ...out,
        verdictChanged: out.verdict !== baseline.verdict,
        obligationsChanged: out.obligationCount !== baseline.obligationCount
          || JSON.stringify(out.obligationIds) !== JSON.stringify(baseline.obligationIds)
      });
    }
  }

  // sweep: open の真偽リテラルを総当り（cap 2^maxSweepVars）。結果クラスごとに代表例。
  // 変数は「whatif で判定または義務を動かした（=ピボタルな）条件」を優先選択する。
  const impact = {};
  for (const w of whatif) {
    if (w.verdictChanged || w.obligationsChanged) impact[w.literal] = true;
  }
  const boolOpenAll = open.filter(d => d.datatype !== "enum");
  const boolOpen = boolOpenAll
    .slice()
    .sort((a, b) => (impact[b.id] ? 1 : 0) - (impact[a.id] ? 1 : 0))
    .slice(0, maxSweepVars);
  const classes = {};
  const sweepTotal = 1 << boolOpen.length;
  for (let mask = 0; mask < sweepTotal; mask++) {
    const assign = {};
    const facts2 = { ...facts };
    boolOpen.forEach((d, i) => {
      const v = !!(mask & (1 << i));
      assign[d.id] = v;
      facts2[d.id] = { value: v, confidence: "confirmed", _simulated: true };
    });
    const out = outcomeOf(facts2, rb);
    const key = out.verdict + " | " + out.obligationIds.join(",");
    if (!classes[key]) classes[key] = { verdict: out.verdict, band4: out.band4, tier: out.tier,
      obligationIds: out.obligationIds, obligationCount: out.obligationCount, representativeAssignment: assign, count: 0 };
    classes[key].count++;
  }

  return {
    baseline,
    openLiterals: open.map(d => ({ id: d.id, label: d.label, datatype: d.datatype, open_texture: !!d.open_texture })),
    whatif,
    sweep: {
      variables: boolOpen.map(d => d.id),
      combinations: sweepTotal,
      truncated: open.filter(d => d.datatype !== "enum").length > maxSweepVars,
      classes: Object.values(classes)
    }
  };
}

module.exports = { simulate, collectReferencedLiterals };
