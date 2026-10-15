// 常時表示のニャンコ帯を SVG で組み立てる（$ を使わない純粋な関数）
// 猫の絵は画像生成したコマ絵を、色ごとのパスに自動変換したもの（sprites/*.paths）。
// デスクトップの SVG は埋め込み画像（<image>）を描かないため、図形として埋め込む。動きは SMIL で付ける
import type { Kind } from '../types'
import { escapeXml, fitText } from './svg-text'

export type Pose = 'sleep' | 'walk' | 'run' | 'sprint' | 'wait' | 'joy' | 'attack' | 'hurt'
export type EnemyPose = 'stray1' | 'stray2'

export const HEIGHT = 124
const CAT_H = 56
const RIGHT_W = 196

// 状態ごとの色（帯の枠とトラックの塗り）
const ACCENT: Record<Kind | 'idle' | 'battle', [string, string]> = {
  done: ['#22c55e', '#14b8a6'],
  progress: ['#f59e0b', '#f97316'],
  blocked: ['#ef4444', '#f43f5e'],
  turn: ['#60a5fa', '#818cf8'],
  idle: ['#64748b', '#94a3b8'],
  battle: ['#e11d48', '#a855f7'],
}

// ポーズごとの弾み方（周期・高さ）。速いほど小刻みに弾む
const BOB: Record<Pose, { dur: number; dy: number }> = {
  sleep: { dur: 3.2, dy: 1 },
  wait: { dur: 2.4, dy: 1.5 },
  walk: { dur: 0.7, dy: 2.5 },
  run: { dur: 0.42, dy: 3.5 },
  sprint: { dur: 0.3, dy: 4 },
  joy: { dur: 0.6, dy: 9 },
  attack: { dur: 0.35, dy: 2 },
  hurt: { dur: 0.25, dy: 1.5 },
}

// paths は (0,0)〜(width,height) の座標で描かれた SVG のパス群
export type Sprite = { paths: string; width: number; height: number }

export type StripView = {
  width: number
  accent: Kind | 'idle'
  pose: Pose
  cat: Sprite | null
  title: string
  detail: string
  // トラック上の位置（0〜1）。台帳がなければ null で、猫は左端
  ratio: number | null
  steps: readonly string[]
  level: number
  xpCurrent: number
  xpNeed: number
  playing: string | null
  tierRank?: number
  streak: number
  isMuted: boolean
  id: number
}

export type BattleView = {
  width: number
  cat: Sprite | null
  enemy: Sprite | null
  catPose: Pose
  enemyName: string
  enemyLevel: number
  playerHp: number
  playerMaxHp: number
  enemyHp: number
  enemyMaxHp: number
  text: string
  // 直前に攻撃した側（被弾した側を点滅させる）
  hitBy: 'player' | 'enemy' | null
  result: 'win' | 'lose' | null
  level: number
  xpCurrent: number
  xpNeed: number
  id: number
}

const STEP_COLOR: Record<string, string> = { done: '#22c55e', running: '#f59e0b', blocked: '#ef4444', pending: '#475569' }

function frame(width: number, gid: string, c1: string, c2: string): string {
  return `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
<rect x="1" y="1" width="${width - 2}" height="${HEIGHT - 2}" rx="14" fill="#0f172a" stroke="url(#${gid})" stroke-width="2"/>
<rect x="1" y="1" width="${width - 2}" height="${HEIGHT - 2}" rx="14" fill="url(#${gid})" opacity="0.07"/>`
}

// 猫の画像を足元が ground に来るよう置き、ポーズに合わせて弾ませる
function spriteAt(sprite: Sprite | null, x: number, ground: number, height: number, pose: Pose, isFlipped = false): string {
  if (sprite === null) return ''
  const w = (sprite.width / sprite.height) * height
  const y = ground - height
  const bob = BOB[pose]
  const k = height / sprite.height
  const place = isFlipped
    ? `translate(${(x + w).toFixed(1)},${y.toFixed(1)}) scale(${(-k).toFixed(4)},${k.toFixed(4)})`
    : `translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${k.toFixed(4)})`
  return `<g data-pose="${pose}"><animateTransform attributeName="transform" type="translate" values="0 0;0 ${-bob.dy};0 0" dur="${bob.dur}s" repeatCount="indefinite"/>
<g transform="${place}" shape-rendering="crispEdges">${sprite.paths}</g></g>`
}

