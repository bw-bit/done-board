import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { levelOf, pickEnemy, simulateBattle, xpFromUsage, xpToReach } from './game'
import { rainGlyphs, stripSvg } from './cat-svg'
import { parseCwd, parseListen, shortPath } from './localhost'
import { catBackgroundHint, catQuestions, spinnerWord, toolFace, turnLine } from './theme'
import { INITIAL, apply, readPrompt, stageOf, taskLine, toolLine } from './tsundere'
import { wrapLine } from './novel-svg'

// 依頼台帳を差し替えて、ターン終了時に看板がどう描かれるかを確かめる
type Item = { id: string; status: string; note?: string }
type Ledger = { status: string; request_summary?: string; items: Item[] } | null

let agents: { status: string }[] = []
let toasts: string[] = []
let ran: string[] = []
const LSOF = `COMMAND     PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
rapportd    692    R   11u  IPv4 0x1      0t0  TCP *:65101 (LISTEN)
node       3669    R   20u  IPv4 0x2      0t0  TCP 127.0.0.1:4327 (LISTEN)
ControlCe   879    R    9u  IPv4 0x3      0t0  TCP *:7000 (LISTEN)
Python     1134    R    5u  IPv4 0x4      0t0  TCP 127.0.0.1:8791 (LISTEN)
Python     1134    R    6u  IPv6 0x5      0t0  TCP [::1]:8791 (LISTEN)`

