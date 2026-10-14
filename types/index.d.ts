export type FuelWindow = { kind: string; percentUsed: number; resetsAt?: string }

export type FuelSample = { t: number; p: number }

export type FuelHistory = Record<string, { resetsAt: string | null; points: FuelSample[] }>

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
      samples: FuelHistory
      turnStart: Record<string, number> | null
      lastCost: Record<string, number> | null
    }
  }
}
