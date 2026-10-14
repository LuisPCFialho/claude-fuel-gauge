export type FuelWindow = { kind: string; percentUsed: number; resetsAt?: string }

export type FuelReading = {
  windows: FuelWindow[]
  ctxPercent?: number
  ctxTokens?: number
  ctxWindow: number
  costUsd?: number
  readAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'fuel-gauge': {
      reading: FuelReading | null
      inTurn: boolean
      unlocked: boolean
      warned: Record<string, number>
      gaugeVersion: number
    }
  }
}
