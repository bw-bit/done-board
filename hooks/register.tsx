import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Card, Kind } from '../types'
import type { Tier } from './music'
import { TIERS, comboAsset, isFaster, streakLabel, tierFor } from './music'
import { cardSvg } from './card-svg'

const card = atom({ plugin: 'done-board', key: 'card' } as const, null)
const lastSig = atom({ plugin: 'done-board', key: 'lastSig' } as const, null)
const isMusicOn = atom({ plugin: 'done-board', key: 'isMusicOn' } as const, true)
const nowPlaying = atom({ plugin: 'done-board', key: 'nowPlaying' } as const, null)
const streak = atom({ plugin: 'done-board', key: 'streak' } as const, 0)

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
type Config = { ledgerDir: string; music: boolean; musicVolume: number; effects: boolean; debugLog: boolean; promptHint: boolean }
let config: Config = { ledgerDir: 'work/autonomy', music: true, musicVolume: 0.35, effects: true, debugLog: false, promptHint: true }

function readConfig(options: Readonly<Record<string, unknown>>): Config {
  const volume = Number(options.musicVolume)
  return {
    ledgerDir: typeof options.ledgerDir === 'string' && options.ledgerDir.trim() !== '' ? options.ledgerDir.trim().replace(/\/+$/, '') : config.ledgerDir,
    music: options.music !== false,
    musicVolume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : config.musicVolume,
    effects: options.effects !== false,
    debugLog: options.debugLog === true,
    promptHint: options.promptHint !== false,
  }
}

// 効果音（BGM 以外）。設定で切ってあれば鳴らさない
async function playEffect($: any, asset: string): Promise<void> {
  if (!config.effects) return
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

// このセッションの台帳を書く場所（Claude に伝える絶対パス）
async function ledgerPathFor($: any): Promise<string> {
  const id = await $.session.id()
  const dir = config.ledgerDir.startsWith('/') ? config.ledgerDir : `${await $.session.cwd()}/${config.ledgerDir}`
  return `${dir}/completion-${id}.json`
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

// 完了台帳は work/autonomy/completion-<session_id>.json。置き場の違いに備えて複数候補を探す
async function readLedger($: any): Promise<LedgerRead> {
  const id = await $.session.id()
  const cwd = await $.session.cwd()
  const root = await $.session.root().catch(() => cwd)
  // 絶対パスならそのまま、相対パスなら作業フォルダとリポジトリのルートから探す
  const bases = config.ledgerDir.startsWith('/') ? [''] : [`${cwd}/`, `${root}/`]
  for (const base of bases) {
    const path = `${base}${config.ledgerDir}/completion-${id}.json`
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

// 診断用の記録（設定 debugLog がオンのときだけ）。作業フォルダの .claude/done-board-debug.log に直近 40 行を残す
async function beat($: any, event: string, extra: Record<string, unknown> = {}): Promise<void> {
  if (!config.debugLog) return
  const path = `${await $.session.cwd()}/.claude/done-board-debug.log`
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
  if (!config.music || !(await read($, isMusicOn))) {
    stopBgm()
    await update($, nowPlaying, () => null)
    return
  }
  const tier = tierFor(done, total)
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
  stopBgm()
  await update($, nowPlaying, () => null)
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
    const { ledger } = await readLedger($)
    const items = ledger?.items ?? []
    seenDone = countDone(items)
    isBaselined = true
    isCelebrated = false
    // 終わった依頼の台帳しかなければ、新しい作業としてゆったり始める
    const isFinished = items.length > 0 && seenDone === items.length
    await syncMusic($, isFinished ? 0 : seenDone, isFinished ? 0 : items.length)
    poll = $.clock.every(POLL_MS, () => void pollLedger($).catch(() => undefined))
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    cancelTimers()
    await update($, card, () => null)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    poll?.cancel()
    poll = undefined
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
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const cur = await read($, card)
    if (cur !== null) await beat($, 'ui.render', { surface: e.surface, kind: cur.kind, phase: cur.phase })
    if (e.props.hasSurvey || cur === null) return next(e)

    const playing = await read($, nowPlaying)
    const isFading = cur.phase === 'fading'
    const icon = cur.phase === 'pop' ? POP_FRAMES[cur.frame] ?? ICON[cur.kind] : ICON[cur.kind]
    const close = () => update($, card, () => null)

    if (e.surface === 'desktop') {
      const t = $.ui.resolve(e)
      const width = Math.max(360, Math.min(720, e.props.bodyColumns * 8))
      const alt = `${cur.title} ${cur.detail}${playing !== null ? ` ・ ♪ ${playing}` : ''}`
      return (
        <t.Box flexDirection="row" alignItems="center" gap={1}>
          <t.Svg
            source={cardSvg({ card: cur, icon, playing, width, tierRank: bgm ? TIERS[bgm.tier].rank : undefined, streak: await read($, streak) })}
            alt={alt}
            width={width}
            height={88}
            isInteractive
          />
          <t.Button key="close" label="✕" onPress={close} />
        </t.Box>
      )
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    // 消える直前は色を落として薄く見せる
    const accent = isFading ? { dimColor: true } : { color: COLOR[cur.kind], bold: true }
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={isFading ? 'inactive' : COLOR[cur.kind]} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row">
            <Text {...accent}>{icon} {cur.title}</Text>
            {cur.total > 0 ? <Text {...accent} bold={false}> {progressBar(cur.done, cur.total)}</Text> : null}
          </Box>
          <Box flexDirection="row">
            {playing !== null ? <Text color="claude">♪ {playing}  </Text> : null}
            <Button key="close" label="✕" onPress={close} />
          </Box>
        </Box>
        <Text dimColor wrap="truncate-end">{cur.detail}</Text>
      </Box>
    )
  })
}
