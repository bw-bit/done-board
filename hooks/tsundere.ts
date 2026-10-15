// ツンデレモード「霧島レイ」: パラメータ・プロンプトの読み取り・セリフ（$ を使わない純粋な関数だけ）

export type Expression = 'normal' | 'angry' | 'blush' | 'smug' | 'worried' | 'happy'
export type Stage = 'tsun' | 'warm' | 'dere' | 'deredere' | 'lover'

export type Params = {
  affection: number // 好感度 0〜100。100 で攻略完了
  trust: number // 信頼 0〜100。きちんとした依頼や完了で上がる
  mood: number // 機嫌 -50〜50。ターンごとに 0 へ戻っていく
  isCleared: boolean // 一度でも好感度 100 に届いたか
}

export const NAME = '霧島レイ'
export const INITIAL: Params = { affection: 10, trust: 0, mood: 0, isCleared: false }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function stageOf(p: Params): Stage {
  if (p.isCleared) return 'lover'
  if (p.affection >= 80) return 'deredere'
  if (p.affection >= 50) return 'dere'
  if (p.affection >= 25) return 'warm'
  return 'tsun'
}

export const STAGE_LABEL: Record<Stage, string> = {
  tsun: 'ツン 100%',
  warm: 'ちょいデレ',
  dere: 'デレ期',
  deredere: 'デレデレ',
  lover: '攻略済み ♥',
}

export type Reaction = {
  affection: number
  trust: number
  mood: number
  expression: Expression
  line: string
}

// プロンプトの読み取り: 言葉づかい・長さ・時間帯で、パラメータとひとことが決まる
const PRAISE_HER = /(かわいい|可愛い|綺麗|きれい|好き|大好き|レイ(さん|先輩)?)/
const THANKS = /(ありがとう|ありがと|感謝|助かる|助かった|さすが|すごい|天才|thanks|thank you)/i
const PLEASE = /(お願い|おねがい|よろしく|頼む|頼みます|please)/i
const RUDE = /(早くしろ|はやくしろ|遅い|おそい|使えない|ばか|バカ|アホ|ちゃんとしろ|最悪|ダメすぎ|ふざけ)/i

export function readPrompt(text: string, hour: number): Reaction {
  const t = text.trim()
  if (RUDE.test(t)) {
    return { affection: -2, trust: 0, mood: -12, expression: 'angry', line: 'はぁ？ 誰に向かって言ってるの。…やるけど。あたしだからやってあげるのよ' }
  }
  if (PRAISE_HER.test(t)) {
    return { affection: 5, trust: 0, mood: 8, expression: 'blush', line: 'な、何言ってんのよ急に…！ 仕事しなさいよね、仕事！' }
  }
  if (THANKS.test(t)) {
    return { affection: 3, trust: 1, mood: 6, expression: 'blush', line: 'べ、別にお礼なんていらないわよ。…まあ、悪い気はしないけど' }
  }
  if (hour >= 0 && hour < 5) {
    return { affection: 1, trust: 0, mood: -2, expression: 'worried', line: 'こんな時間まで起きてるの？ …べ、別に心配なんかしてないから。さっさと終わらせて寝なさい' }
  }
  if (t.length > 120) {
    return { affection: 1, trust: 2, mood: 3, expression: 'smug', line: 'ふーん、ちゃんと考えてきたじゃない。これならあたしも本気出してあげる' }
  }
  if (t.length > 0 && t.length < 6) {
    return { affection: 0, trust: 0, mood: -3, expression: 'angry', line: 'それだけ？ もうちょっとちゃんと説明しなさいよ。エスパーじゃないんだから' }
  }
  if (PLEASE.test(t)) {
    return { affection: 1, trust: 1, mood: 3, expression: 'smug', line: 'しょうがないわね。あたしに頼んだのは正解よ' }
  }
  return { affection: 0, trust: 0, mood: 0, expression: 'normal', line: 'ふん、いいわよ。あんたのためじゃないけど、やってあげる' }
}

