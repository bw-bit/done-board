// 経験値・レベル・野良猫バトルの決め方（$ を使わない純粋な関数だけ）

export type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

// 消費トークン 500 ごとに 1 XP。キャッシュから読んだ分は数えない
export const TOKENS_PER_XP = 500

export function xpFromUsage(usage: Usage | undefined): number {
  if (usage === undefined) return 0
  const tokens = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  return Math.floor(tokens / TOKENS_PER_XP)
}

// レベル L に届くまでの累計 XP: 25 × L × (L - 1)。Lv2 は 50、Lv5 は 500、Lv10 は 2250
export function xpToReach(level: number): number {
  return 25 * level * (level - 1)
}

export type LevelInfo = { level: number; current: number; need: number; ratio: number }

export function levelOf(xp: number): LevelInfo {
  let level = 1
  while (xpToReach(level + 1) <= xp) level += 1
  const base = xpToReach(level)
  const need = xpToReach(level + 1) - base
  const current = xp - base
  return { level, current, need, ratio: need > 0 ? current / need : 0 }
}

// 決まった種から同じ乱数列を出す（テストで結果を固定できるように）
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 遭遇: 前回から 3 ターン以上あいていれば、15% の確率で野良猫が出る
export const ENCOUNTER_CHANCE = 0.15
export const ENCOUNTER_GAP = 3

export function shouldEncounter(roll: number, turnsSinceLast: number): boolean {
  return turnsSinceLast >= ENCOUNTER_GAP && roll < ENCOUNTER_CHANCE
}

export type Enemy = { id: 'stray1' | 'stray2'; name: string; level: number; hp: number; isBoss: boolean }

// Lv3 からは 4 回に 1 回ボスのクロが出る
export function pickEnemy(roll: number, level: number): Enemy {
  if (level >= 3 && roll < 0.25) {
    const lv = level + 2
    return { id: 'stray2', name: 'ボス猫クロ', level: lv, hp: 28 + lv * 6, isBoss: true }
  }
  const lv = Math.max(1, level - 1 + Math.floor(roll * 3))
  return { id: 'stray1', name: '野良猫グレ', level: lv, hp: 18 + lv * 6, isBoss: false }
}

export type BattleStep = {
  actor: 'player' | 'enemy'
  damage: number
  isCritical: boolean
  playerHp: number
  enemyHp: number
  text: string
}

export type Battle = {
  enemy: Enemy
  playerMaxHp: number
  steps: BattleStep[]
  result: 'win' | 'lose'
  xp: number
}

const MAX_ROUNDS = 8

// 自動で戦う。こちらが先手で、交互に攻撃する。会心は 15% で 2 倍
export function simulateBattle(seed: number, level: number, enemy: Enemy): Battle {
  const r = rng(seed)
  const playerMaxHp = 20 + level * 5
  let playerHp = playerMaxHp
  let enemyHp = enemy.hp
  const steps: BattleStep[] = []
  for (let round = 0; round < MAX_ROUNDS && playerHp > 0 && enemyHp > 0; round++) {
    const isCritical = r() < 0.15
    const hit = (4 + level * 2 + Math.floor(r() * 4)) * (isCritical ? 2 : 1)
    enemyHp = Math.max(0, enemyHp - hit)
    steps.push({ actor: 'player', damage: hit, isCritical, playerHp, enemyHp, text: isCritical ? `会心の猫パンチ！ ${hit} のダメージ` : `猫パンチ！ ${hit} のダメージ` })
    if (enemyHp === 0) break
    const back = 3 + enemy.level * 2 + Math.floor(r() * 4)
    playerHp = Math.max(0, playerHp - back)
    steps.push({ actor: 'enemy', damage: back, isCritical: false, playerHp, enemyHp, text: `${enemy.name}のひっかき！ ${back} のダメージ` })
  }
  // 決着がつかなければ、残りの体力の割合が多い方の勝ち
  const isWin = enemyHp === 0 || (playerHp > 0 && playerHp / playerMaxHp >= enemyHp / enemy.hp)
  const xp = isWin ? enemy.level * (enemy.isBoss ? 40 : 20) : enemy.level * 5
  return { enemy, playerMaxHp, steps, result: isWin ? 'win' : 'lose', xp }
}
