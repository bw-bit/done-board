// ツンデレモードの帯: ノベルゲーム風の会話ウィンドウ（$ を使わない純粋な関数）
// 立ち絵は画像生成した絵を色ごとのパスに自動変換したもの（sprites/rei-*.paths）
import type { Sprite } from './cat-svg'
import { HEIGHT } from './cat-svg'
import { escapeXml } from './svg-text'

export type NovelView = {
  width: number
  portrait: Sprite | null
  name: string
  stageLabel: string
  line: string
  // セリフが出たばかりなら、1 文字ずつ出る演出を付ける（描き直しのたびに繰り返さないように）
  isFresh: boolean
  affection: number
  trust: number
  mood: number
  playing: string | null
  isMuted: boolean
  id: number
}

const PORTRAIT_H = 116
const FONT = 13
const LINE_H = 18
const MAX_LINES = 3
const SIDE_W = 150
// 1 文字を出す速さ（ミリ秒）
const TYPE_MS = 35

const NO_LINE_START = /[、。，．・：；？！ー」』）】〉》…‥ぁぃぅぇぉっゃゅょァィゥェォッャュョ]/

// 全角を 2・半角を 1 として、1 行の幅で折り返す（最大 3 行、あふれたら … で切る）
export function wrapLine(text: string, unitsPerLine: number): string[] {
  const lines: string[] = []
  let cur = ''
  let units = 0
  for (const ch of text) {
    const u = /[\u0000-ÿ]/.test(ch) ? 1 : 2
    // 行頭禁則: 句読点や閉じかっこは行の頭に置かず、前の行にぶら下げる
    if (units + u > unitsPerLine && !NO_LINE_START.test(ch)) {
      lines.push(cur)
      cur = ''
      units = 0
      if (lines.length === MAX_LINES) break
    }
    cur += ch
    units += u
  }
  if (lines.length < MAX_LINES && cur !== '') lines.push(cur)
  if (lines.length === MAX_LINES && [...lines.join('')].length < [...text].length) {
    const last = lines[MAX_LINES - 1]!
    lines[MAX_LINES - 1] = `${[...last].slice(0, -1).join('')}…`
  }
  return lines
}

function gauge(x: number, y: number, w: number, label: string, value: number, color: string): string {
  const ratio = Math.min(1, Math.max(0, value / 100))
  return `<text x="${x}" y="${y}" font-size="11" fill="#e2e8f0">${label}</text>
<text x="${x + w}" y="${y}" text-anchor="end" font-size="11" font-weight="700" fill="${color}">${Math.round(value)}</text>
<rect x="${x}" y="${y + 4}" width="${w}" height="7" rx="3.5" fill="#1e293b"/>
<rect data-gauge="${label}" x="${x}" y="${y + 4}" width="${(w * ratio).toFixed(1)}" height="7" rx="3.5" fill="${color}"/>`
}

function moodFace(mood: number): string {
  if (mood <= -15) return '💢 ご機嫌ななめ'
  if (mood < 5) return '😤 ふつう'
  if (mood < 20) return '😊 ご機嫌'
  return '💗 上機嫌'
}

export function novelSvg(v: NovelView): string {
  const gid = `tn-${v.id}`
  const boxX = PORTRAIT_H + 14
  const boxW = v.width - boxX - SIDE_W - 14
  const unitsPerLine = Math.max(10, Math.floor(boxW / (FONT * 0.54)))
  const lines = wrapLine(v.line, unitsPerLine)
  let delay = 0.15
  const textRows = lines
    .map((row, i) => {
      const y = 52 + i * LINE_H
      const n = [...row].length
      const dur = (n * TYPE_MS) / 1000
      // 1 文字ずつ出す: 行ごとの切り抜きの幅を 0 から伸ばす
      const clip = v.isFresh
        ? `<clipPath id="${gid}-c${i}"><rect x="${boxX + 10}" y="${y - FONT - 2}" width="0" height="${LINE_H + 2}"><animate attributeName="width" from="0" to="${boxW}" dur="${dur.toFixed(2)}s" begin="${delay.toFixed(2)}s" fill="freeze"/></rect></clipPath>`
        : ''
      const row_ = `<text data-line="${i}" x="${boxX + 12}" y="${y}" font-size="${FONT}" fill="#f8fafc"${v.isFresh ? ` clip-path="url(#${gid}-c${i})"` : ''}>${escapeXml(row)}</text>`
      delay += dur
      return clip + row_
    })
    .join('')
  const cursorY = 52 + (lines.length - 1) * LINE_H
  const portrait = v.portrait
    ? `<g data-portrait="1" transform="translate(8,${HEIGHT - PORTRAIT_H - 4}) scale(${(PORTRAIT_H / v.portrait.height).toFixed(4)})" shape-rendering="crispEdges">${v.portrait.paths}<animateTransform attributeName="transform" type="translate" values="0 0;0 -1.2;0 0" dur="3.6s" additive="sum" repeatCount="indefinite"/></g>`
    : ''
  const sx = v.width - SIDE_W
  const music = v.isMuted ? '🔇 消音中' : v.playing ? `♪ ${escapeXml(v.playing)}` : '♪ 停止中'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${v.width}" height="${HEIGHT}" viewBox="0 0 ${v.width} ${HEIGHT}" font-family="-apple-system, 'Hiragino Sans', 'Noto Sans JP', sans-serif">
<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f472b6"/><stop offset="1" stop-color="#818cf8"/></linearGradient>${v.isFresh ? '' : ''}</defs>
<rect x="1" y="1" width="${v.width - 2}" height="${HEIGHT - 2}" rx="14" fill="#140f24" stroke="url(#${gid})" stroke-width="2"/>
<rect x="1" y="1" width="${v.width - 2}" height="${HEIGHT - 2}" rx="14" fill="url(#${gid})" opacity="0.08"/>
${portrait}
<rect x="${boxX}" y="28" width="${boxW}" height="${HEIGHT - 40}" rx="10" fill="#0b1020" opacity="0.85" stroke="#f9a8d4" stroke-opacity="0.45"/>
<g transform="translate(${boxX + 8},12)"><rect width="${Math.max(84, [...v.name].length * 14 + 20)}" height="24" rx="8" fill="#db2777"/><text x="10" y="17" font-size="13" font-weight="800" fill="#fff">${escapeXml(v.name)}</text></g>
<text x="${boxX + Math.max(84, [...v.name].length * 14 + 20) + 16}" y="28" font-size="11" fill="#f9a8d4">${escapeXml(v.stageLabel)}</text>
${textRows}
<text x="${boxX + boxW - 16}" y="${cursorY + 2}" font-size="11" fill="#f9a8d4">▼<animate attributeName="opacity" values="1;0.1;1" dur="1s" repeatCount="indefinite"/></text>
<line x1="${sx - 8}" y1="14" x2="${sx - 8}" y2="${HEIGHT - 14}" stroke="#3b2f5c"/>
${gauge(sx + 4, 24, SIDE_W - 22, '好感度 ♥', v.affection, '#f472b6')}
${gauge(sx + 4, 56, SIDE_W - 22, '信頼', v.trust, '#60a5fa')}
<text x="${sx + 4}" y="92" font-size="11.5" fill="#fbcfe8">${moodFace(v.mood)}</text>
<text x="${sx + 4}" y="111" font-size="11" fill="#c4b5fd">${music}</text>
</svg>`
}
