import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'

const RESET = '2099-01-05T09:00:00Z'
const LIMITS = 'mcp__fuel-gauge__limits'
const PT = { language: 'pt' }

function usage(fiveHour: number, week: number): SessionUsage {
  return {
    startedAt: 0,
    context: { window: 200000, tokens: 62000, percent: 31 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: fiveHour, resetsAt: RESET },
      { kind: 'seven_day', percentUsed: week, resetsAt: RESET },
    ],
    cost: { usd: 1.2 },
  }
}

type Seen = { context?: readonly string[]; bash: number }

function world(on: On, u: SessionUsage, seen: Seen) {
  const clk = mock.clock(on, { now: Date.UTC(2026, 9, 14, 13, 0, 0) })
  const box = { u }
  on('session.usage', () => ({ value: box.u }))
  on('ui.render', () => null as never)
  on('prompt.submit', ($, e) => {
    seen.context = e.context
    return { text: e.text, context: e.context ?? [] }
  })
  on('tool.call', { tool: 'Bash' }, () => {
    seen.bash += 1
    return { result: { stdout: 'ok', stderr: '', interrupted: false } } as never
  })
  return { clk, box }
}

const submit = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as const

test('below the stop every message carries the line (en)', async ($, on) => {
  const seen: Seen = { bash: 0 }
  world(on, usage(42, 18.5), seen)
  await $.tool.call({ tool: LIMITS } as never)
  const r = await $.prompt.submit(submit('draft the proposal'))
  expect(r.drop).toBeUndefined()
  const line = (seen.context ?? []).join('\n')
  expect(line).toContain('[Fuel gauge')
  expect(line).toContain('5h 42%')
  expect(line).toContain('Week 18.5%')
  expect(line).toContain('context 31%')
  const b = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(b.deny).toBeUndefined()
  expect(seen.bash).toBe(1)
})

test('linha em português com vírgula decimal (pt)', { options: PT }, async ($, on) => {
  const seen: Seen = { bash: 0 }
  world(on, usage(42, 18.5), seen)
  await $.tool.call({ tool: LIMITS } as never)
  await $.prompt.submit(submit('prepara a proposta'))
  const line = (seen.context ?? []).join('\n')
  expect(line).toContain('[Medidor de limites')
  expect(line).toContain('Semana 18,5%')
})

test('contextLine off sends nothing extra', { options: { contextLine: false } }, async ($, on) => {
  const seen: Seen = { bash: 0 }
  world(on, usage(42, 18.5), seen)
  await $.tool.call({ tool: LIMITS } as never)
  await $.prompt.submit(submit('hello'))
  expect((seen.context ?? []).length).toBe(0)
})

test('past 95% requests and tools are refused', async ($, on) => {
  const seen: Seen = { bash: 0 }
  world(on, usage(96, 40), seen)
  const t = await $.tool.call({ tool: LIMITS } as never)
  expect(JSON.stringify(t)).toContain('LOCKED')
  const r = await $.prompt.submit(submit('one more thing'))
  expect(r.drop).toContain('5h at 96%')
  const b = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(b.deny).toContain('Stopped by Fuel Gauge')
  expect(seen.bash).toBe(0)
})

test('a custom stop at 80% applies', { options: { lockAt: 80 } }, async ($, on) => {
  const seen: Seen = { bash: 0 }
  world(on, usage(85, 10), seen)
  await $.tool.call({ tool: LIMITS } as never)
  const r = await $.prompt.submit(submit('go'))
  expect(r.drop).toContain('5h at 85%')
})

test('"continuar" desbloqueia só esse pedido', { options: PT }, async ($, on) => {
  const seen: Seen = { bash: 0 }
  world(on, usage(97, 40), seen)
  await $.tool.call({ tool: LIMITS } as never)
  const r = await $.prompt.submit(submit('continuar com o deck'))
  expect(r.drop).toBeUndefined()
  expect((seen.context ?? []).join('\n')).toContain('autorizou explicitamente')
  const b = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(b.deny).toBeUndefined()
})

test('the bar draws on terminal and desktop and unlocks', async ($, on) => {
  const seen: Seen = { bash: 0 }
  world(on, usage(42, 96), seen)
  await $.tool.call({ tool: LIMITS } as never)
  const PROPS = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5 }, view: {} } as never
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'fuel-gauge', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ text: /42%/ })).toBeDefined()
    expect(await ui.find({ text: /Locked/ })).toBeDefined()
    expect(await ui.find({ key: 'unlock' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'fuel-gauge', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  await ui.press({ key: 'unlock' })
  expect(await ui.find({ key: 'unlock' })).toBeUndefined()
  await ui.unmount()
})

test('a response without window figures keeps the last reading and flags its age', { options: PT }, async ($, on) => {
  const seen: Seen = { bash: 0 }
  const { clk, box } = world(on, usage(42, 58), seen)
  await $.tool.call({ tool: LIMITS } as never)
  box.u = { ...usage(0, 0), rateLimits: [] }
  await clk.advance(3 * 3600_000)
  await $.tool.call({ tool: LIMITS } as never)
  await $.prompt.submit(submit('olá'))
  const line = (seen.context ?? []).join('\n')
  expect(line).toContain('5h 42%')
  expect(line).toContain('Semana 58%')
  expect(line).toContain('leitura de há 3h00')
})
