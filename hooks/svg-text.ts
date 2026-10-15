// SVG に文字を入れるときの共通処理（$ を使わない純粋な関数）

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// 幅に収まるよう、全角を2・半角を1として切る
export function fitText(text: string, maxUnits: number): string {
  let units = 0
  let out = ''
  for (const ch of text) {
    units += /[\u0000-ÿ]/.test(ch) ? 1 : 2
    if (units > maxUnits) return `${out}…`
    out += ch
  }
  return out
}
