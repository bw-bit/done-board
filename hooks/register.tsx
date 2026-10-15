import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { BattleState, Card, Kind } from '../types'
import type { Tier } from './music'
import { TIERS, comboAsset, isFaster, streakLabel, tierFor } from './music'
import type { Pose, Sprite } from './cat-svg'
import { HEIGHT, battleSvg, stripSvg } from './cat-svg'
import { levelOf, pickEnemy, shouldEncounter, simulateBattle, xpFromUsage } from './game'

const card = atom({ plugin: 'done-board', key: 'card' } as const, null)
const lastSig = atom({ plugin: 'done-board', key: 'lastSig' } as const, null)
const isMusicOn = atom({ plugin: 'done-board', key: 'isMusicOn' } as const, true)
const nowPlaying = atom({ plugin: 'done-board', key: 'nowPlaying' } as const, null)
const streak = atom({ plugin: 'done-board', key: 'streak' } as const, 0)
const ledgerPath = atom({ plugin: 'done-board', key: 'ledgerPath' } as const, null)
const logPath = atom({ plugin: 'done-board', key: 'logPath' } as const, null)
const xpAtom = atom({ plugin: 'done-board', key: 'xp' } as const, 0)
const isMuted = atom({ plugin: 'done-board', key: 'isMuted' } as const, false)
const battle = atom({ plugin: 'done-board', key: 'battle' } as const, null)
const agentsRunning = atom({ plugin: 'done-board', key: 'agentsRunning' } as const, 0)
const wins = atom({ plugin: 'done-board', key: 'wins' } as const, 0)

type Item = { id: string; status: string; note?: string }
type Ledger = { status?: string; request_summary?: string; items?: Item[] }
type LedgerRead = { ledger: Ledger | null; error?: string }

// 看板が消えるまでの時間（ミリ秒）。完了は長め、ターン完了は短め
const LIFETIME: Record<Kind, number> = { done: 14000, progress: 20000, blocked: 30000, turn: 6000 }
// テーマの色名を使い、ライト・ダークどちらのテーマでも馴染ませる
const COLOR: Record<Kind, string> = { done: 'success', progress: 'warning', blocked: 'error', turn: 'suggestion' }
const ICON: Record<Kind, string> = { done: '✔', progress: '◐', blocked: '⚠', turn: '●' }
const SOUND: Record<Kind, string> = {
  done: 'sounds/fanfare.wav',
  progress: 'sounds/progress.wav',
  blocked: 'sounds/progress.wav',
  turn: 'sounds/turn.wav',
}

const BAR_CELLS = 10
// 完了のポップ: ✧ → ✦ → ✔ と 400ms ごとに変わる
const POP_FRAMES = ['✧', '✦']
const POP_STEP_MS = 400
// 消える前に薄くなっている時間
const FADE_MS = 3000
// 台帳のないターンは、この秒数以上かかったときだけ音で知らせる
const LOUD_TURN_SECONDS = 30

type Decision = { card: Card; isAudible: boolean }

// BGM は控えめ、ご褒美の音ははっきり
// 作業中に台帳を見に行く間隔
const POLL_MS = 4000

// userConfig の値（register で受け取る）。既定値は plugin.json と同じ
type Config = { ledgerDir: string; music: boolean; musicVolume: number; effects: boolean; debugLog: boolean; promptHint: boolean; battles: boolean }
let config: Config = { ledgerDir: 'work/autonomy', music: true, musicVolume: 0.35, effects: true, debugLog: false, promptHint: true, battles: true }

function readConfig(options: Readonly<Record<string, unknown>>): Config {
  const volume = Number(options.musicVolume)
  return {
    ledgerDir: typeof options.ledgerDir === 'string' && options.ledgerDir.trim() !== '' ? options.ledgerDir.trim().replace(/\/+$/, '') : config.ledgerDir,
    music: options.music !== false,
    musicVolume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : config.musicVolume,
    effects: options.effects !== false,
    debugLog: options.debugLog === true,
    promptHint: options.promptHint !== false,
    battles: options.battles !== false,
  }
}

