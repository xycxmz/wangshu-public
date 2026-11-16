/* COST 遥测格纯逻辑（无 DOM、无运行时 import，node 断言脚本可直接复用）。
   hub /models 行价字段 price_in/price_out 单位分/百万 token（未定价 0）；
   客户端按 harness 事件回传的累计 tokens 本地估算，文案 ≈ 前缀区分 hub 计费口径。 */

/** 估算成本（分）：tokens × 分/百万 token ÷ 1e6；两价 0 自然得 0。 */
export function estimateCostCents(
  tokensIn: number,
  tokensOut: number,
  priceIn: number,
  priceOut: number,
): number {
  return (tokensIn * priceIn + tokensOut * priceOut) / 1_000_000;
}

/** COST 格文案：未定价（两价皆 ≤0）→ —；否则 ≈¥x.xx（分→元 ÷100，两位舍入）。 */
export function costCellText(
  tokensIn: number,
  tokensOut: number,
  priceIn: number,
  priceOut: number,
): string {
  if (!(priceIn > 0) && !(priceOut > 0)) return "—";
  return `≈¥${(estimateCostCents(tokensIn, tokensOut, priceIn, priceOut) / 100).toFixed(2)}`;
}
