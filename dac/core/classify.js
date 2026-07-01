/* ============================================================
   classify.js ── 規制論証システムの統合ドライバ
   構造化テキスト1（ルールパック）＋構造化テキスト2（事実）＋論証ロジックから、
   (1) 判定（該当するか）、(2) 該当する場合の義務、(3) 不足条件のシミュレーション
   を一括で生成する（instructions.md の3要請に対応）。
   ============================================================ */
"use strict";
const { judge } = require("./engine.js");
const { obligations } = require("./obligations.js");
const { simulate } = require("./simulate.js");

function classify(facts, pack, opts = {}) {
  const judgement = judge(facts, pack.rulepack);
  const obls = obligations(facts, pack.rulepack, judgement);
  const result = { judgement, obligations: obls };
  if (opts.simulate !== false) {
    result.simulation = simulate(facts, pack.rulepack, pack.literals, opts);
  }
  return result;
}

module.exports = { classify };