// 効果音（BGM 以外）。設定で切ってあれば鳴らさない
async function playEffect($: any, asset: string): Promise<void> {
  if (!config.effects || (await read($, isMuted))) return
  await $.audio.play({ asset }).catch(() => undefined)
}

let timers: { cancel: () => void }[] = []
let seq = 0
let bgm: { tier: Tier; ctl: AbortController } | undefined
let poll: { cancel: () => void } | undefined
// このターンで最後に見た完了数と、ターン中にもう祝ったか
let seenDone = 0
// turn.start で台帳の完了数を数え終えたか（数える前の完了は連続に入れない）
let isBaselined = false
let isCelebrated = false
// メインのターンが動いているか・最後に見た進み具合（BGM を戻すときに使う）
let isTurnActive = false
let lastDone = 0
let lastTotal = 0
// 動いているサブエージェントの数と、メインのターンが終わった後もそれを見張るタイマー
let runningAgents = 0
let agentPoll: { cancel: () => void } | undefined
// 前回のバトルから何ターンたったか・バトルの場面を進めるタイマー
let turnsSinceBattle = 0
let battleTimers: { cancel: () => void }[] = []
// 読み込んだコマ絵（sprites/*.png）
const spriteCache = new Map<string, Sprite | null>()

// 134 → 「2分14秒」、3700 → 「1時間1分」
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
  return `${Math.floor(seconds / 3600)}時間${Math.floor((seconds % 3600) / 60)}分`
}