// 右側: レベル・経験値ゲージ・BGM・連続・音の状態
function sidePanel(width: number, v: { level: number; xpCurrent: number; xpNeed: number; playing?: string | null; tierRank?: number; streak?: number; isMuted?: boolean }): string {
  const x = width - RIGHT_W
  const ratio = v.xpNeed > 0 ? Math.min(1, v.xpCurrent / v.xpNeed) : 0
  const barW = RIGHT_W - 28
  const bars = Array.from({ length: 5 }, (_, i) => {
    const isOn = v.tierRank !== undefined && i <= v.tierRank
    const h = 5 + i * 2.5
    return `<rect data-tempo="${isOn ? 'on' : 'off'}" x="${x + 14 + i * 5}" y="${112 - h}" width="3.5" height="${h}" rx="1" fill="${isOn ? '#c084fc' : '#475569'}">${isOn ? `<animate attributeName="opacity" values="1;0.5;1" dur="${(0.6 - (v.tierRank ?? 0) * 0.08).toFixed(2)}s" begin="${(i * 0.07).toFixed(2)}s" repeatCount="indefinite"/>` : ''}</rect>`
  }).join('')
  const music = v.isMuted
    ? `<text x="${x + 14}" y="111" font-size="11.5" fill="#94a3b8">🔇 消音中</text>`
    : v.playing
      ? `${bars}<text x="${x + 44}" y="111" font-size="11.5" fill="#e9d5ff">${escapeXml(fitText(v.playing, 22))}</text>`
      : `<text x="${x + 14}" y="111" font-size="11.5" fill="#64748b">♪ 停止中</text>`
  const streakBadge = (v.streak ?? 0) >= 2
    ? `<g transform="translate(${width - 72},14)"><rect width="58" height="22" rx="11" fill="#f97316" opacity="0.2"/><text x="29" y="15.5" text-anchor="middle" font-size="12.5" font-weight="800" fill="#fdba74">🔥 ${v.streak}</text></g>`
    : ''
  return `<line x1="${x - 8}" y1="14" x2="${x - 8}" y2="${HEIGHT - 14}" stroke="#334155" stroke-width="1"/>
<text x="${x + 14}" y="33" font-size="20" font-weight="900" fill="#fde68a">Lv.${v.level}</text>
${streakBadge}
<rect x="${x + 14}" y="44" width="${barW}" height="9" rx="4.5" fill="#1e293b"/>
<rect data-xp="${ratio.toFixed(3)}" x="${x + 14}" y="44" width="${(barW * ratio).toFixed(1)}" height="9" rx="4.5" fill="#facc15"/>
<text x="${x + 14}" y="74" font-size="11" fill="#cbd5e1">EXP ${v.xpCurrent} / ${v.xpNeed}</text>
${music}`
}

export function stripSvg(v: StripView): string {
  const [c1, c2] = ACCENT[v.accent]
  const gid = `nk-${v.accent}-${v.id}`
  const trackX = 16
  const trackW = v.width - RIGHT_W - 40
  const ground = 106
  const cw = v.cat ? (v.cat.width / v.cat.height) * CAT_H : CAT_H
  const ratio = v.ratio ?? 0
  const catX = trackX + ratio * Math.max(0, trackW - cw)
  const textUnits = Math.floor((trackW + 10) / 7)
  const milestones = v.steps.length > 0
    ? v.steps.map((st, i) => {
      const mx = trackX + ((i + 1) / v.steps.length) * trackW
      const fill = STEP_COLOR[st] ?? STEP_COLOR.pending
      const pulse = st === 'running' ? '<animate attributeName="opacity" values="1;0.35;1" dur="1.4s" repeatCount="indefinite"/>' : ''
      return `<circle data-step="${escapeXml(st)}" cx="${mx.toFixed(1)}" cy="${ground + 7}" r="3.5" fill="${fill}">${pulse}</circle>`
    }).join('')
    : ''
  const zz = v.pose === 'sleep'
    ? `<text x="${(catX + cw - 6).toFixed(1)}" y="${ground - CAT_H + 18}" font-size="13" font-weight="800" fill="#93c5fd">z<animate attributeName="opacity" values="0;1;0" dur="2.4s" repeatCount="indefinite"/></text><text x="${(catX + cw + 4).toFixed(1)}" y="${ground - CAT_H + 8}" font-size="16" font-weight="800" fill="#93c5fd">Z<animate attributeName="opacity" values="0;1;0" dur="2.4s" begin="0.8s" repeatCount="indefinite"/></text>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${v.width}" height="${HEIGHT}" viewBox="0 0 ${v.width} ${HEIGHT}" font-family="-apple-system, 'Hiragino Sans', 'Noto Sans JP', sans-serif">
${frame(v.width, gid, c1, c2)}
<text x="${trackX}" y="25" font-size="15" font-weight="800" fill="#f8fafc">${escapeXml(fitText(v.title, Math.floor(textUnits * 0.8)))}</text>
<text x="${trackX}" y="42" font-size="11.5" fill="#cbd5e1">${escapeXml(fitText(v.streak >= 2 ? v.detail.replace(/ ・ 🔥\d+連続/, '') : v.detail, textUnits))}</text>
<rect x="${trackX}" y="${ground}" width="${trackW}" height="3" rx="1.5" fill="#334155"/>
<rect data-progress="${ratio.toFixed(3)}" x="${trackX}" y="${ground}" width="${(trackW * ratio).toFixed(1)}" height="3" rx="1.5" fill="url(#${gid})"/>
${v.ratio !== null ? `<text x="${trackX + trackW - 6}" y="${ground - 4}" font-size="14">🏁</text>` : ''}
${milestones}
${spriteAt(v.cat, catX, ground + 1, CAT_H, v.pose)}
${zz}
${sidePanel(v.width, v)}
</svg>`
}

