// 画面のあちこちを猫仕立てにする言い回しと記号（$ を使わない純粋な関数だけ）

// 考え中の表示: 作業の段階ごとに猫のしぐさを選ぶ
const SPINNER_WORDS: Record<string, readonly string[]> = {
  thinking: ['ニャンコが考え中', '毛づくろいしながら考え中', 'しっぽふりふり考え中', 'ひげをぴくぴく考え中'],
  requesting: ['ニャンコが耳をすませ中', 'ニャンコが様子見中'],
  responding: ['ニャンコが書いてる', '肉球でタイプ中'],
  'tool-input': ['ニャンコが準備中', '爪をといで準備中'],
  'tool-use': ['ニャンコが作業中', 'ねこじゃらしを追いかけ中', '爪とぎしながら作業中'],
}

// 同じターンの間は同じ言い回しになるよう、種から選ぶ
export function spinnerWord(mode: string, seed: number): string {
  const list = SPINNER_WORDS[mode] ?? SPINNER_WORDS.thinking!
  return list[Math.abs(seed) % list.length]!
}

// デスクトップの考え中の表示は「いま何をしているか」を出すので、言い回しを置き換えず肉球を添える
export function desktopSpinnerWord(word: string): string {
  return word.startsWith('🐾') ? word : `🐾 ${word}`
}

// ツールの種類ごとの猫の顔
const TOOL_FACE: Record<string, string> = {
  Read: '🐱👓',
  Glob: '🐱🔍',
  Grep: '🐱🔍',
  Edit: '🐱✏️',
  MultiEdit: '🐱✏️',
  Write: '🐱📝',
  NotebookEdit: '🐱📝',
  Bash: '🐱🔧',
  WebFetch: '🐱🌐',
  WebSearch: '🐱🌐',
  Agent: '🐱🐱',
  Task: '🐱🐱',
  TodoWrite: '🐱📋',
}

export function toolFace(tool: string): string {
  if (TOOL_FACE[tool] !== undefined) return TOOL_FACE[tool]!
  if (tool.startsWith('mcp__')) return '🐱🔌'
  return '🐱'
}

// ターンの終わりの行: 「🐾 3秒はたらいたニャ」
export function turnLine(durationMs: number, xpGained: number): string {
  const s = Math.max(0, Math.round(durationMs / 1000))
  const took = s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${s % 60}秒`
  return `🐾 ${took}はたらいたニャ${xpGained > 0 ? ` ・ +${xpGained} EXP` : ''}`
}

// 入力欄の下のヒント: もとの案内は残し、猫のひとことを足す
export function hintTail(isWorking: boolean, isDraft: boolean, level: number): string {
  if (isWorking) return `🐈 がんばってるニャ（Lv.${level}）`
  if (isDraft) return '🐾 Enter で送るニャ'
  return `🐈 Lv.${level} ・ なにする？`
}

// 確認ダイアログ: 質問の頭に猫を添える（形式はそのまま）
export function catQuestions(questions: readonly unknown[]): unknown[] {
  return questions.map(q => {
    if (q === null || typeof q !== 'object') return q
    const item = q as { question?: unknown }
    if (typeof item.question !== 'string' || item.question.startsWith('🐈')) return q
    return { ...item, question: `🐈 ${item.question}` }
  })
}

// 一般のお知らせの行
export function catNotice(text: string): string {
  return text.startsWith('🐈') ? text : `🐈 ${text}`
}

// 裏に回すヒント（ctrl+b など）は、キーの案内を残して猫の口調にする
export function catBackgroundHint(hint: string): string {
  if (hint === '' || hint.includes('ニャ')) return hint
  return hint.replace(/\)$/, ' ニャ)')
}