// 長い文を帯に収まる長さで切る
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// 項目数によらず固定幅の比率バー
function progressBar(done: number, total: number): string {
  const filled = Math.round((done / total) * BAR_CELLS)
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_CELLS - filled)} ${Math.round((done / total) * 100)}%`
}

// このセッションの台帳を書く場所（Claude に伝える絶対パス）。一度伝えたら $.state に残し、
// 作業フォルダが途中で移っても同じパスを伝え続ける
async function ledgerPathFor($: any): Promise<string> {
  const told = await read($, ledgerPath)
  if (told !== null) return told
  const id = await $.session.id()
  const dir = config.ledgerDir.startsWith('/') ? config.ledgerDir : `${await $.session.cwd()}/${config.ledgerDir}`
  const path = `${dir}/completion-${id}.json`
  await update($, ledgerPath, () => path)
  return path
}

// Claude は自分のセッション ID を知らないので、台帳の場所と書き方をシステムプロンプトで伝える
function ledgerHint(path: string): string {
  return [
    'done-board プラグイン: 手順が2つ以上ある作業では、進み具合をこのファイルに JSON で書いてください。',
    `台帳: ${path}`,
    '形式: {"status":"running","request_summary":"依頼の要約","items":[{"id":"短い英数字","status":"pending|running|done|blocked","note":"何をするか"}]}',
    '作業を始める前に項目を並べて作り、各項目を始めたら running、終えたらすぐ done に書き換えてください。全部終えたら status を done にします。',
    '人の操作を待つ項目は blocked にして note に理由を書きます。看板・作業BGM・効果音がこの台帳を読んで動きます。',
    '1回で答えられる質問や1か所だけの小さな修正では書かなくてかまいません。',
  ].join('\n')
}

// 完了台帳は work/autonomy/completion-<session_id>.json。Claude に伝えたパスを最初に見て、
// なければ（伝える前・伝えなかった場合）作業フォルダとリポジトリのルートから探す
async function ledgerCandidates($: any): Promise<string[]> {
  const told = await read($, ledgerPath)
  const id = await $.session.id()
  const cwd = await $.session.cwd()
  const root = await $.session.root().catch(() => cwd)
  // 絶対パスならそのまま、相対パスなら作業フォルダとリポジトリのルートから探す
  const bases = config.ledgerDir.startsWith('/') ? [''] : [`${cwd}/`, `${root}/`]
  const found = bases.map(base => `${base}${config.ledgerDir}/completion-${id}.json`)
  return [...new Set(told !== null ? [told, ...found] : found)]
}

async function readLedger($: any): Promise<LedgerRead> {
  for (const path of await ledgerCandidates($)) {
    if (!(await $.fs.exists(path))) continue
    try {
      return { ledger: JSON.parse(await $.fs.read(path)) as Ledger }
    } catch (err) {
      // 生のエラーは出さず、何が起きたかだけ伝える。詳細はステータス行へ
      $.ui.status(`done-board: ${path}: ${String(err).slice(0, 80)}`)
      return { ledger: null, error: '台帳の JSON が壊れています' }
    }
  }
  return { ledger: null }
}

// 診断用の記録（設定 debugLog がオンのときだけ）。作業フォルダの .claude/done-board-debug.log に直近 40 行を残す。
// 場所は最初に書いたときに決め、作業フォルダが移っても同じファイルに書き続ける
async function beat($: any, event: string, extra: Record<string, unknown> = {}): Promise<void> {
  if (!config.debugLog) return
  let path = await read($, logPath)
  if (path === null) {
    const first = `${await $.session.cwd()}/.claude/done-board-debug.log`
    await update($, logPath, () => first)
    path = first
  }
  const surface = await $.session.surface().catch(() => null)
  const line = JSON.stringify({ event, surface, at: new Date(await $.clock.now()).toISOString(), ...extra })
  const prev = await $.fs.read(path).catch(() => '')
  const lines = String(prev).split('\n').filter(Boolean).slice(-39)
  await $.fs.write(path, [...lines, line].join('\n') + '\n').catch(() => undefined)
}

function cancelTimers(): void {
  for (const t of timers) t.cancel()
  timers = []
}

// 表示中の看板が同じものなら、段階だけ進める（別の看板に替わっていたら何もしない）
async function patchCard($: any, id: number, patch: Partial<Card> | null): Promise<void> {
  await update($, card, (cur: Card | null) => {
    if (cur === null || cur.id !== id) return cur
    return patch === null ? null : { ...cur, ...patch }
  })
}

async function show($: any, next: Card, isAudible: boolean): Promise<void> {
  cancelTimers()
  await update($, card, () => next)
  if (isAudible) await playEffect($, SOUND[next.kind])

  if (next.phase === 'pop') {
    for (let i = 1; i < POP_FRAMES.length; i++) {
      timers.push($.clock.after(i * POP_STEP_MS, () => void patchCard($, next.id, { frame: i })))
    }
    timers.push($.clock.after(POP_FRAMES.length * POP_STEP_MS, () => void patchCard($, next.id, { phase: 'shown' })))
  }
  // スッキリ消える: 薄くなってから消える。新しい看板が出たら前のタイマーは捨てる
  const life = LIFETIME[next.kind]
  timers.push($.clock.after(life - FADE_MS, () => void patchCard($, next.id, { phase: 'fading' })))
  timers.push($.clock.after(life, () => void patchCard($, next.id, null)))
}

// 台帳とターンの所要時間から、出す看板を1枚決める
async function decide($: any, seconds: number): Promise<Decision> {
  seq += 1
  const { ledger, error } = await readLedger($)
  const items = ledger?.items ?? []
  const base = { done: 0, total: 0, id: seq, phase: 'shown' as const, frame: 0 }
  const quietTurn = (detail: string): Decision => ({
    card: { ...base, kind: 'turn', title: 'ターン完了', detail },
    isAudible: seconds >= LOUD_TURN_SECONDS,
  })
  const took = `所要 ${formatDuration(seconds)}`

  if (error !== undefined) {
    return quietTurn(`${took} ・ ${error}`)
  }
  if (items.length === 0 || ledger?.status === 'stopped') return quietTurn(took)

  // 台帳が前回から変わっていなければ、古い依頼の結果を繰り返さない
  const sig = items.map(i => `${i.id}:${i.status}`).join('|')
  const prevSig = await read($, lastSig)
  const isChanged = sig !== prevSig
  const prevDone = (prevSig ?? '').split('|').filter(x => x.endsWith(':done')).length
  await update($, lastSig, () => sig)

  const done = items.filter(i => i.status === 'done').length
  const blocked = items.filter(i => i.status === 'blocked')
  const open = items.filter(i => i.status === 'pending' || i.status === 'running')
  const counts = { ...base, done, total: items.length, steps: items.map(i => i.status), fromRatio: items.length > 0 ? prevDone / items.length : 0 }
  const summary = ledger?.request_summary ? `${clip(ledger.request_summary, 30)} ・ ` : ''

  if (!isChanged) return quietTurn(took)
  if (open.length === 0 && blocked.length === 0) {
    const doneCard: Card = { ...counts, kind: 'done', title: '依頼 完了', detail: `${summary}${done}/${items.length} 項目すべて完了 ・ ${took}`, phase: 'pop' }
    return { card: doneCard, isAudible: true }
  }
  if (open.length === 0) {
    const names = blocked.map(i => (i.note ? `${i.id}: ${clip(i.note, 20)}` : i.id)).join(', ')
    const blockedCard: Card = { ...counts, kind: 'blocked', title: '要対応', detail: `完了 ${done}/${items.length} ・ 待ち ${blocked.length} 件（${names}）` }
    return { card: blockedCard, isAudible: true }
  }
  const nextItem = open.find(i => i.status === 'running') ?? open[0]!
  const nextLabel = nextItem.note ? `${nextItem.id} — ${clip(nextItem.note, 28)}` : nextItem.id
  const wait = blocked.length > 0 ? ` ・ 要対応 ${blocked.length}` : ''
  const progressCard: Card = { ...counts, kind: 'progress', title: 'まだ途中です', detail: `完了 ${done}/${items.length} ・ 残り ${open.length} 件（次: ${nextLabel}）${wait}` }
  // 途中経過の音は、完了数が増えたときだけ（作業中にコンボで祝った分は鳴らさない）
  return { card: progressCard, isAudible: done > prevDone && !isCelebrated }
}

function stopBgm(): void {
  bgm?.ctl.abort()
  bgm = undefined
}

// 進み具合に合ったテンポのBGMへ切り替える。速くなるときはレベルアップ音を鳴らす
async function syncMusic($: any, done: number, total: number): Promise<void> {
  lastDone = done
  lastTotal = total
  if (!config.music || !(await read($, isMusicOn)) || (await read($, isMuted))) {
    stopBgm()
    await update($, nowPlaying, () => null)
    return
  }
  // サブエージェントが動いている間は早送りの曲
  const tier: Tier = runningAgents > 0 ? 'turbo' : tierFor(done, total)
  if (bgm?.tier === tier) return
  if (isFaster(tier, bgm?.tier)) await playEffect($, 'sounds/levelup.wav')
  stopBgm()
  const ctl = new AbortController()
  bgm = { tier, ctl }
  // ループ再生は止めるまで終わらないので待たない
  void $.audio.play({ asset: TIERS[tier].asset }, { shouldLoop: true, gain: config.musicVolume, signal: ctl.signal }).catch(() => undefined)
  await update($, nowPlaying, () => TIERS[tier].label)
}

async function hasOpenItems($: any): Promise<boolean> {
  const { ledger } = await readLedger($)
  return (ledger?.items ?? []).some(i => i.status === 'pending' || i.status === 'running')
}

async function silence($: any): Promise<void> {
  // サブエージェントがまだ動いていれば、早送りの曲は止めない
  if (runningAgents > 0) {
    await syncMusic($, lastDone, lastTotal)
    return
  }
  stopBgm()
  await update($, nowPlaying, () => null)
}

// サブエージェントの数を数え直し、増減したら曲を切り替える
async function refreshAgents($: any): Promise<void> {
  const list = (await $.agent.list().catch(() => [])) as { status: string }[]
  const n = list.filter(a => a.status === 'running' || a.status === 'pending').length
  if (n === runningAgents) return
  runningAgents = n
  await update($, agentsRunning, () => n)
  if (n > 0 || isTurnActive) {
    await syncMusic($, lastDone, lastTotal)
  } else {
    agentPoll?.cancel()
    agentPoll = undefined
    if (!(await hasOpenItems($))) await silence($)
    else await syncMusic($, lastDone, lastTotal)
  }
}

// コマ絵を読み込む。1 行目が「幅 高さ」、2 行目以降が SVG のパス
async function spriteOf($: any, name: string): Promise<Sprite | null> {
  if (spriteCache.has(name)) return spriteCache.get(name) ?? null
  let sprite: Sprite | null = null
  try {
    const text = String(await $.fs.read(`${$.plugin.root}/sprites/${name}.paths`))
    const nl = text.indexOf('\n')
    const [w, h] = text.slice(0, nl).split(' ').map(Number)
    if (nl > 0 && Number.isFinite(w) && Number.isFinite(h) && (w ?? 0) > 0 && (h ?? 0) > 0) {
      sprite = { paths: text.slice(nl + 1), width: w as number, height: h as number }
    }
  } catch (err) {
    await beat($, 'sprite.error', { name, error: String(err).slice(0, 200) })
  }
  spriteCache.set(name, sprite)
  return sprite
}

// 経験値を足し、レベルが上がったら知らせる
async function addXp($: any, gained: number): Promise<void> {
  if (gained <= 0) return
  const before = levelOf(await read($, xpAtom)).level
  const xp = (await update($, xpAtom, (n: number) => n + gained)) as number
  await $.store.set('xp', xp).catch(() => undefined)
  const after = levelOf(xp).level
  if (after > before) {
    await playEffect($, 'sounds/lvup.wav')
    $.ui.toast(`🎉 ニャンコが Lv.${after} にレベルアップ！`)
  }
}

function cancelBattle(): void {
  for (const t of battleTimers) t.cancel()
  battleTimers = []
}

async function patchBattle($: any, id: number, patch: Partial<BattleState> | null): Promise<void> {
  await update($, battle, (cur: BattleState | null) => {
    if (cur === null || cur.id !== id) return cur
    return patch === null ? null : { ...cur, ...patch }
  })
}

// 野良猫バトル: 遭遇 → 交互に攻撃 → 勝ち負け → 経験値。1手ずつ 1.1 秒で進める
const BATTLE_INTRO_MS = 1400
const BATTLE_STEP_MS = 1100
const BATTLE_OUTRO_MS = 3500

async function startBattle($: any): Promise<void> {
  if ((await read($, battle)) !== null) return
  cancelBattle()
  const level = levelOf(await read($, xpAtom)).level
  const enemy = pickEnemy(Math.random(), level)
  const fight = simulateBattle(Math.floor(Math.random() * 2 ** 31), level, enemy)
  seq += 1
  const id = seq
  await update($, battle, () => ({
    enemyId: enemy.id,
    enemyName: enemy.name,
    enemyLevel: enemy.level,
    enemyHp: enemy.hp,
    enemyMaxHp: enemy.hp,
    playerHp: fight.playerMaxHp,
    playerMaxHp: fight.playerMaxHp,
    text: `${enemy.name}（Lv.${enemy.level}）があらわれた！`,
    hitBy: null,
    result: null,
    catPose: 'wait' as const,
    id,
  }))
  await playEffect($, 'sounds/encounter.wav')
  fight.steps.forEach((step, i) => {
    battleTimers.push($.clock.after(BATTLE_INTRO_MS + i * BATTLE_STEP_MS, () => {
      void patchBattle($, id, {
        playerHp: step.playerHp,
        enemyHp: step.enemyHp,
        text: step.text,
        hitBy: step.actor,
        catPose: step.actor === 'player' ? 'attack' : 'hurt',
      }).then(() => playEffect($, 'sounds/hit.wav'))
    }))
  })
  const endAt = BATTLE_INTRO_MS + fight.steps.length * BATTLE_STEP_MS
  battleTimers.push($.clock.after(endAt, () => {
    const isWin = fight.result === 'win'
    void patchBattle($, id, {
      result: fight.result,
      hitBy: null,
      catPose: isWin ? 'joy' : 'hurt',
      text: isWin ? `${enemy.name}をやっつけた！ +${fight.xp} EXP` : `ニャンコはにげだした… +${fight.xp} EXP`,
    })
      .then(() => playEffect($, isWin ? 'sounds/win.wav' : 'sounds/lose.wav'))
      .then(() => addXp($, fight.xp))
      .then(async () => {
        if (!isWin) return
        const w = (await update($, wins, (n: number) => n + 1)) as number
        await $.store.set('wins', w).catch(() => undefined)
      })
  }))
  battleTimers.push($.clock.after(endAt + BATTLE_OUTRO_MS, () => void patchBattle($, id, null)))
}

async function toggleMute($: any): Promise<void> {
  const muted = (await update($, isMuted, (m: boolean) => !m)) as boolean
  await $.store.set('muted', muted).catch(() => undefined)
  if (muted) {
    stopBgm()
    await update($, nowPlaying, () => null)
  } else if (isTurnActive || runningAgents > 0) {
    await syncMusic($, lastDone, lastTotal)
  }
}

// 帯の猫のポーズ: 完了で跳ね、要対応で待ち、BGM の速さで歩く・走る、何もなければ眠る
function poseFor(cur: Card | null, isWorking: boolean): Pose {
  if (cur?.kind === 'done' && cur.phase !== 'fading') return 'joy'
  if (cur?.kind === 'blocked') return 'wait'
  const tier = bgm?.tier
  if (tier === 'turbo' || tier === 'sprint') return 'sprint'
  if (tier === 'drive') return 'run'
  if (tier !== undefined || isWorking || runningAgents > 0) return 'walk'
  return 'sleep'
}

function countDone(items: Item[]): number {
  return items.filter(i => i.status === 'done').length
}

// 作業中に台帳を見て、項目が終わった瞬間にコンボ音と看板で祝う
async function pollLedger($: any): Promise<void> {
  const { ledger } = await readLedger($)
  const items = ledger?.items ?? []
  const done = countDone(items)
  if (!isBaselined) {
    seenDone = done
    isBaselined = true
    return
  }
  if (done <= seenDone) return
  const gained = done - seenDone
  seenDone = done
  isCelebrated = true
  const now = (await update($, streak, (n: number) => n + gained)) as number
  await playEffect($, comboAsset(now))
  const finished = items.filter(i => i.status === 'done').slice(-gained).map(i => i.id).join(', ')
  seq += 1
  await show($, {
    kind: 'progress',
    title: `+${gained} 完了`,
    detail: `${finished} ・ ${done}/${items.length}${streakLabel(now)}`,
    done,
    total: items.length,
    id: seq,
    phase: 'pop',
    frame: 0,
    steps: items.map(i => i.status),
    fromRatio: (done - gained) / items.length,
  }, false)
  await syncMusic($, done, items.length)
}

export const register: Register = (on, options) => {
  config = readConfig(options ?? {})
  on('session.start', async ($, e, next) => {
    await beat($, 'session.start')
    await $.command.register({ name: 'bgm', description: '作業BGMを切り替える（/bgm on・/bgm off・/bgm で状態）' })
    await $.command.register({ name: 'nyanko', description: 'ニャンコの状態を見る（/nyanko battle で野良猫と戦う、/nyanko mute で消音を切り替え）' })
    // セッションをまたいで残す値を読み戻す
    const savedXp = Number(await $.store.get('xp').catch(() => 0)) || 0
    const savedWins = Number(await $.store.get('wins').catch(() => 0)) || 0
    const savedMuted = (await $.store.get('muted').catch(() => false)) === true
    await update($, xpAtom, () => savedXp)
    await update($, wins, () => savedWins)
    await update($, isMuted, () => savedMuted)
    return next(e)
  })

  on('command.run', { command: 'bgm' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'off') {
      await update($, isMusicOn, () => false)
      await silence($)
      return { text: '作業BGMを止めました。/bgm on で再開します。' }
    }
    if (arg === 'on') {
      await update($, isMusicOn, () => true)
      return { text: '作業BGMをオンにしました。次の作業から流れます。' }
    }
    const playing = await read($, nowPlaying)
    return { text: `作業BGM: ${(await read($, isMusicOn)) ? 'オン' : 'オフ'} ・ ${playing ?? '停止中'} ・ 連続 ${await read($, streak)}` }
  })

  on('command.run', { command: 'nyanko' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'battle') {
      await startBattle($)
      return { text: '野良猫があらわれた！ 入力欄の上の帯を見てください。' }
    }
    if (arg === 'mute') {
      await toggleMute($)
      return { text: (await read($, isMuted)) ? '音を消しました。' : '音を戻しました。' }
    }
    const info = levelOf(await read($, xpAtom))
    return { text: `ニャンコ Lv.${info.level} ・ EXP ${info.current}/${info.need} ・ 勝利 ${await read($, wins)} ・ 音 ${(await read($, isMuted)) ? 'オフ' : 'オン'}` }
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!config.promptHint) return result
    try {
      const text = ledgerHint(await ledgerPathFor($))
      return { sections: [...result.sections, { id: 'done-board:ledger', text, scope: 'session' as const }] }
    } catch {
      return result
    }
  })

  on('turn.start', async ($, e, next) => {
    poll?.cancel()
    isTurnActive = true
    const { ledger } = await readLedger($)
    const items = ledger?.items ?? []
    seenDone = countDone(items)
    isBaselined = true
    isCelebrated = false
    // 終わった依頼の台帳しかなければ、新しい作業としてゆったり始める
    const isFinished = items.length > 0 && seenDone === items.length
    await syncMusic($, isFinished ? 0 : seenDone, isFinished ? 0 : items.length)
    poll = $.clock.every(POLL_MS, () => {
      void pollLedger($).catch(() => undefined)
      void refreshAgents($).catch(() => undefined)
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    cancelTimers()
    await update($, card, () => null)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // 消費したトークンは、サブエージェントの分も経験値にする
    await addXp($, xpFromUsage(e.usage as any)).catch(() => undefined)
    if (e.agentId !== undefined) {
      // サブエージェントのターンの終わり: 看板は出さず、早送りを続けるかだけ見直す
      await refreshAgents($).catch(() => undefined)
      return result
    }
    poll?.cancel()
    poll = undefined
    isTurnActive = false
    // バックグラウンドのサブエージェントが残っていれば、終わるまで見張る
    await refreshAgents($).catch(() => undefined)
    if (runningAgents > 0 && agentPoll === undefined) {
      agentPoll = $.clock.every(POLL_MS, () => void refreshAgents($).catch(() => undefined))
    }
    if (e.reason !== 'answer') {
      await silence($)
      return result
    }
    // ターン中に見逃した完了も祝う
    await pollLedger($).catch(() => undefined)

    const decision = await decide($, Math.round(e.durationMs / 1000))
    const kind = decision.card.kind
    if (kind === 'done') {
      // 依頼完了: BGMを止めてファンファーレ、連続はリセット
      await silence($)
      await update($, streak, () => 0)
    } else if (kind === 'blocked' || (kind === 'turn' && !(await hasOpenItems($)))) {
      // 人の操作待ちや作業のない間は静かにする
      await silence($)
    }
    const s = await read($, streak)
    const withStreak = kind === 'progress' ? { ...decision.card, detail: decision.card.detail + streakLabel(s) } : decision.card
    await show($, withStreak, decision.isAudible)
    await beat($, 'turn.complete', { kind: decision.card.kind, title: decision.card.title, detail: decision.card.detail })
    if (decision.card.kind === 'done') $.ui.toast(`🎉 ${decision.card.title}: ${decision.card.detail}`)
    // たまに近所の野良猫が出てくる
    turnsSinceBattle += 1
    if (config.battles && shouldEncounter(Math.random(), turnsSinceBattle)) {
      turnsSinceBattle = 0
      timers.push($.clock.after(2500, () => void startBattle($).catch(() => undefined)))
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const cur = await read($, card)
    const fight = await read($, battle)
    if (cur !== null) await beat($, 'ui.render', { surface: e.surface, kind: cur.kind, phase: cur.phase })

    const playing = await read($, nowPlaying)
    const muted = await read($, isMuted)
    const info = levelOf(await read($, xpAtom))
    const isFading = cur?.phase === 'fading'
    const icon = cur === null ? '' : cur.phase === 'pop' ? POP_FRAMES[cur.frame] ?? ICON[cur.kind] : ICON[cur.kind]
    const close = () => update($, card, () => null)
    const isWorking = e.props.isWorking === true
    const ratio = cur !== null && cur.total > 0 ? cur.done / cur.total : lastTotal > 0 ? lastDone / lastTotal : null
    const idleTitle = runningAgents > 0 ? `サブエージェント ${runningAgents} 体が作業中` : isWorking ? '作業中…' : 'ひと休み中'
    const idleDetail = `次のレベルまで ${info.need - info.current} EXP ・ 勝利 ${await read($, wins)}`
    const title = cur !== null ? `${icon} ${cur.title}${ratio !== null ? `  ${Math.round(ratio * 100)}%` : ''}` : idleTitle
    const detail = cur !== null ? cur.detail : idleDetail

    if (e.surface === 'desktop') {
      const t = $.ui.resolve(e)
      const width = Math.max(420, Math.min(760, e.props.bodyColumns * 8))
      const pose = poseFor(cur, isWorking)
      const source = fight !== null
        ? battleSvg({
            width,
            cat: await spriteOf($, fight.catPose),
            enemy: await spriteOf($, fight.enemyId),
            catPose: fight.catPose,
            enemyName: fight.enemyName,
            enemyLevel: fight.enemyLevel,
            playerHp: fight.playerHp,
            playerMaxHp: fight.playerMaxHp,
            enemyHp: fight.enemyHp,
            enemyMaxHp: fight.enemyMaxHp,
            text: fight.text,
            hitBy: fight.hitBy,
            result: fight.result,
            level: info.level,
            xpCurrent: info.current,
            xpNeed: info.need,
            id: fight.id,
          })
        : stripSvg({
            width,
            accent: cur?.kind ?? 'idle',
            pose,
            cat: await spriteOf($, pose),
            title,
            detail,
            ratio,
            steps: cur?.steps ?? [],
            level: info.level,
            xpCurrent: info.current,
            xpNeed: info.need,
            playing,
            tierRank: bgm ? TIERS[bgm.tier].rank : undefined,
            streak: await read($, streak),
            isMuted: muted,
            id: cur?.id ?? 0,
          })
      const alt = fight !== null ? `${fight.text} ・ ニャンコ Lv.${info.level}` : `${title} ${detail} ・ ニャンコ Lv.${info.level}${playing !== null ? ` ・ ♪ ${playing}` : ''}`
      return (
        <t.Box flexDirection="row" alignItems="center" gap={1}>
          <t.Svg source={source} alt={alt} width={width} height={HEIGHT} isInteractive />
          <t.Box flexDirection="column" gap={1}>
            <t.Button key="mute" label={muted ? '🔇' : '🔊'} onPress={() => toggleMute($)} />
            {cur !== null ? <t.Button key="close" label="✕" onPress={close} /> : null}
          </t.Box>
        </t.Box>
      )
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const gauge = `${'▰'.repeat(Math.round(info.ratio * 8))}${'▱'.repeat(8 - Math.round(info.ratio * 8))}`
    const status = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text>{fight !== null ? `🐈 vs 🐈‍⬛ ${fight.text}` : `🐈 ${cur === null ? idleTitle : ''}`}</Text>
        <Box flexDirection="row">
          <Text color="warning">Lv.{info.level} {gauge} </Text>
          {playing !== null && !muted ? <Text color="claude">♪ {playing}  </Text> : null}
          <Button key="mute" label={muted ? '🔇' : '🔊'} onPress={() => toggleMute($)} />
        </Box>
      </Box>
    )
    if (cur === null) return status
    // 消える直前は色を落として薄く見せる
    const accent = isFading ? { dimColor: true } : { color: COLOR[cur.kind], bold: true }
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={isFading ? 'inactive' : COLOR[cur.kind]} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">
            <Text {...accent}>{icon} {cur.title}</Text>
            {cur.total > 0 ? <Text {...accent} bold={false}> {progressBar(cur.done, cur.total)}</Text> : null}
          </Box>
          <Button key="close" label="✕" onPress={close} />
        </Box>
        <Text dimColor wrap="truncate-end">{cur.detail}</Text>
        {status}
      </Box>
    )
  })
}