function stub(on: On, ledgerOf: Ledger | (() => Ledger | string), sounds: string[] = [], ledgerPath = '/w/work/autonomy/completion-sid.json', asked: string[] = [], store: Record<string, unknown> = {}) {
  agents = []
  toasts = []
  ran = []
  const get = () => (typeof ledgerOf === 'function' ? ledgerOf() : ledgerOf)
  on('session.id', () => ({ value: 'sid' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.root', () => ({ value: '/w' }))
  on('fs.exists', ($, e) => {
    asked.push(e.path)
    return { value: get() !== null && e.path === ledgerPath }
  })
  on('fs.read', ($, e: any) => {
    if (String(e.path).endsWith('.paths')) return { value: '10 10\n<path fill="#f5a623" d="M0 0h10v10h-10z"/>' }
    const l = get()
    return { value: typeof l === 'string' ? l : JSON.stringify(l) }
  })
  on('audio.play', ($, e) => {
    sounds.push((e.clip.asset ?? '?') + (e.shouldLoop ? ' (loop)' : ''))
    return { value: undefined }
  })
  on('ui.toast', ($, e: any) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('agent.list', () => ({ value: agents }) as any)
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('process.run', ($, e: any) => {
    const argv = e.argv as string[]
    ran.push(argv.join(' '))
    if (argv[0] === '/usr/sbin/lsof' && argv.includes('-iTCP')) return { value: { exitCode: 0, stdout: LSOF, stderr: '' } }
    if (argv[0] === '/usr/sbin/lsof') return { value: { exitCode: 0, stdout: 'p3669\nn/Users/me/claudecode/apps/shop\n', stderr: '' } }
    if (argv[0] === '/usr/bin/printenv') return { value: { exitCode: 0, stdout: '/Users/me\n', stderr: '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('store.get', ($, e: any) => ({ value: store[e.key] }))
  on('store.set', ($, e: any) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('command.register', () => ({ value: undefined }) as any)
  on('prompt.submit', ($, e) => ({ text: e.text }) as any)
  // 看板が何も出さないときにエンジンが描くもの（空の帯）
  on('ui.render', ($, e: any) => {
    const { Box, Text } = $.ui.resolve(e) as any
    if (e.component === 'AbovePrompt' || e.component === 'Pane') return <Box />
    // ほかの場所は、エンジンが受け取った中身を文字にして返す（書き換えを確かめるため）
    return <Text>{`ENGINE:${JSON.stringify(e.props)}`}</Text>
  })
}

// 描画ツリーを1行テキストにして、看板の見え方をログに残す
function flatten(el: any): string {
  if (el === null || el === undefined || typeof el === 'boolean') return ''
  if (typeof el === 'string' || typeof el === 'number') return String(el)
  if (Array.isArray(el)) return el.map(flatten).join('')
  const p = el.props ?? {}
  if (el.type === 'Button') return `[${p.label}]`
  if (el.type === 'Svg') return `<svg: ${p.alt}>`
  if (el.type === 'Markdown') return String(p.text ?? '')
  return flatten(el.children ?? p.children)
}

async function turn($: any, durationMs = 1000) {
  await $.prompt.submit({ text: 'go' }).catch(() => undefined)
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs, isAborted: false, turnId: 't1' })
}

async function band($: any, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ plugin: 'done-board', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } })
  const drawn = await ui.drawn()
  const text = flatten(drawn)
  return { ui, text }
}

const ALL_DONE: Ledger = { status: 'done', items: [{ id: 'a', status: 'done' }, { id: 'b', status: 'done' }, { id: 'c', status: 'done' }] }
const HALF: Ledger = { status: 'running', items: [{ id: 'a', status: 'done' }, { id: 'b', status: 'running', note: 'build the band' }, { id: 'c', status: 'pending' }] }

test('done: 全項目完了で完了看板と完了音、時間が経つと消える', async ($, on) => {
  const clock = mock.clock(on)
  const sounds: string[] = []
  stub(on, ALL_DONE, sounds)
  await turn($)
  const { text } = await band($)
  console.log(`RENDER done     | ${text}`)
  expect(text).toMatch(/完了/)
  expect(sounds).toContain('sounds/fanfare.wav')
  await clock.advance(60000)
  const after = await band($)
  console.log(`RENDER done+60s | ${after.text}`)
  expect(after.text).not.toMatch(/依頼 完了/)
  expect(after.text).toMatch(/ひと休み中/)
})

test('progress: 残りがあれば件数と次の1手', async ($, on) => {
  mock.clock(on)
  stub(on, HALF)
  await turn($)
  const { text } = await band($)
  console.log(`RENDER progress | ${text}`)
  expect(text).toMatch(/1\/3|残り/)
  expect(text).toMatch(/b/)
})

test('turn: 台帳がなければターン完了', async ($, on) => {
  mock.clock(on)
  stub(on, null)
  await turn($)
  const { text } = await band($)
  console.log(`RENDER turn     | ${text}`)
  expect(text).toMatch(/ターン完了/)
})

test('閉じるボタンで消える', async ($, on) => {
  mock.clock(on)
  stub(on, ALL_DONE)
  await turn($)
  const { ui } = await band($)
  const btn = await ui.find({ type: 'Button' })
  expect(btn).toBeDefined()
  await ui.press({ key: btn!.key! })
  const after = await band($)
  expect(after.text).not.toMatch(/依頼 完了/)
  expect(after.text).toMatch(/ひと休み中/)
})

// ---- ループ1回目で追加: 正確さ ----
test('r1: 所要時間はエンジンの durationMs を使う', async ($, on) => {
  mock.clock(on)
  stub(on, null)
  await turn($, 134000)
  const { text } = await band($)
  expect(text).toMatch(/2分14秒|134秒/)
})

test('r1: 同じ完了台帳のままなら2回目は祝わない（古い台帳で毎回鳴らない）', async ($, on) => {
  mock.clock(on)
  const sounds: string[] = []
  stub(on, ALL_DONE, sounds)
  await turn($)
  await turn($)
  const { text } = await band($)
  console.log(`RENDER stale    | ${text}`)
  expect(text).not.toMatch(/依頼 完了/)
  expect(sounds.filter(x => x === 'sounds/fanfare.wav').length).toBe(1)
})

test('r1: blocked は「途中」ではなく要対応として出す', async ($, on) => {
  mock.clock(on)
  stub(on, { status: 'running', items: [{ id: 'a', status: 'done' }, { id: 'login', status: 'blocked', note: '2FA待ち' }] })
  await turn($)
  const { text } = await band($)
  console.log(`RENDER blocked  | ${text}`)
  expect(text).toMatch(/要対応|blocked|待ち/)
  expect(text).toMatch(/login/)
})

test('r1: 壊れた台帳でも看板は出る（ターン完了＋警告）', async ($, on) => {
  mock.clock(on)
  stub(on, () => '{ broken')
  await turn($)
  const { text } = await band($)
  console.log(`RENDER broken   | ${text}`)
  expect(text).toMatch(/ターン完了/)
  expect(text).toMatch(/台帳/)
})

// ---- ループ2回目で追加: 情報量・見やすさ ----
test('r2: 所要時間は「2分14秒」のように読める形', async ($, on) => {
  mock.clock(on)
  stub(on, null)
  await turn($, 134000)
  const { text } = await band($)
  expect(text).toMatch(/2分14秒/)
})

test('r2: 次の1手は id だけでなく note も出す', async ($, on) => {
  mock.clock(on)
  stub(on, HALF)
  await turn($)
  const { text } = await band($)
  expect(text).toMatch(/build the band/)
})

test('r2: バーは項目数によらず固定幅（20項目でも崩れない）', async ($, on) => {
  mock.clock(on)
  const items = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, status: i < 5 ? 'done' : 'pending' }))
  stub(on, { status: 'running', items })
  await turn($)
  const { text } = await band($)
  console.log(`RENDER 20items  | ${text}`)
  const cells = (text.match(/[█░]/g) ?? []).length
  expect(cells).toBe(10)
  expect(text).toMatch(/25%|5\/20/)
})

test('r2: 完了看板に何の依頼かを出す', async ($, on) => {
  mock.clock(on)
  stub(on, { ...ALL_DONE!, request_summary: 'done-board を3回改善' })
  await turn($)
  const { text } = await band($)
  console.log(`RENDER summary  | ${text}`)
  expect(text).toMatch(/done-board を3回改善/)
})

test('r2: 壊れた台帳の警告は生のエラーを出さない', async ($, on) => {
  mock.clock(on)
  stub(on, () => '{ broken')
  await turn($)
  const { text } = await band($)
  expect(text).toMatch(/JSON/)
  expect(text).not.toMatch(/SyntaxError/)
})

test('r2: デスクトップでも同じ看板が描ける', async ($, on) => {
  mock.clock(on)
  stub(on, HALF)
  await turn($)
  const { text } = await band($, 'desktop')
  console.log(`RENDER desktop  | ${text}`)
  expect(text).toMatch(/まだ途中/)
})

// ---- ループ3回目で追加: 演出・音 ----
test('r3: 完了時は ✧→✦→✔ とポップして決まる', async ($, on) => {
  const clock = mock.clock(on)
  stub(on, ALL_DONE)
  await turn($)
  const first = await band($)
  console.log(`RENDER pop t=0  | ${first.text}`)
  expect(first.text).not.toMatch(/✔/)
  await clock.advance(1200)
  const settled = await band($)
  console.log(`RENDER pop t=1s | ${settled.text}`)
  expect(settled.text).toMatch(/✔ 依頼 完了/)
})

test('r3: 消える直前は薄くなってから消える', async ($, on) => {
  const clock = mock.clock(on)
  stub(on, ALL_DONE)
  await turn($)
  await clock.advance(12500)
  const fading = await band($)
  const title = await fading.ui.find({ type: 'Text', text: /依頼 完了/ })
  console.log(`RENDER fade     | ${fading.text}  (title dimColor=${(title as any)?.props?.dimColor})`)
  expect((title as any)?.props?.dimColor).toBe(true)
  await clock.advance(3000)
  expect((await band($)).text).not.toMatch(/依頼 完了/)
})

test('r3: 短いやり取りでは音を鳴らさず、長いターンだけ鳴らす', async ($, on) => {
  mock.clock(on)
  const sounds: string[] = []
  stub(on, null, sounds)
  await turn($, 3000)
  expect(sounds).toEqual([])
  await turn($, 45000)
  expect(sounds).toEqual(['sounds/turn.wav'])
})

test('r3: 途中経過の音は完了数が増えたときだけ', async ($, on) => {
  mock.clock(on)
  const sounds: string[] = []
  let ledger: Ledger = HALF
  stub(on, () => ledger, sounds)
  await turn($)
  // 完了数は同じまま、作業中の項目だけ変わる
  ledger = { status: 'running', items: [{ id: 'a', status: 'done' }, { id: 'b', status: 'pending' }, { id: 'c', status: 'running' }] }
  await turn($)
  expect(sounds.filter(x => x === 'sounds/progress.wav' || x.startsWith('sounds/combo')).length).toBe(1)
})

test('r3: 要対応カードに待ちの理由を出す', async ($, on) => {
  mock.clock(on)
  stub(on, { status: 'running', items: [{ id: 'a', status: 'done' }, { id: 'login', status: 'blocked', note: '2FA待ち' }] })
  await turn($)
  const { text } = await band($)
  expect(text).toMatch(/2FA待ち/)
})

// ---- 作業BGM・テンポ・コンボ ----
async function startTurn($: any, id: string) {
  await $.turn.start({ text: 'work', turnId: id })
}

test('bgm: 作業が始まると進み具合に合ったテンポでBGMが流れる', async ($, on) => {
  mock.clock(on)
  const sounds: string[] = []
  stub(on, { status: 'running', items: [{ id: 'a', status: 'done' }, { id: 'b', status: 'pending' }, { id: 'c', status: 'pending' }] }, sounds)
  await startTurn($, 't1')
  console.log(`SOUND start     | ${sounds.join(' → ')}`)
  expect(sounds).toEqual(['sounds/bgm-groove.m4a (loop)'])
})

test('bgm: 項目が終わるたびにコンボ音、テンポが上がるとレベルアップ音で曲が速くなる', async ($, on) => {
  const clock = mock.clock(on)
  const sounds: string[] = []
  const st = (n: number) => Array.from({ length: 4 }, (_, i) => ({ id: `s${i + 1}`, status: i < n ? 'done' : 'pending' }))
  let ledger: Ledger = { status: 'running', items: st(0) }
  stub(on, () => ledger, sounds)
  await startTurn($, 't1')
  ledger = { status: 'running', items: st(1) }
  await clock.advance(4000)
  ledger = { status: 'running', items: st(2) }
  await clock.advance(4000)
  ledger = { status: 'running', items: st(3) }
  await clock.advance(4000)
  const { text } = await band($)
  console.log(`SOUND combo     | ${sounds.join(' → ')}`)
  console.log(`RENDER combo    | ${text}`)
  expect(sounds).toEqual([
    // 4項目: 1/4 はまだウォームアップ、2/4 でグルーヴ、残り1件でラストスパート
    'sounds/bgm-calm.m4a (loop)',
    'sounds/combo1.wav',
    'sounds/combo2.wav', 'sounds/levelup.wav', 'sounds/bgm-groove.m4a (loop)',
    'sounds/combo3.wav', 'sounds/levelup.wav', 'sounds/bgm-sprint.m4a (loop)',
  ])
  expect(text).toMatch(/🔥3連続/)
  expect(text).toMatch(/ラストスパート/)
})

test('bgm: 依頼が全部終わるとBGMを止めてファンファーレ', async ($, on) => {
  const clock = mock.clock(on)
  const sounds: string[] = []
  let ledger: Ledger = HALF
  stub(on, () => ledger, sounds)
  await startTurn($, 't1')
  ledger = ALL_DONE
  await turn($)
  await clock.advance(1200)
  const { text } = await band($)
  console.log(`SOUND finish    | ${sounds.join(' → ')}`)
  console.log(`RENDER finish   | ${text}`)
  expect(sounds[sounds.length - 1]).toBe('sounds/fanfare.wav')
  expect(text).not.toMatch(/♪/)
})

test('bgm: /bgm off で流さない', async ($, on) => {
  mock.clock(on)
  const sounds: string[] = []
  stub(on, HALF, sounds)
  const r = await $.command.run({ command: 'bgm', args: 'off', origin: 'user' } as any)
  expect(r.text).toMatch(/止め/)
  await startTurn($, 't1')
  expect(sounds.filter(x => x.includes('bgm-'))).toEqual([])
})

// ---- UIループ1回目: 見た目の土台 ----
async function svgOf($: any, label: string) {
  const ui = await $.ui.mount({ plugin: 'done-board', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } })
  const svg = await ui.find({ type: 'Svg' })
  const source = String((svg as any)?.props?.source ?? '')
  // 画像化して目で確かめるため、SVG をログに残す
  if (source) console.log(`SVG ${label} ${btoa(unescape(encodeURIComponent(source)))}`)
  return { ui, svg: svg as any, source }
}

