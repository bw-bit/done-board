// 作業BGMのテンポ段階と、連続達成のご褒美の決め方（$ を使わない純粋な関数だけ）

export type Tier = 'calm' | 'groove' | 'drive' | 'sprint'

export const TIERS: Record<Tier, { asset: string; label: string; rank: number }> = {
  calm: { asset: 'sounds/bgm-calm.m4a', label: 'ウォームアップ ×0.92', rank: 0 },
  groove: { asset: 'sounds/bgm-groove.m4a', label: 'グルーヴ ×1.0', rank: 1 },
  drive: { asset: 'sounds/bgm-drive.m4a', label: 'ドライブ ×1.1', rank: 2 },
  sprint: { asset: 'sounds/bgm-sprint.m4a', label: 'ラストスパート ×1.22', rank: 3 },
}

// 進み具合でテンポを上げる: 序盤はゆったり、残り1件で全力
export function tierFor(done: number, total: number): Tier {
  if (total <= 0) return 'calm'
  const rest = total - done
  if (rest <= 1 && total >= 2) return 'sprint'
  const ratio = done / total
  if (ratio < 1 / 3) return 'calm'
  if (ratio < 2 / 3) return 'groove'
  return 'drive'
}

export function isFaster(next: Tier, cur: Tier | undefined): boolean {
  return cur !== undefined && TIERS[next].rank > TIERS[cur].rank
}

// 連続で終えるほど高い音になるコンボ音（5段階で頭打ち）
export function comboAsset(streak: number): string {
  return `sounds/combo${Math.min(Math.max(streak, 1), 5)}.wav`
}

export function streakLabel(streak: number): string {
  return streak >= 2 ? ` ・ 🔥${streak}連続` : ''
}
