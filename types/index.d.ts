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

// 野良猫バトルの表示に使う、いまの場面
export type BattleState = {
  enemyId: 'stray1' | 'stray2'
  enemyName: string
  enemyLevel: number
  enemyHp: number
  enemyMaxHp: number
  playerHp: number
  playerMaxHp: number
  text: string
  hitBy: 'player' | 'enemy' | null
  result: 'win' | 'lose' | null
  catPose: 'wait' | 'attack' | 'hurt' | 'joy'
  id: number
}

// localhost で待ち受けているサーバー（ペインと帯の 🌐 に使う）
export type ServerRow = { port: number; pid: number; command: string; host: string; cwd?: string; isDev: boolean }

// ツンデレモードのパラメータと、いま出ているセリフ
export type TsunParams = { affection: number; trust: number; mood: number; isCleared: boolean }
export type TsunLine = { expression: 'normal' | 'angry' | 'blush' | 'smug' | 'worried' | 'happy'; line: string; at: number; id: number }

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
      // Claude に伝えた台帳の絶対パス。作業フォルダが途中で移っても、まずここを読む
      ledgerPath: string | null
      // 診断ログの絶対パス。最初に決めた場所に書き続ける
      logPath: string | null
      // 累計の経験値（消費トークンとバトルで増える）。$.store にも保存してセッションをまたぐ
      xp: number
      // 音をすべて消しているか（帯の 🔊 ボタン）。$.store にも保存する
      isMuted: boolean
      // 野良猫バトル中の場面。戦っていなければ null
      battle: BattleState | null
      // いま動いているサブエージェントの数（早送りの曲に切り替える）
      agentsRunning: number
      // バトルの勝利数。$.store にも保存する
      wins: number
      // 送ったプロンプトの文字（帯に降らせる）。降り終わると null
      rain: { text: string; id: number } | null
      // 🐾 で撫でた直後か
      isPetting: boolean
      // 撫でた回数。$.store にも保存する
      pets: number
      // localhost のサーバー一覧と、止める確認中のポート・全部見せるか
      servers: ServerRow[]
      stopArmed: number | null
      isShowingAllServers: boolean
      // 帯のキャラクター（nyanko: ニャンコ / tsundere: ツンデレの霧島レイ）。$.store にも保存する
      character: 'nyanko' | 'tsundere'
      // ツンデレモードのパラメータ（$.store にも保存）と、いま出ているセリフ
      tsun: TsunParams
      tsunLine: TsunLine | null
    }
  }
}