test('u1: デスクトップでは進捗リング付きのカード（Svg）で描く', async ($, on) => {
  mock.clock(on)
  stub(on, HALF)
  await turn($)
  const { svg, source } = await svgOf($, 'progress')
  expect(svg).toBeDefined()
  expect(source).toMatch(/まだ途中です/)
  expect(source).toMatch(/33%/)
  expect(String(svg.props.alt)).toMatch(/まだ途中です/)
})

test('u1: ターミナルは枠付き2段（タイトル行と詳細行）', async ($, on) => {
  mock.clock(on)
  stub(on, HALF)
  await turn($)
  const ui = await $.ui.mount({ plugin: 'done-board', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } })
  const root = (await ui.drawn()) as any
  expect(root.props.borderStyle).toBe('round')
  expect(root.props.flexDirection).toBe('column')
})

test('u1: 要対応（人の操作待ち）の間はBGMを止める', async ($, on) => {
  mock.clock(on)
  const sounds: string[] = []
  let ledger: Ledger = HALF
  stub(on, () => ledger, sounds)
  await $.turn.start({ text: 'work', turnId: 't1' })
  ledger = { status: 'running', items: [{ id: 'a', status: 'done' }, { id: 'login', status: 'blocked', note: '2FA待ち' }] }
  await turn($)
  const { text } = await band($)
  expect(text).not.toMatch(/♪/)
})

test('u1: 前から終わっていた項目は連続に数えない', async ($, on) => {
  mock.clock(on)
  const items = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, status: i < 5 ? 'done' : 'pending' }))
  stub(on, { status: 'running', items })
  await turn($)
  const { text } = await band($)
  expect(text).not.toMatch(/連続/)
})

test('u1: 帯ごとにグラデーションの id が違う（並べても色が混ざらない）', () => {
  const a = VIEW({ accent: 'done', id: 1 }).match(/linearGradient id="([^"]+)"/)![1]
  const b = VIEW({ accent: 'blocked', id: 2 }).match(/linearGradient id="([^"]+)"/)![1]
  expect(a).not.toBe(b)
})

