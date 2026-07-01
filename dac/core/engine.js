/* ============================================================
   engine.js ── DAC v6 推論コア（規制非依存 / regulation-independent）
   形式: ASPIC+風 defeasible 論証 + Dung grounded labeling + 四帯 L⊆DEF⊆U⊆A
   入力: judge(facts, rulepack)。rulepack は 30_rulepack.json と同一スキーマ。
   規制固有性は rulepack に閉じる（SystemTheory A8）。結論リテラルの判定は
   rulepack.verdict_map で外部化されており、エンジン本体は規制内容を含まない。
   Node / ブラウザ両用。
   ============================================================ */
"use strict";

/* ---------- 信認状態ユーティリティ ---------- */
const CONF_ORDER = { confirmed: 0, presumed: 1, unknown: 2 };
function worse(a, b) { return (CONF_ORDER[a] >= CONF_ORDER[b]) ? a : b; }

function factHolds(facts, lit) {
  const f = facts[lit];
  return !!(f && f.value !== false && f.value !== undefined && f.value !== null && f.value !== "");
}

/* ---------- 結論リテラル判定（verdict_map で外部化） ---------- */
function makeConclTest(rb) {
  const vm = rb.verdict_map;
  if (vm && (vm.positive || vm.negative || vm.classes)) {
    const pos = new Set(vm.positive || []);
    const neg = new Set(vm.negative || []);
    // classes: verdict（positive/negative）には効かないが結論として扱う分類リテラル
    // （例: CRA の適合性評価ティア tier_default/class_I/class_II/critical）。
    const cls = new Set(vm.classes || []);
    return {
      isPositive: c => pos.has(c),
      isNegative: c => neg.has(c),
      isConcl: c => pos.has(c) || neg.has(c) || cls.has(c)
    };
  }
  // 後方互換: verdict_map が無いルールパック（構造テスト等）向けの規約
  return {
    isPositive: c => c.startsWith("high_risk@"),
    isNegative: c => c === "not_high_risk",
    isConcl: c => c.startsWith("high_risk@") || c === "not_high_risk"
  };
}

/* ---------- strict 閉包 ---------- */
function deriveStrict(facts, rb) {
  const derived = {};
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of rb.strict || []) {
      const head = r.head;
      if (factHolds(facts, head) || derived[head]) continue;
      const ev = evalBody(facts, derived, r.body);
      if (ev.ok) { derived[head] = { conf: ev.conf, used: ev.used, ref: r.ref, via: ev.via }; changed = true; }
    }
  }
  return derived;
}

function evalBody(facts, derived, body) {
  let conf = "confirmed";
  const used = [], via = [], anyChoices = [];
  for (const item of body) {
    if (typeof item === "string") {
      const info = litInfo(facts, derived, item);
      if (!info.holds) return { ok: false };
      conf = worse(conf, info.conf);
      info.used.forEach(u => used.push(u));
    } else if (item.any) {
      const holding = item.any.filter(l => litInfo(facts, derived, l).holds);
      if (holding.length === 0) return { ok: false };
      anyChoices.push(holding);
      const best = holding.map(l => litInfo(facts, derived, l)).sort((a, b) => CONF_ORDER[a.conf] - CONF_ORDER[b.conf])[0];
      conf = worse(conf, best.conf);
      holding.forEach(h => via.push(h));
      best.used.forEach(u => used.push(u));
    }
  }
  return { ok: true, conf, used: [...new Set(used)], via: [...new Set(via)], anyChoices };
}

function litInfo(facts, derived, lit) {
  if (factHolds(facts, lit)) {
    const c = (facts[lit] && facts[lit].confidence) || "confirmed";
    return { holds: true, conf: c, used: [lit] };
  }
  if (derived[lit]) return { holds: true, conf: derived[lit].conf, used: derived[lit].used };
  return { holds: false };
}

/* ---------- 引数構築 ---------- */
function buildArguments(facts, rb) {
  const derived = deriveStrict(facts, rb);
  const args = [];
  let n = 0;
  const mk = o => { o.id = "A" + (++n); return o; };

  for (const r of rb.defeasible || []) {
    const ev = evalBody(facts, derived, r.body);
    if (!ev.ok) continue;
    const groups = ev.anyChoices.length ? ev.anyChoices : [[null]];
    for (const choice of groups[0]) {
      const viaSel = choice ? [choice] : [];
      const conf = choice ? worse(plainConf(facts, derived, r.body), litInfo(facts, derived, choice).conf)
                          : plainConf(facts, derived, r.body);
      const used = collectUsed(facts, derived, r.body, choice);
      args.push(mk({ ruleId: r.id, kind: "defeasible", claim: r.head, ref: r.ref, backing: r.backing || [], via: viaSel, conf, used }));
    }
  }
  for (const r of rb.undercut || []) {
    const ev = evalBody(facts, derived, r.body);
    if (!ev.ok) continue;
    args.push(mk({ ruleId: r.id, kind: "undercut",
      claim: "undercut(" + r.target.ruleId + (r.target.via ? "," + r.target.via : "") + ")",
      ref: r.ref, backing: r.backing || [], note: r.note, target: r.target, conf: ev.conf, used: ev.used, via: [] }));
  }
  return { args, derived };
}

