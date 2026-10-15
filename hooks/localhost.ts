// localhost で待ち受けている開発サーバーの一覧（$ を使わない純粋な関数だけ）

export type Server = {
  port: number
  pid: number
  command: string
  host: string
  // 起動したフォルダ（分かれば）
  cwd?: string
  isDev: boolean
}

// 開発サーバーらしいコマンド名（lsof は 9 文字で切るので前方一致で見る）
const DEV = /^(node|bun|deno|python|ruby|php|java|go|uvicorn|gunicorn|vite|next|nuxt|astro|ollama|com\.docke|docker|postgres|redis|mysqld|ssh|caddy|nginx|hugo|jekyll|rails|cargo|dotnet)/i
// 一時ポート（49152 以上）はアプリ内部の通信が多いので、開発サーバーとはみなさない
const EPHEMERAL_FROM = 49152

// lsof -nP -iTCP -sTCP:LISTEN の出力を、ポートごとに 1 行へまとめる
export function parseListen(stdout: string): Server[] {
  const byPort = new Map<number, Server>()
  for (const line of stdout.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 9) continue
    const command = (cols[0] ?? '').replace(/\\x20/g, ' ')
    const pid = Number(cols[1])
    // 最後の列は「(LISTEN)」、その手前が「ホスト:ポート」
    const name = cols[cols.length - 1] === '(LISTEN)' ? cols[cols.length - 2] ?? '' : cols[cols.length - 1] ?? ''
    const m = name.match(/^(.*):(\d+)$/)
    if (m === null || !Number.isFinite(pid)) continue
    const host = m[1] ?? '*'
    const port = Number(m[2])
    if (byPort.has(port)) continue
    const isDev = DEV.test(command) && port < EPHEMERAL_FROM
    byPort.set(port, { port, pid, command, host, isDev })
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port)
}

// lsof -a -d cwd -p <pid,...> -Fpn の出力から、pid ごとの作業フォルダを読む
export function parseCwd(stdout: string): Map<number, string> {
  const out = new Map<number, string>()
  let pid = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid > 0) out.set(pid, line.slice(1))
  }
  return out
}

// ホームを ~ に縮め、長いパスは末尾 2 階層だけ見せる
export function shortPath(path: string, home: string): string {
  const p = home !== '' && path.startsWith(home) ? `~${path.slice(home.length)}` : path
  const parts = p.split('/')
  return parts.length > 4 ? `…/${parts.slice(-2).join('/')}` : p
}

export function urlOf(server: Server): string {
  return `http://localhost:${server.port}`
}