// ---- UIループ2回目の要素（いまはニャンコ帯の中） ----
const VIEW = (over: any = {}) => stripSvg({
  width: 640, accent: 'progress', pose: 'run', cat: null, title: '✧ +1 完了  50%', detail: 'build', ratio: 0.5,
  steps: ['done', 'done', 'running', 'pending'], level: 2, xpCurrent: 10, xpNeed: 100, playing: 'ドライブ ×1.1', tierRank: 2, streak: 3, isMuted: false, id: 1, ...over,
})

test('u2: 項目ごとの状態を点で並べる', () => {
  const s = VIEW()
  expect((s.match(/data-step="/g) ?? []).length).toBe(4)
  expect(s).toMatch(/data-step="running"/)
})

test('u2: テンポメーターは5段（早送りを含む）で、今の段まで点灯する', () => {
  const s = VIEW()
  expect((s.match(/data-tempo="on"/g) ?? []).length).toBe(3)
  expect((s.match(/data-tempo="off"/g) ?? []).length).toBe(2)
})

test('u2: 2連続以上は🔥バッジで目立たせる', () => {
  expect(VIEW()).toMatch(/🔥\s*3/)
  expect(VIEW({ streak: 1 })).not.toMatch(/🔥/)
})

test('u2: デスクトップの Svg は動きを出すため interactive', async ($, on) => {
  mock.clock(on)
  stub(on, HALF)
  await turn($)
  const { svg } = await svgOf($, 'progress-u2')
  expect(svg.props.isInteractive).toBe(true)
})

test('u2: 🔥バッジがあるときは詳細文に連続を重ねて書かない', () => {
  const s = VIEW({ detail: 'build ・ 2/4 ・ 🔥3連続' })
  expect((s.match(/🔥/g) ?? []).length).toBe(1)
})

// ---- 配布用の設定（userConfig） ----
test('config: music を切ると作業BGMは流れず、効果音は鳴る', { options: { music: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const sounds: string[] = []
  let ledger: Ledger = HALF
  stub(on, () => ledger, sounds)
  await $.turn.start({ text: 'work', turnId: 't1' })
  ledger = { status: 'running', items: [{ id: 'a', status: 'done' }, { id: 'b', status: 'done' }, { id: 'c', status: 'pending' }] }
  await clock.advance(4000)
  expect(sounds.filter(x => x.includes('bgm-'))).toEqual([])
  expect(sounds).toContain('sounds/combo1.wav')
})

test('config: effects を切ると効果音は鳴らない', { options: { effects: false } }, async ($, on) => {
  mock.clock(on)
  const sounds: string[] = []
  stub(on, ALL_DONE, sounds)
  await turn($)
  expect(sounds.filter(x => !x.includes('bgm-'))).toEqual([])
})

test('config: 台帳フォルダを変えられる', { options: { ledgerDir: '.progress' } }, async ($, on) => {
  mock.clock(on)
  const asked: string[] = []
  stub(on, ALL_DONE, [], '/w/.progress/completion-sid.json', asked)
  await turn($)
  expect(asked[0]).toBe('/w/.progress/completion-sid.json')
  expect((await band($)).text).toMatch(/依頼 完了/)
})

// ---- 台帳の場所を Claude に伝える ----
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] }

test('hint: システムプロンプトにこのセッションの台帳の場所と形式を加える', async ($, on) => {
  mock.clock(on)
  stub(on, null)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'x', scope: 'shared' }] }))
  const r = await $.prompt.compose(COMPOSE as any)
  const ours = r.sections.find((s: any) => s.id === 'done-board:ledger')
  expect(ours?.text).toMatch(/\/w\/work\/autonomy\/completion-sid\.json/)
  expect(ours?.text).toMatch(/"status":"pending\|running\|done\|blocked"/)
  expect(ours?.scope).toBe('session')
  expect(r.sections[0].id).toBe('intro')
})

test('hint: promptHint を切ると加えない', { options: { promptHint: false } }, async ($, on) => {
  mock.clock(on)
  stub(on, null)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'x', scope: 'shared' }] }))
  const r = await $.prompt.compose(COMPOSE as any)
  expect(r.sections.map((s: any) => s.id)).toEqual(['intro'])
})