function plainConf(facts, derived, body) {
  let conf = "confirmed";
  for (const item of body) if (typeof item === "string") {
    const info = litInfo(facts, derived, item);
    if (info.holds) conf = worse(conf, info.conf);
  }
  return conf;
}
function collectUsed(facts, derived, body, choice) {
  const used = new Set();
  for (const item of body) {
    if (typeof item === "string") litInfo(facts, derived, item).used?.forEach(u => used.add(u));
    else if (item.any && choice) litInfo(facts, derived, choice).used?.forEach(u => used.add(u));
  }
  return [...used];
}

/* ---------- 攻撃→敗北（defeat） ---------- */
function computeDefeats(args, rb) {
  const defeats = [];
  const sup = new Set((rb.superiority || []).map(p => p[0] + ">" + p[1]));
  const isSup = (a, b) => sup.has(a + ">" + b);
  for (const u of args) {
    if (u.kind !== "undercut") continue;
    for (const t of args) {
      if (t.id === u.id) continue;
      if (t.ruleId === u.target.ruleId && (!u.target.via || t.via.includes(u.target.via)))
        defeats.push({ from: u.id, to: t.id, type: "undercut" });
    }
  }
  for (const [x, y] of rb.conflicts || []) {
    const xs = args.filter(a => a.claim === x);
    const ys = args.filter(a => a.claim === y);
    for (const a of xs) for (const b of ys) {
      if (a.id === b.id) { defeats.push({ from: a.id, to: b.id, type: "rebut" }); continue; }
      if (!isSup(b.ruleId, a.ruleId)) defeats.push({ from: a.id, to: b.id, type: "rebut" });
      if (!isSup(a.ruleId, b.ruleId)) defeats.push({ from: b.id, to: a.id, type: "rebut" });
    }
  }
  return defeats;
}

/* ---------- grounded ラベリング ---------- */
function grounded(args, defeats) {
  const attackers = {};
  args.forEach(a => attackers[a.id] = []);
  defeats.forEach(d => attackers[d.to].push(d.from));
  const label = {};
  let progress = true;
  while (progress) {
    progress = false;
    for (const a of args) {
      if (label[a.id]) continue;
      const atk = attackers[a.id];
      if (atk.every(x => label[x] === "OUT")) { label[a.id] = "IN"; progress = true; }
      else if (atk.some(x => label[x] === "IN")) { label[a.id] = "OUT"; progress = true; }
    }
  }
  args.forEach(a => { if (!label[a.id]) label[a.id] = "UNDEC"; });
  return { label, attackers };
}

