import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'
import { cardSvg } from './card-svg'

// 依頼台帳を差し替えて、ターン終了時に看板がどう描かれるかを確かめる
type Item = { id: string; status: string; note?: string }
type Ledger = { status: string; request_summary?: string; items: Item[] } | null

function stub(on: On, ledgerOf: Ledger | (() => Ledger | string), sounds: string[] = [], ledgerPath = '/w/work/autonomy/completion-sid.json', asked: string[] = []) {
  const get = () => (typeof ledgerOf === 'function' ? ledgerOf() : ledgerOf)
  on('session.id', () => ({ value: 'sid' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.root', () => ({ value: '/w' }))
  on('fs.exists', ($, e) => {
    asked.push(e.path)
    return { value: get() !== null && e.path === ledgerPath }
  })
  on('fs.read', () => {
    const l = get()
    return { value: typeof l === 'string' ? l : JSON.stringify(l) }
  })
  on('audio.play', ($, e) => {
    sounds.push((e.clip.asset ?? '?') + (e.shouldLoop ? ' (loop)' : ''))
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('command.register', () => ({ value: undefined }) as any)
  on('prompt.submit', ($, e) => ({ text: e.text }) as any)
  // 看板が何も出さないときにエンジンが描くもの（空の帯）
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
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
  console.log(`RENDER done+60s | ${after.text || '(消えた)'}`)
  expect(after.text).toBe('')
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
  expect(after.text).toBe('')
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
  expect((await band($)).text).toBe('')
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

test('u1: カードごとにグラデーションの id が違う（並べても色が混ざらない）', async () => {
  const mk = (kind: any, id: number) => cardSvg({ card: { kind, title: 't', detail: 'd', done: 1, total: 2, id, phase: 'shown', frame: 0 }, icon: '◐', playing: null, width: 400 })
  const a = mk('done', 1).match(/linearGradient id="([^"]+)"/)![1]
  const b = mk('blocked', 2).match(/linearGradient id="([^"]+)"/)![1]
  expect(a).not.toBe(b)
})

// ---- UIループ2回目: 動き・全体像・テンポ・連続 ----
const VIEW = ({ card: cardOver = {}, ...over }: any = {}) => cardSvg({
  icon: '✧', playing: 'ドライブ ×1.1', width: 640, tierRank: 2, streak: 3, ...over,
  card: { kind: 'progress', title: '+1 完了', detail: 'build', done: 2, total: 4, id: 1, phase: 'pop', frame: 0, steps: ['done', 'done', 'running', 'pending'], fromRatio: 0.25, ...cardOver },
})

test('u2: リングは前回の割合から今回の割合へ伸びるアニメーション', () => {
  const s = VIEW()
  expect(s).toMatch(/<animate attributeName="stroke-dashoffset"/)
})

test('u2: 項目ごとの状態を点で並べる', () => {
  const s = VIEW()
  expect((s.match(/data-step="/g) ?? []).length).toBe(4)
  expect(s).toMatch(/data-step="running"/)
})

test('u2: テンポメーターは4段で、今の段まで点灯する', () => {
  const s = VIEW()
  expect((s.match(/data-tempo="on"/g) ?? []).length).toBe(3)
  expect((s.match(/data-tempo="off"/g) ?? []).length).toBe(1)
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
  const s = VIEW({ card: { detail: 'build ・ 2/4 ・ 🔥3連続' } })
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