test('hint: 作業フォルダが途中で移っても、最初に伝えたパスの台帳を読み、診断ログも同じ場所に書く', { options: { debugLog: true } }, async ($, on) => {
  mock.clock(on)
  const told = '/w/work/autonomy/completion-sid.json'
  let cwd = '/w'
  let root = '/w'
  const asked: string[] = []
  const written: string[] = []
  on('session.id', () => ({ value: 'sid' }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.root', () => ({ value: root }))
  on('session.surface', () => ({ value: 'terminal' }) as any)
  on('fs.exists', ($, e) => {
    asked.push(e.path)
    return { value: e.path === told }
  })
  on('fs.read', ($, e) => ({ value: e.path === told ? JSON.stringify(ALL_DONE) : '' }))
  on('fs.write', ($, e) => {
    written.push(e.path)
    return { value: undefined } as any
  })
  on('audio.play', () => ({ value: undefined }))
  on('ui.toast', ($, e: any) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('agent.list', () => ({ value: agents }) as any)
  on('process.run', ($, e: any) => {
    const argv = e.argv as string[]
    ran.push(argv.join(' '))
    if (argv[0] === '/usr/sbin/lsof' && argv.includes('-iTCP')) return { value: { exitCode: 0, stdout: LSOF, stderr: '' } }
    if (argv[0] === '/usr/sbin/lsof') return { value: { exitCode: 0, stdout: 'p3669\nn/Users/me/claudecode/apps/shop\n', stderr: '' } }
    if (argv[0] === '/usr/bin/printenv') return { value: { exitCode: 0, stdout: '/Users/me\n', stderr: '' } }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('store.get', ($, e: any) => ({ value: store[e.key] }))
  on('store.set', ($, e: any) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('command.register', () => ({ value: undefined }) as any)
  on('prompt.submit', ($, e) => ({ text: e.text }) as any)
  on('prompt.compose', () => ({ sections: [] }))
  on('ui.render', ($, e: any) => {
    const { Box, Text } = $.ui.resolve(e) as any
    if (e.component === 'AbovePrompt' || e.component === 'Pane') return <Box />
    // ほかの場所は、エンジンが受け取った中身を文字にして返す（書き換えを確かめるため）
    return <Text>{`ENGINE:${JSON.stringify(e.props)}`}</Text>
  })

  await $.session.start({} as any).catch(() => undefined)
  const first = await $.prompt.compose(COMPOSE as any)
  expect(first.sections.find((s: any) => s.id === 'done-board:ledger')?.text).toContain(told)

  // Bash の cd などで作業フォルダが移り、ルートも別の場所になった
  cwd = '/elsewhere/sub'
  root = '/elsewhere'
  const again = await $.prompt.compose(COMPOSE as any)
  expect(again.sections.find((s: any) => s.id === 'done-board:ledger')?.text).toContain(told)

  await turn($)
  expect(asked[0]).toBe(told)
  expect((await band($)).text).toMatch(/依頼 完了/)
  const logs = written.filter(p => p.endsWith('done-board-debug.log'))
  expect(logs.length).toBeGreaterThan(0)
  expect(new Set(logs)).toEqual(new Set(['/w/.claude/done-board-debug.log']))
})

// ---- ニャンコ: 経験値・レベル・野良猫バトル・早送り・消音 ----

test('nyanko: 消費トークン 500 ごとに 1 EXP、キャッシュ読み込みは数えない', () => {
  expect(xpFromUsage({ input_tokens: 800, output_tokens: 1200, cache_read_input_tokens: 90000 })).toBe(4)
  expect(xpFromUsage(undefined)).toBe(0)
})

test('nyanko: レベルは累計 EXP で決まる（Lv2=50、Lv5=500）', () => {
  expect(xpToReach(2)).toBe(50)
  expect(levelOf(0).level).toBe(1)
  expect(levelOf(49).level).toBe(1)
  expect(levelOf(50).level).toBe(2)
  expect(levelOf(500).level).toBe(5)
  const mid = levelOf(75)
  expect(mid.current).toBe(25)
  expect(mid.need).toBe(100)
})

test('nyanko: バトルは種が同じなら同じ結果で、必ず決着する', () => {
  const enemy = pickEnemy(0.9, 3)
  const a = simulateBattle(42, 3, enemy)
  const b = simulateBattle(42, 3, enemy)
  expect(a).toEqual(b)
  expect(a.steps.length).toBeGreaterThan(0)
  expect(['win', 'lose']).toContain(a.result)
  expect(a.xp).toBeGreaterThan(0)
})

test('nyanko: Lv3 からはまれにボス猫クロが出る', () => {
  expect(pickEnemy(0.1, 3).isBoss).toBe(true)
  expect(pickEnemy(0.1, 2).isBoss).toBe(false)
})

test('nyanko: ターンのトークンで経験値がたまり、レベルが上がると音とトーストで知らせる', async ($, on) => {
  mock.clock(on)
  const sounds: string[] = []
  const store: Record<string, unknown> = {}
  stub(on, null, sounds, undefined, [], store)
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', usage: { input_tokens: 20000, output_tokens: 6000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: 'm' } } as any)
  expect(store.xp).toBe(52)
  expect(sounds).toContain('sounds/lvup.wav')
  expect(toasts.join(' ')).toMatch(/Lv\.2/)
})

test('nyanko: サブエージェントが動いている間は早送りの曲、終わったら元の曲', async ($, on) => {
  const clock = mock.clock(on)
  const sounds: string[] = []
  stub(on, HALF, sounds)
  await $.turn.start({ text: 'work', turnId: 't1' })
  agents = [{ status: 'running' }]
  await clock.advance(4000)
  agents = [{ status: 'completed' }]
  await clock.advance(4000)
  console.log(`SOUND turbo     | ${sounds.join(' → ')}`)
  expect(sounds).toEqual(['sounds/bgm-groove.m4a (loop)', 'sounds/levelup.wav', 'sounds/bgm-turbo.m4a (loop)', 'sounds/bgm-groove.m4a (loop)'])
})

test('nyanko: サブエージェントのターン終了では看板を出さない', async ($, on) => {
  mock.clock(on)
  const sounds: string[] = []
  stub(on, ALL_DONE, sounds)
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false, turnId: 'sub', agentId: 'a1' } as any)
  expect((await band($)).text).not.toMatch(/依頼 完了/)
  expect(sounds).not.toContain('sounds/fanfare.wav')
})

test('nyanko: /nyanko battle で野良猫と戦い、決着で経験値が入って場面が閉じる', async ($, on) => {
  const clock = mock.clock(on)
  const sounds: string[] = []
  const store: Record<string, unknown> = {}
  stub(on, null, sounds, undefined, [], store)
  const r = await $.command.run({ command: 'nyanko', args: 'battle', origin: 'user' } as any)
  expect(r.text).toMatch(/あらわれた/)
  const first = await band($)
  console.log(`RENDER battle0  | ${first.text}`)
  expect(first.text).toMatch(/あらわれた/)
  await clock.advance(30000)
  console.log(`SOUND battle    | ${sounds.join(' → ')}`)
  expect(sounds[0]).toBe('sounds/encounter.wav')
  expect(sounds).toContain('sounds/hit.wav')
  expect(sounds.some(x => x === 'sounds/win.wav' || x === 'sounds/lose.wav')).toBe(true)
  expect(Number(store.xp)).toBeGreaterThan(0)
  expect((await band($)).text).not.toMatch(/あらわれた|WIN|にげ/)
})

test('nyanko: 🔊 ボタンで消音すると BGM も効果音も止まり、設定が残る', async ($, on) => {
  const clock = mock.clock(on)
  const sounds: string[] = []
  const store: Record<string, unknown> = {}
  let ledger: Ledger = HALF
  stub(on, () => ledger, sounds, undefined, [], store)
  await $.turn.start({ text: 'work', turnId: 't1' })
  const ui = await $.ui.mount({ plugin: 'done-board', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100 } })
  await ui.press({ key: 'mute' })
  expect(store.muted).toBe(true)
  const before = sounds.length
  ledger = { status: 'running', items: [{ id: 'a', status: 'done' }, { id: 'b', status: 'done' }, { id: 'c', status: 'pending' }] }
  await clock.advance(4000)
  expect(sounds.length).toBe(before)
  expect(flatten(await ui.drawn())).toMatch(/🔇/)
})

test('nyanko: デスクトップでは何もなくても帯が常に出て、猫のコマ絵とレベルを描く', async ($, on) => {
  mock.clock(on)
  stub(on, null)
  const { svg, source } = await svgOf($, 'idle')
  expect(svg).toBeDefined()
  expect(source).toMatch(/Lv\.1/)
  expect(source).toMatch(/ひと休み中/)
  // 埋め込み画像ではなく図形で描く（デスクトップは <image> を描かない）
  expect(source).toMatch(/<path fill="#f5a623"/)
  expect(source).not.toMatch(/<image/)
  expect(source).toMatch(/data-pose="sleep"/)
})

test('nyanko: 帯の SVG は上限（131072 文字）に収まる', () => {
  // 実際のコマ絵で一番大きいもの（約 2.8 万文字）を想定し、余裕を見て 3.2 万文字
  const big = { paths: `<path d="${'M0 0h1v1h-1z'.repeat(2600)}"/>`, width: 73, height: 56 }
  const s = stripSvg({ width: 760, accent: 'progress', pose: 'run', cat: big, title: 't', detail: 'd', ratio: 0.5, steps: Array(24).fill('done'), level: 9, xpCurrent: 10, xpNeed: 100, playing: 'x', tierRank: 4, streak: 5, isMuted: false, id: 1 })
  expect(s.length).toBeLessThan(131072)
})

test('config: battles を切ると野良猫は出ない（何ターン続いても）', { options: { battles: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const sounds: string[] = []
  stub(on, null, sounds)
  for (let i = 0; i < 40; i++) {
    await turn($)
    await clock.advance(3000)
  }
  expect(sounds).not.toContain('sounds/encounter.wav')
})

// ---- 降ってくるプロンプト・撫でる・localhost ----
test('rain: 送ったプロンプトの文字が帯に降り、しばらくすると消える', async ($, on) => {
  const clock = mock.clock(on)
  stub(on, null)
  await $.prompt.submit({ text: 'ニャンコ、集計を手伝って' }).catch(() => undefined)
  const { source } = await svgOf($, 'rain')
  expect((source.match(/data-rain="/g) ?? []).length).toBe([...'ニャンコ、集計を手伝って'].length)
  await clock.advance(7000)
  const after = await svgOf($, 'rain-after')
  expect(after.source).not.toMatch(/data-rain=/)
})

test('rain: スラッシュコマンドは降らせない', async ($, on) => {
  mock.clock(on)
  stub(on, null)
  await $.prompt.submit({ text: '/nyanko battle' }).catch(() => undefined)
  expect((await svgOf($, 'rain-slash')).source).not.toMatch(/data-rain=/)
})

test('rain: 40 文字までにそろえ、空白はまとめる', () => {
  const s = rainGlyphs('a  b\n' + 'x'.repeat(100), 1, 0, 400, 100)
  expect((s.match(/data-rain="/g) ?? []).length).toBe(40)
})

test('pet: 猫にホバーするとハートと「ゴロゴロ」が出る（CSS の :hover）', async ($, on) => {
  mock.clock(on)
  stub(on, null)
  const { source } = await svgOf($, 'pet-hover')
  expect(source).toMatch(/\.pet:hover \.hearts/)
  expect(source).toMatch(/class="pet"/)
  expect(source).toMatch(/ゴロゴロ/)
})

test('pet: 🐾 で撫でるとゴロゴロ音が鳴り、回数が残り、しばらくで元に戻る', async ($, on) => {
  const clock = mock.clock(on)
  const sounds: string[] = []
  const store: Record<string, unknown> = {}
  stub(on, null, sounds, undefined, [], store)
  const ui = await $.ui.mount({ plugin: 'done-board', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } })
  await ui.press({ key: 'pet' })
  expect(sounds).toContain('sounds/purr.wav')
  expect(store.pets).toBe(1)
  expect(String((await ui.find({ type: 'Svg' }) as any)?.props?.source)).toMatch(/data-pet="on"/)
  await clock.advance(3000)
  expect(String((await ui.find({ type: 'Svg' }) as any)?.props?.source)).toMatch(/data-pet="hover"/)
})

test('localhost: lsof の出力から開発サーバーだけを拾う（常駐アプリと一時ポートは除く）', () => {
  const rows = parseListen(LSOF)
  expect(rows.map(r => r.port)).toEqual([4327, 7000, 8791, 65101])
  expect(rows.filter(r => r.isDev).map(r => `${r.command}:${r.port}`)).toEqual(['node:4327', 'Python:8791'])
  expect(parseCwd('p12\nn/a/b\n').get(12)).toBe('/a/b')
  expect(shortPath('/Users/me/a/b/c/d', '/Users/me')).toBe('…/c/d')
})

test('localhost: 帯に数が出て、ペインで一覧・開く・2 回押しで止める', async ($, on) => {
  mock.clock(on)
  stub(on, null)
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as any).catch(() => undefined)
  const r = await $.command.run({ command: 'localhost', args: '', origin: 'user' } as any)
  expect(r.text).toMatch(/開発サーバー 2 件/)
  expect((await svgOf($, 'servers')).source).toMatch(/localhost 2/)
  const pane = await $.ui.mount({ plugin: 'done-board', surface: 'desktop', component: 'Pane', props: { title: 'localhost', isFocused: true, bodyColumns: 80, placement: 'dock' } as any, requestId: 'done-board-localhost' } as any)
  console.log(`RENDER pane     | ${flatten(await pane.drawn())}`)
  expect(flatten(await pane.drawn())).toMatch(/:4327/)
  expect(flatten(await pane.drawn())).toMatch(/apps\/shop|claudecode\/apps/)
  await pane.press({ key: 'stop-4327' })
  expect(flatten(await pane.drawn())).toMatch(/もう一度押すと止めます/)
  expect(ran.some(x => x.startsWith('/bin/kill'))).toBe(false)
  await pane.press({ key: 'stop-4327' })
  expect(ran).toContain('/bin/kill -TERM 3669')
})

// ---- 画面のあちこちを猫仕立てに ----
async function drawn($: any, component: string, props: any, surface: 'terminal' | 'desktop' = 'terminal') {
  const ui = await $.ui.mount({ plugin: 'done-board', surface, component, props } as any)
  return flatten(await ui.drawn())
}

test('theme: 考え中はターミナルで猫のしぐさ、デスクトップは作業内容に肉球を添える', async ($, on) => {
  mock.clock(on)
  stub(on, null)
  const term = await drawn($, 'Spinner', { word: 'Sauteing', message: null, suffix: '…', mode: 'thinking' })
  expect(term).toMatch(/考え中/)
  expect(term).toMatch(/🐾/)
  const desk = await drawn($, 'Spinner', { word: 'Creating notes.md', message: null, suffix: '…', mode: 'tool-use' }, 'desktop')
  expect(desk).toMatch(/🐾 Creating notes\.md/)
})

test('theme: ターンの終わりの行は肉球スタンプ', async ($, on) => {
  mock.clock(on)
  stub(on, null)
  expect(await drawn($, 'TurnDuration', { word: 'Baked', durationMs: 64000 })).toBe('🐾 1分4秒はたらいたニャ')
})

test('theme: ヒントはもとの案内を残して猫のひとことを足す', async ($, on) => {
  mock.clock(on)
  stub(on, null)
  const term = await drawn($, 'PromptHint', { isDraft: false, isWorking: true, hint: 'esc to interrupt' })
  expect(term).toMatch(/"hint":"esc to interrupt"/)
  expect(term).toMatch(/"tail":"🐈 がんばってるニャ/)
  const desk = await drawn($, 'PromptHint', { isDraft: true, isWorking: false, hint: '? for shortcuts' }, 'desktop')
  expect(desk).toMatch(/\? for shortcuts ・ 🐾 Enter で送るニャ/)
})

test('theme: モード表示にニャンコのレベルが並ぶ', async ($, on) => {
  mock.clock(on)
  stub(on, null)
  expect(await drawn($, 'SessionMode', { modes: ['focus'] }, 'desktop')).toMatch(/"modes":\["focus","🐈 Lv\.1"\]/)
})

test('theme: 確認ダイアログの質問に猫が付く（形式は変えない）', () => {
  const q = catQuestions([{ question: 'どれにする？', header: 'h', options: [], multiSelect: false }, 'x'])
  expect(q[0]).toEqual({ question: '🐈 どれにする？', header: 'h', options: [], multiSelect: false })
  expect(q[1]).toBe('x')
  expect(catQuestions(q)).toEqual(q)
})

test('theme: 自分のプロンプトだけ肉球、ほかの通知はそのまま', async ($, on) => {
  mock.clock(on)
  stub(on, null)
  const mine = await drawn($, 'UserMessage', { text: 'hello', origin: { kind: 'composer' }, isExpanded: false }, 'desktop')
  expect(mine).toMatch(/"text":"🐾 hello"/)
  const task = await drawn($, 'UserMessage', { text: 'done', origin: { kind: 'task-notification' }, isExpanded: false }, 'desktop')
  expect(task).toMatch(/"text":"done"/)
})

test('theme: ツールの行（ターミナル）は種類ごとの猫の顔の後にもとの行を描く', async ($, on) => {
  mock.clock(on)
  stub(on, null)
  const row = await drawn($, 'ToolUse', { tool_use_id: 't', tool: 'Read', input: {}, isRunning: false, isErrored: false, isInterrupted: false })
  expect(row).toMatch(/^🐱👓 ENGINE:/)
  const desk = await drawn($, 'ToolUse', { tool_use_id: 't', tool: 'Read', input: {}, isRunning: false, isErrored: false, isInterrupted: false }, 'desktop')
  expect(desk).toMatch(/^ENGINE:/)
  expect(toolFace('mcp__x__y')).toBe('🐱🔌')
})

test('theme: このプラグインのコマンドの出力は吹き出し、ほかのコマンドはそのまま', async ($, on) => {
  mock.clock(on)
  stub(on, null)
  const mine = await drawn($, 'CommandOutput', { command: 'nyanko', args: '', text: 'ニャンコ Lv.2', isErrored: false }, 'desktop')
  expect(mine).toMatch(/^🐈ニャンコ Lv\.2/)
  const other = await drawn($, 'CommandOutput', { command: 'cost', args: '', text: '$1', isErrored: false }, 'desktop')
  expect(other).toMatch(/^ENGINE:/)
})

test('theme: catTheme を切ると、どこも書き換えない', { options: { catTheme: false } }, async ($, on) => {
  mock.clock(on)
  stub(on, null)
  expect(await drawn($, 'TurnDuration', { word: 'Baked', durationMs: 3000 })).toMatch(/^ENGINE:/)
  expect(await drawn($, 'Spinner', { word: 'Sauteing', message: null, suffix: '…', mode: 'thinking' })).toMatch(/Sauteing/)
})

test('theme: 言い回しの部品', () => {
  expect(spinnerWord('tool-use', 4)).toMatch(/作業中|追いかけ中/)
  expect(turnLine(3000, 5)).toBe('🐾 3秒はたらいたニャ ・ +5 EXP')
  expect(catBackgroundHint('(ctrl+b to run in background)')).toBe('(ctrl+b to run in background ニャ)')
})

// ---- ツンデレモード（霧島レイ） ----
test('tsun: プロンプトの言葉づかいでパラメータとひとことが変わる', () => {
  expect(readPrompt('ありがとう、助かった', 14)).toMatchObject({ affection: 3, expression: 'blush' })
  expect(readPrompt('早くしろよ', 14)).toMatchObject({ mood: -12, expression: 'angry' })
  expect(readPrompt('レイさんかわいい', 14)).toMatchObject({ affection: 5, expression: 'blush' })
  expect(readPrompt('ログの整理をして', 2)).toMatchObject({ expression: 'worried' })
  expect(readPrompt('a'.repeat(130), 14)).toMatchObject({ trust: 2, expression: 'smug' })
  expect(readPrompt('直して', 14)).toMatchObject({ expression: 'angry' })
  expect(readPrompt('テストを追加してください', 14).line).toMatch(/やってあげる/)
})

test('tsun: 好感度で段階が変わり、100 で攻略完了（一度だけ）', () => {
  expect(stageOf({ ...INITIAL, affection: 10 })).toBe('tsun')
  expect(stageOf({ ...INITIAL, affection: 30 })).toBe('warm')
  expect(stageOf({ ...INITIAL, affection: 60 })).toBe('dere')
  expect(stageOf({ ...INITIAL, affection: 90 })).toBe('deredere')
  const a = apply({ ...INITIAL, affection: 98 }, { affection: 5, trust: 0, mood: 0 })
  expect(a.next.affection).toBe(100)
  expect(a.isNewlyCleared).toBe(true)
  expect(stageOf(a.next)).toBe('lover')
  expect(apply(a.next, { affection: 1, trust: 0, mood: 0 }).isNewlyCleared).toBe(false)
  expect(apply({ ...INITIAL, affection: 1 }, { affection: -5, trust: 0, mood: -80 }).next).toMatchObject({ affection: 0, mood: -50 })
})

test('tsun: タスクをツンデレの口調で言う（ツン期とデレ期で言い方が変わる）', () => {
  expect(toolLine('Read', 'tsun').line).toMatch(/自分で読みなさい/)
  expect(toolLine('Read', 'dere').line).toMatch(/丁寧に読んであげる/)
  expect(taskLine({ kind: 'itemStart', note: '集計' }, 'tsun').line).toMatch(/次は「集計」ね/)
  expect(taskLine({ kind: 'itemDone', note: '集計', done: 1, total: 3 }, 'tsun').line).toMatch(/褒めてもいいのよ/)
  expect(taskLine({ kind: 'allDone', summary: '売上レポート' }, 'deredere')).toMatchObject({ expression: 'happy' })
  expect(taskLine({ kind: 'blocked', note: '2FA' }, 'tsun').line).toMatch(/あんたの番/)
})

test('tsun: セリフは最大 3 行で折り返し、あふれたら … で切る', () => {
  expect(wrapLine('あいうえお', 4)).toEqual(['あい', 'うえ', 'お'])
  const long = wrapLine('あ'.repeat(40), 10)
  expect(long.length).toBe(3)
  expect(long[2]!.endsWith('…')).toBe(true)
})

test('tsun: /tsundere on で帯がノベルゲーム風になり、プロンプトに反応して好感度が上がる', async ($, on) => {
  const clock = mock.clock(on)
  const store: Record<string, unknown> = {}
  stub(on, null, [], undefined, [], store)
  const r = await $.command.run({ command: 'tsundere', args: 'on', origin: 'user' } as any)
  expect(r.text).toMatch(/べ、別に/)
  expect(store.character).toBe('tsundere')
  await clock.advance(1000)
  await $.prompt.submit({ text: 'ありがとう、いつも助かってる' }).catch(() => undefined)
  const { svg, source } = await svgOf($, 'tsun')
  expect(source).toMatch(/霧島レイ/)
  expect(source).toMatch(/お礼なんていらない/)
  expect(source).toMatch(/好感度 ♥/)
  expect(source).toMatch(/<animate attributeName="width"/)
  expect(String(svg.props.alt)).toMatch(/好感度 13/)
  expect((store.tsun as any).affection).toBe(13)
})

test('tsun: ツールを使うとそれっぽくひとこと（数秒に 1 回まで）、考え中もツンデレ口調', async ($, on) => {
  const clock = mock.clock(on)
  stub(on, null)
  // テストの土台側のツール実行（プラグインのフックはその上で動く）
  on('tool.call', () => ({ result: { ok: true } }) as any)
  await $.command.run({ command: 'tsundere', args: 'on', origin: 'user' } as any)
  await clock.advance(5000)
  await $.tool.call({ tool: 'Grep', pattern: 'x' } as any).catch(() => undefined)
  expect((await svgOf($, 'tsun-tool')).source).toMatch(/探してあげるわ/)
  const sp = await drawn($, 'Spinner', { word: 'Sauteing', message: null, suffix: '…', mode: 'thinking' })
  expect(sp).toMatch(/べ、別に考えてないし/)
})

test('tsun: 項目が終わると「〜終わらせてあげたわ」と言い、好感度と信頼が上がる', async ($, on) => {
  const clock = mock.clock(on)
  const store: Record<string, unknown> = {}
  let ledger: Ledger = { status: 'running', items: [{ id: 'a', status: 'running', note: '集計' }, { id: 'b', status: 'pending', note: 'グラフ' }, { id: 'c', status: 'pending', note: 'まとめ' }] }
  stub(on, () => ledger, [], undefined, [], store)
  await $.command.run({ command: 'tsundere', args: 'on', origin: 'user' } as any)
  await $.turn.start({ text: 'work', turnId: 't1' })
  ledger = { status: 'running', items: [{ id: 'a', status: 'done', note: '集計' }, { id: 'b', status: 'running', note: 'グラフ' }, { id: 'c', status: 'pending', note: 'まとめ' }] }
  await clock.advance(4000)
  const { source } = await svgOf($, 'tsun-done')
  expect(source).toMatch(/「集計」、終わらせてあげたわ/)
  expect((store.tsun as any)).toMatchObject({ affection: 11, trust: 1 })
})

test('tsun: 好感度 100 で攻略完了のイベント（ファンファーレとトースト）', async ($, on) => {
  mock.clock(on)
  const sounds: string[] = []
  const store: Record<string, unknown> = { tsun: { affection: 97, trust: 50, mood: 0, isCleared: false } }
  stub(on, null, sounds, undefined, [], store)
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as any).catch(() => undefined)
  await $.command.run({ command: 'tsundere', args: 'on', origin: 'user' } as any)
  await $.prompt.submit({ text: 'ありがとう' }).catch(() => undefined)
  expect(toasts.join(' ')).toMatch(/攻略しました/)
  expect(sounds).toContain('sounds/fanfare.wav')
  const end = (await svgOf($, 'tsun-end')).source
  expect(end).toMatch(/今まで素直になれなかった/)
  expect(end).toMatch(/仕事するの、好き/)
  expect(end).toMatch(/攻略済み ♥/)
})

test('tsun: /tsundere off でニャンコに戻る', async ($, on) => {
  mock.clock(on)
  stub(on, null)
  await $.command.run({ command: 'tsundere', args: 'on', origin: 'user' } as any)
  await $.command.run({ command: 'tsundere', args: 'off', origin: 'user' } as any)
  const { source } = await svgOf($, 'tsun-off')
  expect(source).not.toMatch(/霧島レイ/)
  expect(source).toMatch(/ひと休み中/)
})

test('tsun: 行頭禁則（句読点や閉じかっこを行の頭に置かない）', () => {
  const rows = wrapLine('あいう。えお', 6)
  expect(rows[0]).toBe('あいう。')
  expect(rows.every(r => !/^[、。」！？]/.test(r))).toBe(true)
})
