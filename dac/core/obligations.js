/* ============================================================
   obligations.js ── 義務の確定（「該当する場合に何をしないといけないか」）
   judge() の裁定（verdict・受理された結論・暫定性）と rulepack.obligations から、
   適用される義務・条件付きで生じる義務を計算する。

   トリガー:
     - trigger_claim: <結論リテラル>  … その結論が IN（受理）のとき適用
                                          （例: CRA のティア別適合性評価ルート）
     - trigger: "positive" / 省略       … verdict が positive（該当）のとき適用
                                          （例: 全 in-scope 製品の基礎義務）
   役割:
     役割リテラル role_provider / role_deployer 等で限定できる（任意）。role 省略時は
     該当すれば常に適用。役割未指定かつ default_role:true の義務は「提供者と仮定」して
     提示し、その仮定を flag で明示する（SystemTheory A7: 人間管轄の申告）。
   ============================================================ */
"use strict";
const { factHolds } = require("./engine.js");

function obligations(facts, rb, judgement) {
  const vm = rb.verdict_map || {};
  const labels = vm.labels || {};
  const POS = labels.positive || "POSITIVE";
  const obls = rb.obligations || [];

  const acceptedClaims = new Set((judgement.dual && judgement.dual.bands || [])
    .filter(b => b.label === "IN").map(b => b.claim));

  const isProvider = factHolds(facts, "role_provider");
  const isDeployer = factHolds(facts, "role_deployer");
  const roleKnown = isProvider || isDeployer;

  const triggered = judgement.verdict === POS;   // 規制への該当（positive verdict）

  const applicable = [];
  const conditional = [];

  if (!triggered) {
    return {
      triggered: false, verdict: judgement.verdict,
      summary: `分類が ${judgement.verdict} のため、本規制上の義務は発生しない。`,
      role: roleKnown ? roleString(isProvider, isDeployer) : "unspecified",
      roleAssumed: false, provisional: false, applicable, conditional
    };
  }

  const triggerMet = o => {
    if (o.trigger_claim) return acceptedClaims.has(o.trigger_claim);
    if (!o.trigger || o.trigger === "positive") return true;  // triggered は上で確定済み
    return false;
  };

  for (const o of obls) {
    if (!triggerMet(o)) continue;
    const roleHolds = o.role ? factHolds(facts, o.role) : true;
    const entry = { id: o.id, label: o.label, text: o.text, ref: o.ref, backing: o.backing || [], role: o.role || null };
    if (roleHolds) {
      applicable.push({ ...entry, assumed: false });
    } else if (!roleKnown && o.default_role) {
      applicable.push({ ...entry, assumed: true });   // 役割未指定 → 既定役割と仮定して適用
    } else {
      conditional.push({ ...entry, appliesIf: o.role });
    }
  }

  const roleAssumed = !roleKnown && applicable.some(a => a.assumed);

  return {
    triggered: true, verdict: judgement.verdict,
    role: roleKnown ? roleString(isProvider, isDeployer) : "unspecified",
    roleAssumed, provisional: !!judgement.provisional,
    summary: buildSummary(judgement, roleAssumed, applicable.length),
    applicable, conditional
  };
}

function roleString(p, d) {
  if (p && d) return "provider+deployer";
  if (p) return "provider";
  if (d) return "deployer";
  return "unspecified";
}

function buildSummary(j, roleAssumed, n) {
  let s = `該当（${j.verdict}） ── ${n} 件の義務が適用される。`;
  if (roleAssumed) s += " 役割が未指定のため既定役割（提供者）を仮定して提示している（role_* を与えると確定する）。";
  if (j.provisional) s += " ただし該当認定自体が推定前提に依存する（暫定）ため、前提が崩れると義務全体が外れうる。";
  return s;
}

module.exports = { obligations };