export function apply(p: Params, r: { affection: number; trust: number; mood: number }): { next: Params; isNewlyCleared: boolean } {
  const affection = clamp(p.affection + r.affection, 0, 100)
  const isNewlyCleared = !p.isCleared && affection >= 100
  return {
    next: { affection, trust: clamp(p.trust + r.trust, 0, 100), mood: clamp(p.mood + r.mood, -50, 50), isCleared: p.isCleared || isNewlyCleared },
    isNewlyCleared,
  }
}

// ターンごとに機嫌は 0 へ戻っていく（3 割ずつ）
export function cool(p: Params): Params {
  return { ...p, mood: Math.round(p.mood * 0.7) }
}

// 好感度の段階で同じ場面でも言い方が変わる。[ツン寄り, デレ寄り]
function byStage(stage: Stage, tsun: string, dere: string): string {
  return stage === 'tsun' || stage === 'warm' ? tsun : dere
}

// ツールを使うときのひとこと（タスクをそれっぽく言う）
export function toolLine(tool: string, stage: Stage): { expression: Expression; line: string } {
  const d = stage === 'dere' || stage === 'deredere' || stage === 'lover'
  switch (tool) {
    case 'Read':
      return { expression: 'normal', line: d ? 'ここ読めばいいのね。あんたのためなら、ちょっとだけ丁寧に読んであげる' : 'ファイルくらい自分で読みなさいよね。…まあ、読んであげるけど' }
    case 'Grep':
    case 'Glob':
      return { expression: 'smug', line: d ? '探し物？ あたしが見つけてあげる。…一緒に探すのも悪くないし' : '探してあげるわ。あんたが探すより百倍速いんだから、感謝しなさい' }
    case 'Edit':
    case 'MultiEdit':
      return { expression: 'smug', line: d ? '直しておくね。…あんたのコード、嫌いじゃないから' : 'ここ直すのね。べ、別にあんたのために直すんじゃないんだから' }
    case 'Write':
      return { expression: 'normal', line: d ? '書いておいたよ。…ちゃんと見てね？' : '書いておいてあげたわ。ありがたく使いなさい' }
    case 'Bash':
      return { expression: 'smug', line: d ? 'コマンド叩くね。危なくなったらあたしが止めるから、安心して' : 'コマンド叩くわよ。今さら止めても無駄なんだから' }
    case 'WebSearch':
    case 'WebFetch':
      return { expression: 'normal', line: d ? '調べてくるね。待ってて' : '調べてあげるわよ、しょうがないわね' }
    case 'Agent':
    case 'Task':
      return { expression: 'smug', line: d ? '手伝いを呼ぶね。…でも一番頼りになるのはあたしでしょ？' : '部下を呼ぶわ。あたし一人で十分だけど、あんたが遅いから' }
    case 'TodoWrite':
      return { expression: 'normal', line: d ? 'やること、まとめておいたよ' : 'やることくらい整理しておきなさいよ。…ほら、まとめてあげた' }
    default:
      return { expression: 'normal', line: d ? 'これも手伝うね' : `${tool.startsWith('mcp__') ? '外の道具' : tool}も使ってあげる。ありがたく思いなさい` }
  }
}

export type TaskEvent =
  | { kind: 'turnStart' }
  | { kind: 'itemStart'; note: string }
  | { kind: 'itemDone'; note: string; done: number; total: number }
  | { kind: 'allDone'; summary: string }
  | { kind: 'blocked'; note: string }
  | { kind: 'turnEnd'; seconds: number }
  | { kind: 'subagents'; count: number }
  | { kind: 'levelUp'; level: number }
  | { kind: 'idle' }