function hpBar(x: number, y: number, w: number, hp: number, max: number, label: string): string {
  const ratio = max > 0 ? hp / max : 0
  const color = ratio > 0.5 ? '#22c55e' : ratio > 0.2 ? '#f59e0b' : '#ef4444'
  return `<text x="${x}" y="${y - 4}" font-size="11" font-weight="700" fill="#f8fafc">${escapeXml(label)}</text>
<rect x="${x}" y="${y}" width="${w}" height="7" rx="3.5" fill="#1e293b"/>
<rect data-hp="${hp}/${max}" x="${x}" y="${y}" width="${(w * ratio).toFixed(1)}" height="7" rx="3.5" fill="${color}"/>`
}

export function battleSvg(v: BattleView): string {
  const [c1, c2] = ACCENT.battle
  const gid = `nk-battle-${v.id}`
  const arenaW = v.width - RIGHT_W - 24
  const ground = 112
  const flashCat = v.hitBy === 'enemy' ? '<animate attributeName="opacity" values="1;0.2;1;0.2;1" dur="0.5s" fill="freeze"/>' : ''
  const flashEnemy = v.hitBy === 'player' ? '<animate attributeName="opacity" values="1;0.2;1;0.2;1" dur="0.5s" fill="freeze"/>' : ''
  const banner = v.result === 'win'
    ? `<text x="${arenaW / 2}" y="66" text-anchor="middle" font-size="22" font-weight="900" fill="#fde68a">WIN!<animate attributeName="font-size" values="12;26;22" dur="0.5s" fill="freeze"/></text>`
    : v.result === 'lose'
      ? `<text x="${arenaW / 2}" y="66" text-anchor="middle" font-size="18" font-weight="900" fill="#94a3b8">にげた…</text>`
      : `<text x="${arenaW / 2}" y="66" text-anchor="middle" font-size="16" font-weight="900" fill="#f43f5e" opacity="0.8">VS</text>`
  const enemyX = arenaW - 86
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${v.width}" height="${HEIGHT}" viewBox="0 0 ${v.width} ${HEIGHT}" font-family="-apple-system, 'Hiragino Sans', 'Noto Sans JP', sans-serif">
${frame(v.width, gid, c1, c2)}
${hpBar(16, 20, 120, v.playerHp, v.playerMaxHp, `ニャンコ Lv.${v.level}`)}
${hpBar(arenaW - 124, 20, 120, v.enemyHp, v.enemyMaxHp, `${v.enemyName} Lv.${v.enemyLevel}`)}
<text x="${arenaW / 2}" y="44" text-anchor="middle" font-size="11.5" fill="#e2e8f0">${escapeXml(fitText(v.text, Math.floor(arenaW / 7.5)))}</text>
${banner}
<g>${flashCat}${spriteAt(v.cat, 28, ground, 54, v.catPose)}</g>
<g>${flashEnemy}${spriteAt(v.enemy, enemyX, ground, 58, 'wait')}</g>
${sidePanel(v.width, { level: v.level, xpCurrent: v.xpCurrent, xpNeed: v.xpNeed })}
</svg>`
}