/* ---------- judge() 本体 ---------- */
function judge(facts, rb) {
  if (!rb) throw new Error("judge(facts, rulepack): rulepack が未指定です");
  const T = makeConclTest(rb);
  const { args, derived } = buildArguments(facts, rb);
  const defeats = computeDefeats(args, rb);
  const { label, attackers } = grounded(args, defeats);

  const byId = Object.fromEntries(args.map(a => [a.id, a]));
  const inArgs = args.filter(a => label[a.id] === "IN");
  const concl = a => T.isConcl(a.claim);

  const posIn = inArgs.filter(a => T.isPositive(a.claim));
  const negIn = inArgs.filter(a => T.isNegative(a.claim));
  const undecRel = args.filter(a => label[a.id] === "UNDEC" && concl(a));

  const L = (rb.verdict_map && rb.verdict_map.labels) || {};
  const POS = L.positive || "POSITIVE", NEG = L.negative || "NEGATIVE", UND = L.undetermined || "UNDETERMINED";

  let verdict, verdictReason;
  if (posIn.length) { verdict = POS; verdictReason = posIn.map(a => a.ref).join(", "); }
  else if (undecRel.length) { verdict = UND; verdictReason = "結論に関与する論点が未決（要人間判断）"; }
  else if (negIn.length) { verdict = NEG; verdictReason = negIn.map(a => a.ref).join(", "); }
  else { verdict = NEG; verdictReason = "該当する分類経路なし"; }

  let decisive = (verdict === POS) ? posIn : negIn;
  let provisional = decisive.some(a => a.conf !== "confirmed");

  const openIssues = Object.entries(facts)
    .filter(([k, v]) => v && (v.confidence === "presumed" || v.confidence === "unknown"))
    .map(([k, v]) => ({ literal: k, confidence: v.confidence, reference: v.reference || null }));

  const rejected = args.filter(a => label[a.id] === "OUT" && concl(a)).map(a => ({
    claim: a.claim, rule: a.ruleId, reference: a.ref, status: "OUT", via: a.via,
    defeatedBy: attackers[a.id].map(x => ({ rule: byId[x].ruleId, claim: byId[x].claim, reference: byId[x].ref,
      type: (defeats.find(d => d.from === x && d.to === a.id) || {}).type }))
  }));

  function buildGameTree(argId, player, path) {
    const a = byId[argId];
    const node = { argId, ruleId: a.ruleId, claim: a.claim, reference: a.ref, note: a.note || null,
      via: a.via || [], confidence: a.conf || null, used: a.used || [],
      player, label: label[argId], children: [], status: null, statusNu: null, repeat: false };
    const pos = argId + "|" + player;
    if (path.includes(pos)) {
      node.repeat = true;
      node.status   = (player === "OPP") ? "WON" : "LOST";
      node.statusNu = (player === "PRO") ? "WON" : "LOST";
      return node;
    }
    const newPath = path.concat([pos]);
    for (const d of defeats.filter(d => d.to === argId)) {
      const child = buildGameTree(d.from, player === "PRO" ? "OPP" : "PRO", newPath);
      child.attackType = d.type;
      node.children.push(child);
    }
    node.status   = node.children.every(c => c.status   === "LOST") ? "WON" : "LOST";
    node.statusNu = node.children.every(c => c.statusNu === "LOST") ? "WON" : "LOST";
    return node;
  }
  const bandOf = id => label[id] === "IN" ? "ESTABLISHED" : (label[id] === "UNDEC" ? "BURDEN_SENSITIVE" : "EXCLUDED");
  const conclArgs = args.filter(concl);
  const games = conclArgs.map(a => ({
    rootClaim: a.claim, rootRule: a.ruleId, outcome: label[a.id], band: bandOf(a.id),
    tree: buildGameTree(a.id, "PRO", [])
  }));

  const inU = id => label[id] !== "OUT";
  const posArgs = conclArgs.filter(a => T.isPositive(a.claim));
  const dual = {
    bands: conclArgs.map(a => ({ claim: a.claim, rule: a.ruleId, label: label[a.id], band: bandOf(a.id) })),
    coincide: !args.some(a => label[a.id] === "UNDEC"),
    readings: {
      skeptical: verdict,
      credulous: posArgs.some(a => inU(a.id)) ? POS : NEG
    }
  };

  const defeatEdge = new Set(defeats.map(d => d.from + ">" + d.to));
  const hits = (x, y) => defeatEdge.has(x + ">" + y);
  const defeatersOf = id => defeats.filter(d => d.to === id).map(d => d.from);
  const conflictsWith = (c, S) => {
    if (hits(c, c)) return true;
    for (const s of S) if (hits(c, s) || hits(s, c)) return true;
    return false;
  };
  function findAdmissible(S) {
    for (const s of S) {
      for (const b of defeatersOf(s)) {
        let defended = false;
        for (const t of S) if (hits(t, b)) { defended = true; break; }
        if (!defended) {
          for (const c of defeatersOf(b)) {
            if (S.has(c) || conflictsWith(c, S)) continue;
            const r = findAdmissible(new Set([...S, c]));
            if (r) return r;
          }
          return null;
        }
      }
    }
    return S;
  }
  function credTree(id, S, path) {
    const a0 = byId[id];
    const node = { argId: id, ruleId: a0.ruleId, claim: a0.claim, reference: a0.ref, via: a0.via || [], player: "PRO", reuse: false, children: [] };
    if (path.includes(id)) { node.reuse = true; return node; }
    const p2 = path.concat([id]);
    for (const b of defeatersOf(id)) {
      const ba = byId[b];
      const defender = [...S].find(t => hits(t, b));
      const opp = { argId: b, ruleId: ba.ruleId, claim: ba.claim, reference: ba.ref,
        attackType: (defeats.find(d => d.from === b && d.to === id) || {}).type, player: "OPP", children: [] };
      if (defender) opp.children.push(credTree(defender, S, p2));
      node.children.push(opp);
    }
    return node;
  }
  const credulousGames = conclArgs.map(a => {
    if (hits(a.id, a.id)) return { rootClaim: a.claim, rootRule: a.ruleId, defensible: false,
      failReason: "自己敗北（self-defeat）により、いかなる無矛盾集合にも属し得ない" };
    const S = findAdmissible(new Set([a.id]));
    if (!S) return { rootClaim: a.claim, rootRule: a.ruleId, defensible: false,
      failReason: "すべての攻撃に無矛盾で応答する防御集合（admissible）が存在しない" };
    return { rootClaim: a.claim, rootRule: a.ruleId, defensible: true,
      defenseSet: [...S].map(id => ({ rule: byId[id].ruleId, claim: byId[id].claim })), tree: credTree(a.id, S, []) };
  });
  dual.bands.forEach((b, i) => {
    const g = credulousGames[i];
    b.defensible = g.defensible;
    b.band4 = b.label === "IN" ? "ESTABLISHED" : b.label === "OUT" ? "EXCLUDED" : (g.defensible ? "DEFENSIBLE" : "NOT_DISPROVEN");
  });
  const posIdx = conclArgs.map((a, i) => ({ a, i })).filter(x => T.isPositive(x.a.claim));
  dual.readings.defensible = posIdx.some(x => credulousGames[x.i].defensible) ? POS : NEG;
  if (posIdx.some(x => label[x.a.id] === "IN")) {
    dual.band4Verdict = "ESTABLISHED_" + POS; dual.band4Reason = "肯定結論が L に属する";
  } else if (posIdx.some(x => label[x.a.id] === "UNDEC" && credulousGames[x.i].defensible)) {
    dual.band4Verdict = "DEFENSIBLE_" + POS; dual.band4Reason = "肯定結論は DEF∖L ── 首尾一貫した擁護が存在し責任配分が帰趨を決める";
  } else if (posIdx.some(x => label[x.a.id] === "UNDEC")) {
    dual.band4Verdict = "NOT_DISPROVEN_ONLY"; dual.band4Reason = "肯定結論は U∖DEF ── 確定棄却はできないが無矛盾な擁護も存在しない";
  } else {
    dual.band4Verdict = "ESTABLISHED_" + NEG; dual.band4Reason = "肯定結論は確定棄却（A∖U）または経路なし";
  }

  // ---- β（立証責任方針）の適用：official verdict を選ばれた読みに合わせる ----
  // skeptical(=L基準) は既定で上の verdict のまま。credulous(=U) / defensible(=DEF) は
  // 中間二帯（UNDEC）の肯定結論を採用に倒す（SystemTheory §1・§3、Duality §5）。
  const beta = rb.policy_beta || "skeptical";
  if (beta === "credulous" || beta === "defensible") {
    const posSel = (beta === "credulous")
      ? posArgs.filter(a => label[a.id] !== "OUT")                          // U：反駁不能なら採用
      : posIdx.filter(x => credulousGames[x.i].defensible).map(x => x.a);   // DEF：擁護可能なら採用
    if (posSel.length) {
      verdict = POS;
      verdictReason = `β=${beta}: ` + [...new Set(posSel.map(a => a.ref))].join(", ");
      decisive = posSel;
    } else {
      verdict = NEG;
      verdictReason = `β=${beta}: 採用できる肯定結論なし`;
      decisive = negIn;
    }
    provisional = decisive.some(a => a.conf !== "confirmed");
  }

  // 不変条件 L ⊆ DEF ⊆ U の自己検査（SystemTheory A5）
  const invariantBad = [];
  for (const b of dual.bands) {
    const ok = (b.label !== "IN" || b.defensible) && (!b.defensible || b.label !== "OUT");
    if (!ok) invariantBad.push(`${b.claim}[${b.rule}] label=${b.label} def=${b.defensible}`);
  }

  return {
    verdict, verdictReason, provisional, policy_beta: beta,
    derivedLiterals: Object.keys(derived),
    accepted: decisive.map(a => ({ claim: a.claim, rule: a.ruleId, reference: a.ref, backing: a.backing || [], confidence: a.conf, via: a.via })),
    rejected, openIssues, games, credulousGames, dual,
    invariant_ok: invariantBad.length === 0, invariant_bad: invariantBad,
    debug: { args: args.map(a => ({ id: a.id, ruleId: a.ruleId, claim: a.claim, via: a.via, label: label[a.id] })), defeats }
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { judge, buildArguments, computeDefeats, grounded, factHolds, makeConclTest };
} else if (typeof window !== "undefined") {
  window.DACEngine = { judge, buildArguments, computeDefeats, grounded, factHolds, makeConclTest };
}
