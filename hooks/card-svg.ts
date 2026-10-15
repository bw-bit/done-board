// デスクトップ用の看板カードを SVG で組み立てる（$ を使わない純粋な関数）
import type { Card, Kind } from '../types'

// 状態ごとのグラデーション（始点・終点）
const GRADIENT: Record<Kind, [string, string]> = {
  done: ['#22c55e', '#14b8a6'],
  progress: ['#f59e0b', '#f97316'],
  blocked: ['#ef4444', '#f43f5e'],
  turn: ['#60a5fa', '#818cf8'],
}

// 項目の状態ごとの点の色
const STEP_COLOR: Record<string, string> = {
  done: '#22c55e',
  running: '#f59e0b',
  blocked: '#ef4444',
  pending: '#475569',
}

const HEIGHT = 88
const RING_R = 24
const MAX_DOTS = 24
const TEMPO_STEPS = 4

export type CardView = {
  card: Card
  icon: string
  playing: string | null
  width: number
  // BGM のテンポ段階（0〜3）。流れていなければ省略
  tierRank?: number
  streak?: number
}

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

// 進捗リング: 前回の割合から今回の割合へ伸びる
function ring(gid: string, ratio: number, fromRatio: number, label: string, isBig: boolean): string {
  const circ = 2 * Math.PI * RING_R
  const to = (circ * (1 - ratio)).toFixed(2)
  const from = (circ * (1 - Math.min(fromRatio, ratio))).toFixed(2)
  const cy = HEIGHT / 2
  return `<circle cx="42" cy="${cy}" r="${RING_R}" fill="none" stroke="#334155" stroke-width="6"/>
<circle cx="42" cy="${cy}" r="${RING_R}" fill="none" stroke="url(#${gid})" stroke-width="6" stroke-linecap="round" transform="rotate(-90 42 ${cy})" stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${to}"><animate attributeName="stroke-dashoffset" from="${from}" to="${to}" dur="0.8s" calcMode="spline" keySplines="0.2 0.8 0.2 1" keyTimes="0;1" fill="freeze"/></circle>
<text x="42" y="${cy + 5}" text-anchor="middle" font-size="${isBig ? 16 : label.length > 3 ? 11.5 : 13}" font-weight="700" fill="#f8fafc">${escapeXml(label)}</text>`
}

// 項目ごとの点。多すぎるときは間隔を詰める
function stepDots(steps: readonly string[], x: number, y: number, maxWidth: number): string {
  const shown = steps.slice(0, MAX_DOTS)
  const gap = Math.min(14, maxWidth / Math.max(shown.length, 1))
  return shown
    .map((st, i) => {
      const cx = (x + i * gap).toFixed(1)
      const fill = STEP_COLOR[st] ?? STEP_COLOR.pending
      const pulse = st === 'running' ? '<animate attributeName="opacity" values="1;0.35;1" dur="1.4s" repeatCount="indefinite"/>' : ''
      return `<circle data-step="${escapeXml(st)}" cx="${cx}" cy="${y}" r="4" fill="${fill}">${pulse}</circle>`
    })
    .join('')
}

// テンポメーター: 4段のバー。今の段まで点灯し、点灯部分は拍に合わせて弾む
function tempoChip(x: number, y: number, label: string, rank: number | undefined): string {
  const bars = Array.from({ length: TEMPO_STEPS }, (_, i) => {
    const isOn = rank !== undefined && i <= rank
    const h = 6 + i * 3
    const bounce = isOn ? `<animate attributeName="opacity" values="1;0.55;1" dur="${(0.6 - (rank ?? 0) * 0.08).toFixed(2)}s" begin="${(i * 0.08).toFixed(2)}s" repeatCount="indefinite"/>` : ''
    return `<rect data-tempo="${isOn ? 'on' : 'off'}" x="${10 + i * 6}" y="${19 - h}" width="4" height="${h}" rx="1" fill="${isOn ? '#c084fc' : '#475569'}">${bounce}</rect>`
  }).join('')
  return `<g transform="translate(${x},${y})"><rect width="164" height="26" rx="13" fill="#a855f7" opacity="0.16"/>${bars}<text x="40" y="17" font-size="12" fill="#e9d5ff">${escapeXml(fitText(label, 18))}</text></g>`
}

function streakBadge(x: number, y: number, streak: number): string {
  return `<g transform="translate(${x},${y})"><rect width="64" height="24" rx="12" fill="#f97316" opacity="0.2"/><text x="32" y="17" text-anchor="middle" font-size="13" font-weight="800" fill="#fdba74">🔥 ${streak}<animate attributeName="font-size" values="13;16;13" dur="0.5s" fill="freeze"/></text></g>`
}

// 完了の瞬間のきらめき（ポップ中だけ）
function sparkles(width: number): string {
  const pts = [[width - 60, 16], [width - 30, 60], [width - 90, 70], [width - 120, 20]]
  return pts
    .map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="0" fill="#fde68a"><animate attributeName="r" values="0;4;0" dur="0.9s" begin="${(i * 0.12).toFixed(2)}s" fill="freeze"/></circle>`)
    .join('')
}

export function cardSvg({ card, icon, playing, width, tierRank, streak = 0 }: CardView): string {
  const [c1, c2] = GRADIENT[card.kind]
  // 同じ画面に複数のカードが並んでも色が混ざらないよう、グラデーションの id をカードごとに分ける
  const gid = `db-${card.kind}-${card.id}`
  const ratio = card.total > 0 ? card.done / card.total : card.kind === 'turn' ? 1 : 0
  const pct = Math.round(ratio * 100)
  const opacity = card.phase === 'fading' ? 0.45 : 1
  const rightWidth = (playing ? 176 : 0) + (streak >= 2 ? 76 : 0)
  const textUnits = Math.floor((width - 96 - rightWidth) / 7.2)
  const steps = card.steps ?? []
  const detail = streak >= 2 ? card.detail.replace(/ ・ 🔥\d+連続/, '') : card.detail
  const right = width - 12
  const chips = [
    playing ? tempoChip(right - 164, 16, playing, tierRank) : '',
    streak >= 2 ? streakBadge(playing ? right - 164 : right - 64, playing ? 50 : 16, streak) : '',
  ].join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}" font-family="-apple-system, 'Hiragino Sans', 'Noto Sans JP', sans-serif" opacity="${opacity}">
<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
<rect x="1" y="1" width="${width - 2}" height="${HEIGHT - 2}" rx="14" fill="#0f172a" stroke="url(#${gid})" stroke-width="2"/>
<rect x="1" y="1" width="${width - 2}" height="${HEIGHT - 2}" rx="14" fill="url(#${gid})" opacity="0.08"/>
${ring(gid, ratio, card.kind === 'turn' ? 1 : card.fromRatio ?? 0, card.total > 0 ? `${pct}%` : icon, card.total === 0)}
<text x="80" y="33" font-size="19" font-weight="800" fill="#f8fafc">${escapeXml(`${card.total > 0 ? `${icon} ` : ''}${card.title}`)}</text>
<text x="80" y="54" font-size="12.5" fill="#cbd5e1">${escapeXml(fitText(detail, textUnits))}</text>
${steps.length > 0 ? stepDots(steps, 84, 72, width - 110 - rightWidth) : ''}
${chips}
${card.phase === 'pop' ? sparkles(width - rightWidth) : ''}
</svg>`
}
