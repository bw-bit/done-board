import { test, expect, mock } from 'claude-code/testing'
import type { On } from 'claude-code'

// 1つの依頼が進んで完了し、その後の雑談まで、看板の動きを時系列で再生するデモ
type Item = { id: string; status: string; note?: string }
type Ledger = { status: string; request_summary?: string; items: Item[] } | null

function flatten(el: any): string {
  if (el === null || el === undefined || typeof el === 'boolean') return ''
  if (typeof el === 'string' || typeof el === 'number') return String(el)
  if (Array.isArray(el)) return el.map(flatten).join('')
  if (el.type === 'Button') return `[${el.props?.label}]`
  if (el.type === 'Svg') return `<svg: ${el.props?.alt}>`
  return flatten(el.children ?? el.props?.children)
}

test('demo: 依頼の始まりから完了、消えるまで', async ($, on: On) => {
  const clock = mock.clock(on)
  let ledger: Ledger = null
  let now = 0
  on('session.id', () => ({ value: 'sid' }))
  on('session.cwd', () => ({ value: '/w' }))
  on('session.root', () => ({ value: '/w' }))
  on('fs.exists', ($, e) => ({ value: ledger !== null && e.path.endsWith('completion-sid.json') }))
  on('fs.read', () => ({ value: JSON.stringify(ledger) }))
  on('audio.play', ($, e) => {
    console.log(`  ♪ t=${(now / 1000).toFixed(1)}s ${e.clip.asset}`)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    console.log(`  🔔 toast: ${(e as any).text}`)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', ($, e) => ({ text: e.text }) as any)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  const frame = async (label: string) => {
    const ui = await $.ui.mount({ plugin: 'done-board', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } })
    const drawn = await ui.drawn()
    const title = await ui.find({ type: 'Text', text: /完了|途中|要対応/ })
    const dim = (title as any)?.props?.dimColor ? '（薄く表示）' : ''
    console.log(`t=${(now / 1000).toFixed(1).padStart(5)}s ${label.padEnd(16)}│ ${flatten(drawn) || '（看板なし）'} ${dim}`)
    await ui.unmount()
  }
  const wait = async (ms: number) => { await clock.advance(ms); now += ms }
  const turn = async (prompt: string, ms: number) => {
    console.log(`\n▶ ユーザー「${prompt}」`)
    await $.prompt.submit({ text: prompt }).catch(() => undefined)
    await frame('送信直後')
    now += ms
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: ms, isAborted: false, turnId: prompt })
  }

  const items = (s: string[]): Item[] => [
    { id: 'design', status: s[0]!, note: '看板のデザイン' },
    { id: 'build', status: s[1]!, note: 'mod を実装' },
    { id: 'test', status: s[2]!, note: 'テストを通す' },
  ]

  // 1. 依頼の途中
  ledger = { status: 'running', request_summary: '看板 mod を作る', items: items(['done', 'running', 'pending']) }
  await turn('看板 mod を作って', 95000)
  await frame('ターン終了')

  // 2. 外部待ちが発生
  ledger = { status: 'running', request_summary: '看板 mod を作る', items: [...items(['done', 'done', 'pending']).slice(0, 2), { id: 'test', status: 'blocked', note: 'ホットリロード許可待ち' }] }
  await turn('続けて', 40000)
  await frame('ターン終了')

  // 3. 完了 → ポップ → 薄くなる → 消える
  ledger = { status: 'done', request_summary: '看板 mod を作る', items: items(['done', 'done', 'done']) }
  await turn('許可したよ', 134000)
  await frame('完了直後')
  await wait(400); await frame('ポップ中')
  await wait(400); await frame('ポップ完了')
  await wait(10500); await frame('消える直前')
  await wait(3000); await frame('時間切れ')

  // 4. 終わった後の雑談: 古い台帳では祝わず、短いので音もなし
  await turn('ありがとう', 4000)
  await frame('ターン終了')
  await wait(7000); await frame('6秒後')

  expect(true).toBe(true)
})