// 作業の場面ごとのセリフ
export function taskLine(e: TaskEvent, stage: Stage): { expression: Expression; line: string } {
  switch (e.kind) {
    case 'turnStart':
      return { expression: 'normal', line: byStage(stage, 'はいはい、始めるわよ。黙って見てなさい', '始めるね。…隣で見ててくれる？') }
    case 'itemStart':
      return { expression: 'smug', line: byStage(stage, `次は「${e.note}」ね。あたしにかかれば一瞬よ`, `次は「${e.note}」。一緒にがんばろ？`) }
    case 'itemDone':
      return e.done >= e.total - 1 && e.total > 1
        ? { expression: 'smug', line: byStage(stage, `「${e.note}」終わり。あと少しよ、最後まで気を抜かないことね`, `「${e.note}」できたよ。あとちょっと、がんばろうね`) }
        : { expression: 'smug', line: byStage(stage, `「${e.note}」、終わらせてあげたわ。…褒めてもいいのよ？`, `「${e.note}」終わったよ。…えへへ、褒めて？`) }
    case 'allDone':
      return stage === 'tsun' || stage === 'warm'
        ? { expression: 'smug', line: `ふん、全部終わったわよ。${e.summary ? `「${e.summary}」なんて、` : ''}あたしにかかればこんなものね` }
        : { expression: 'happy', line: `全部終わったよ！${e.summary ? `「${e.summary}」、` : ''}あんたと一緒だったから…楽しかった` }
    case 'blocked':
      return { expression: 'angry', line: byStage(stage, `ちょっと、あんたの番よ。「${e.note}」は自分でやりなさいよね`, `ここだけ、あんたにお願いしてもいい？「${e.note}」`) }
    case 'turnEnd':
      return { expression: 'normal', line: byStage(stage, `${e.seconds}秒で終わらせてあげたわ。次は？`, `${e.seconds}秒で終わったよ。次は何する？`) }
    case 'subagents':
      return { expression: 'smug', line: byStage(stage, `部下を${e.count}人働かせてるわ。早送りで片付けるから`, `${e.count}人で手分けしてるよ。すぐ終わるからね`) }
    case 'levelUp':
      return { expression: 'blush', line: byStage(stage, `Lv.${e.level}…べ、別にあんたのおかげじゃないんだから`, `Lv.${e.level}になったよ。…あんたのおかげ、かな` ) }
    case 'idle':
      return { expression: stage === 'tsun' ? 'normal' : 'happy', line: byStage(stage, '…で？ 何か用があるなら早く言いなさいよ', '…ねえ、次は何する？') }
  }
}

// 攻略完了（好感度 100）のイベント
export const ENDING_LINE = 'あ、あのね…！ 今まで素直になれなかったけど…あたし、あんたと一緒に仕事するの、好き。…今のは忘れなさいよね！'

// 画面のあちこち（考え中・ヒント・ターンの終わり）をツンデレの口調に
export function tsunSpinner(mode: string, stage: Stage): string {
  const d = stage === 'dere' || stage === 'deredere' || stage === 'lover'
  if (mode === 'thinking') return d ? 'レイが考えてるよ' : 'べ、別に考えてないし'
  if (mode === 'tool-use' || mode === 'tool-input') return d ? 'レイが作業中' : '仕方なく作業中'
  if (mode === 'responding') return d ? 'レイが書いてるよ' : '書いてあげてるの'
  return d ? 'レイが聞いてるよ' : '聞いてあげてるわよ'
}

export function tsunHint(isWorking: boolean, isDraft: boolean, stage: Stage): string {
  const d = stage === 'dere' || stage === 'deredere' || stage === 'lover'
  if (isWorking) return d ? '💗 待っててね' : '💢 今やってるでしょ'
  if (isDraft) return d ? '💗 送って？' : '💢 さっさと送りなさいよ'
  return d ? '💗 なにする？' : '💢 早く言いなさいよ'
}

export function tsunTurnLine(durationMs: number, stage: Stage): string {
  const s = Math.max(0, Math.round(durationMs / 1000))
  const took = s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${s % 60}秒`
  return stage === 'tsun' || stage === 'warm' ? `💢 ${took}で終わらせてあげたわ` : `💗 ${took}、おつかれさま`
}

// 一日 1 回のコーヒーの差し入れ（/tsundere gift）
export function giftLine(stage: Stage, isAgain: boolean): { expression: Expression; line: string; affection: number } {
  if (isAgain) return { expression: 'angry', line: 'さっきもらったでしょ。…そんなに飲めないわよ', affection: 0 }
  return stage === 'tsun' || stage === 'warm'
    ? { expression: 'blush', line: 'コーヒー？ …べ、別に欲しかったわけじゃないけど、もらってあげる', affection: 4 }
    : { expression: 'happy', line: 'わあ、ありがと！ …あんたの分も淹れてあげよっか', affection: 4 }
}
