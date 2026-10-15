export type Kind = 'done' | 'progress' | 'blocked' | 'turn'
export type Card = {
  kind: Kind
  title: string
  detail: string
  done: number
  total: number
  id: number
  // pop: 出た直後のアニメ中 / shown: 通常 / fading: 消える直前で薄い
  phase: 'pop' | 'shown' | 'fading'
  frame: number
  // 台帳の各項目の状態（点で並べる）。台帳のない看板では省略
  steps?: string[]
  // リングを伸ばし始める割合（前回の進み具合）
  fromRatio?: number
}

declare module 'claude-code' {
  interface PluginState {
    'done-board': {
      card: Card | null
      // 前回見た台帳の状態（id:status の並び）。変化したときだけ祝う
      lastSig: string | null
      // 作業BGMを流すか（/bgm on|off）
      isMusicOn: boolean
      // いま流れているBGMの表示名。止まっていれば null
      nowPlaying: string | null
      // 連続で終えた項目数。依頼が終わるとリセット
      streak: number
    }
  }
}
