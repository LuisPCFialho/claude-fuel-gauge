// Fuel Gauge - gives Claude awareness of its own usage limits (5-hour window,
// weekly window, context), shows them next to the prompt and hard-stops at a
// threshold until the user explicitly says "continue".
//
// Zero extra API calls: every figure comes from the responses the session is
// already getting. The only token cost is the optional one-line note per
// message (contextLine, about 50 tokens).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, SessionRateLimit, SessionUsage } from 'claude-code'

import type { FuelHistory, FuelReading, FuelWindow } from '../types'

// --- Config ------------------------------------------------------------------

type Lang = 'en' | 'pt'

type Config = {
  lang: Lang
  lockAt: number
  warnAt: number[]
  contextLine: boolean
  gaugeUrl: string
  trayFile: string
}

function readConfig(o: PluginOptions): Config {
  const lockAt = Number(o.lockAt)
  const warnAt = String(o.warnAt ?? '80,90')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0 && n < 100)
  return {
    lang: o.language === 'pt' ? 'pt' : 'en',
    lockAt: Number.isFinite(lockAt) && lockAt > 0 && lockAt <= 100 ? lockAt : 95,
    warnAt: warnAt.length > 0 ? warnAt.sort((a, b) => a - b) : [80, 90],
    contextLine: o.contextLine !== false,
    gaugeUrl: typeof o.gaugeArtifactUrl === 'string' ? o.gaugeArtifactUrl.trim() : '',
    trayFile: typeof o.trayFile === 'string' ? o.trayFile.trim() : '',
  }
}

const PANE = 'fuel-gauge'
const TOOL = 'limits'
const TOOL_FULL = 'mcp__fuel-gauge__limits'
// Prompts that start a turn without the user typing them; never blocked.
const FREE_ORIGINS = new Set(['task-notification', 'auto-continuation', 'observer', 'observer-activity', 'coordinator'])
// Explicit go-ahead: the message starts with one of these.
const GO_AHEAD = /^\s*(continue|go on|keep going|continuar|continua|podes continuar|prossegue|prosseguir)(\s|[.,:;!-]|$)/i

const reading = atom({ plugin: 'fuel-gauge', key: 'reading' } as const, null)
const inTurn = atom({ plugin: 'fuel-gauge', key: 'inTurn' } as const, false)
const unlocked = atom({ plugin: 'fuel-gauge', key: 'unlocked' } as const, false)
const warned = atom({ plugin: 'fuel-gauge', key: 'warned' } as const, {})
const gaugeVersion = atom({ plugin: 'fuel-gauge', key: 'gaugeVersion' } as const, 0)
const samples = atom({ plugin: 'fuel-gauge', key: 'samples' } as const, {})
const turnStart = atom({ plugin: 'fuel-gauge', key: 'turnStart' } as const, null)
const lastCost = atom({ plugin: 'fuel-gauge', key: 'lastCost' } as const, null)

// --- Words -------------------------------------------------------------------

const WORDS = {
  en: {
    days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    names: { five_hour: '5h', seven_day: 'Week', seven_day_opus: 'Week Opus', seven_day_sonnet: 'Week Sonnet', spend_limit: 'Spend' } as Record<string, string>,
    tomorrow: 'tomorrow',
    reset: 'already reset',
    resets: 'resets',
    inWord: 'in',
    prefix: 'Fuel gauge',
    noReading: 'account limits: no reading yet',
    context: (p: number, w: string) => `context ${p}% of ${w}`,
    hardStop: (n: number) => `hard stop at ${n}%`,
    old: (a: string) => `reading from ${a} ago; usage elsewhere since then is not counted yet`,
    pace: (r: string) => `pace ${r}%/h`,
    hitsAt: (n: number, at: string) => `${n}% at ${at}`,
    safe: (n: number) => `won't reach ${n}% before the reset`,
    perDay: (x: string) => `~${x}%/day until then`,
    lastCost: (x: string) => `last request: ${x}`,
    lastTiny: 'last request: under 1%',
    lastLabel: 'Last request',
    drop: (why: string) => `Stopped by Fuel Gauge: ${why}. To go on anyway, start your message with "continue" or press "Unlock 1 request".`,
    deny: (why: string) => `Stopped by Fuel Gauge (${why}). Take no more actions: finish now with a short summary of what is done and what is left, and tell the user you will only go on if they write "continue".`,
    allowed: (n: number) => `[Fuel gauge] The user explicitly allowed going past ${n}% for this request only.`,
    warnRow: (why: string) => `[Fuel gauge] Heads-up: ${why}. Keep it in mind for the rest of the task.`,
    lockRow: (why: string) => `[Fuel gauge] LIMIT REACHED: ${why}. Tools are now blocked. Stop here: give a short summary of what is done and what is left, and say you will only go on if the user writes "continue".`,
    stateLocked: 'State: LOCKED (goes on only with the user\'s explicit go-ahead).',
    stateUnlocked: 'State: unlocked by the user for this request.',
    tokens: (t: number, w: number) => `Context: ${t} of ${w} tokens.`,
    locked: 'Locked',
    waiting: 'Fuel Gauge: waiting for the first reading',
    ctx: 'Context',
    unlock: 'Unlock 1 request',
    details: 'Details',
    paneTitle: 'Usage limits',
    paneEmpty: 'No account limits yet. They arrive with Claude\'s next response.',
    lastRead: 'Last reading',
    cost: 'Equivalent cost of this session',
    rules: (n: number, w: string) => `Hard stop at ${n}% of any window. Warnings at ${w}. To go past the limit, start your message with "continue".`,
    unlockedNext: 'Unlocked for the next request.',
    cmd: 'Show usage limits (5-hour window, week, context) in a panel',
    tool: (n: number) =>
      `Reads this account's usage limits (5-hour window, weekly window and any other the account reports), when each resets, and how full the context is. Each user message already carries a "[Fuel gauge]" line with these values; call this to re-read them during a long task (cheap). Rules: (1) use the numbers to pace the work without the user having to tell you; before heavy work (subagents, workflows, many files), if the margin to ${n}% looks short, say so up front. (2) Hard stop at ${n}% of any window: tools and new requests are refused; when that happens, stop at once, give a short summary of what is done and what is left, and only go on if the user explicitly tells you to at that moment (a message starting with "continue"). (3) Do not mention the numbers unless they matter or the user asks.`,
  },
  pt: {
    days: ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'],
    names: { five_hour: '5h', seven_day: 'Semana', seven_day_opus: 'Semana Opus', seven_day_sonnet: 'Semana Sonnet', spend_limit: 'Gasto' } as Record<string, string>,
    tomorrow: 'amanhã',
    reset: 'já reposto',
    resets: 'reset',
    inWord: 'daqui a',
    prefix: 'Medidor de limites',
    noReading: 'limites da conta: ainda sem leitura',
    context: (p: number, w: string) => `contexto ${p}% de ${w}`,
    hardStop: (n: number) => `bloqueio rígido aos ${n}%`,
    old: (a: string) => `leitura de há ${a}; uso noutros sítios desde então ainda não está contado`,
    pace: (r: string) => `ritmo ${r}%/h`,
    hitsAt: (n: number, at: string) => `${n}% às ${at}`,
    safe: (n: number) => `não chega aos ${n}% antes do reset`,
    perDay: (x: string) => `~${x}%/dia até lá`,
    lastCost: (x: string) => `último pedido: ${x}`,
    lastTiny: 'último pedido: menos de 1%',
    lastLabel: 'Último pedido',
    drop: (why: string) => `Bloqueado pelo Fuel Gauge: ${why}. Para continuar mesmo assim, começa a mensagem com "continuar" ou carrega em "Desbloquear 1 pedido".`,
    deny: (why: string) => `Bloqueado pelo Fuel Gauge (${why}). Não executes mais ações: termina já com um resumo curto do estado e do que falta, e diz ao utilizador que só continuas se ele escrever "continuar".`,
    allowed: (n: number) => `[Medidor de limites] O utilizador autorizou explicitamente continuar acima de ${n}% apenas para este pedido.`,
    warnRow: (why: string) => `[Medidor de limites] Aviso: ${why}. Tem isto em conta no resto da tarefa.`,
    lockRow: (why: string) => `[Medidor de limites] LIMITE ATINGIDO: ${why}. As ferramentas estão bloqueadas. Para agora: dá um resumo curto do que ficou feito e do que falta, e diz que só continuas se o utilizador escrever "continuar".`,
    stateLocked: 'Estado: BLOQUEADO (só continua com autorização explícita do utilizador).',
    stateUnlocked: 'Estado: desbloqueado pelo utilizador para este pedido.',
    tokens: (t: number, w: number) => `Contexto: ${t} de ${w} tokens.`,
    locked: 'Bloqueado',
    waiting: 'Fuel Gauge: à espera da primeira leitura',
    ctx: 'Contexto',
    unlock: 'Desbloquear 1 pedido',
    details: 'Detalhes',
    paneTitle: 'Limites de uso',
    paneEmpty: 'Ainda sem leitura dos limites da conta. Os valores chegam com a próxima resposta do Claude.',
    lastRead: 'Última leitura',
    cost: 'Custo equivalente desta sessão',
    rules: (n: number, w: string) => `Bloqueio rígido aos ${n}% de qualquer janela. Avisos aos ${w}. Para continuar acima do limite, começa a mensagem com "continuar".`,
    unlockedNext: 'Desbloqueado para o próximo pedido.',
    cmd: 'Mostra os limites de uso (janela de 5h, semana, contexto) num painel',
    tool: (n: number) =>
      `Lê os limites de uso desta conta (janela de 5 horas, semanal e outras que a conta reporte), a hora de reset de cada uma e o preenchimento do contexto. Cada mensagem do utilizador já traz uma linha "[Medidor de limites]" com estes valores; usa esta ferramenta para os reler a meio de uma tarefa longa (custa pouco). Regras: (1) usa estes números para gerir o trabalho sem o utilizador ter de te avisar; antes de uma tarefa pesada (subagentes, workflows, muitos ficheiros), se a margem até ${n}% parecer curta, diz isso logo no início. (2) Bloqueio rígido aos ${n}% de qualquer janela: o sistema recusa ferramentas e pedidos novos; quando acontecer, para de imediato, dá um resumo curto do que ficou feito e do que falta, e só continuas se o utilizador te disser explicitamente para continuar nesse momento (mensagem a começar por "continuar"). (3) Não menciones os números ao utilizador salvo se forem relevantes ou perguntados.`,
  },
} as const

type Words = (typeof WORDS)[Lang]

// --- Time --------------------------------------------------------------------
// The hooks runtime has no Intl. English uses the engine's own timezone (what
// Date reports); Portuguese applies the Lisbon rule (also right for the UK and
// Ireland), since a cloud session's clock runs in UTC.
function lisbonOffsetMin(ms: number): number {
  const y = new Date(ms).getUTCFullYear()
  const lastSunday = (month: number) => {
    const last = new Date(Date.UTC(y, month + 1, 0))
    return Date.UTC(y, month, last.getUTCDate() - last.getUTCDay(), 1, 0, 0)
  }
  return ms >= lastSunday(2) && ms < lastSunday(9) ? 60 : 0
}

function localDate(ms: number, lang: Lang): Date {
  if (lang === 'pt') return new Date(ms + lisbonOffsetMin(ms) * 60_000)
  // English: honour the runtime's own timezone, expressed as a UTC-shifted date.
  return new Date(ms - new Date(ms).getTimezoneOffset() * 60_000)
}

const pad = (n: number) => String(n).padStart(2, '0')

function clock(ms: number, lang: Lang): string {
  const d = localDate(ms, lang)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

function sameDay(a: number, b: number, lang: Lang): boolean {
  const x = localDate(a, lang)
  const y = localDate(b, lang)
  return x.getUTCFullYear() === y.getUTCFullYear() && x.getUTCMonth() === y.getUTCMonth() && x.getUTCDate() === y.getUTCDate()
}

function span(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000))
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h${pad(min % 60)}`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function when(iso: string | undefined, now: number, c: Config, w: Words): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  if (t <= now) return w.reset
  if (sameDay(t, now, c.lang)) return clock(t, c.lang)
  if (t - now < 36 * 3600_000) return `${w.tomorrow} ${clock(t, c.lang)}`
  return `${w.days[localDate(t, c.lang).getUTCDay()]} ${clock(t, c.lang)}`
}

function whenLong(iso: string | undefined, now: number, c: Config, w: Words): string {
  const q = when(iso, now, c, w)
  if (!q || q === w.reset || !iso) return q
  return `${q}, ${w.inWord} ${span(Date.parse(iso) - now)}`
}

// --- Readings ----------------------------------------------------------------

const label = (kind: string, w: Words) => w.names[kind] ?? kind.replace(/_/g, ' ')

const pct = (n: number, c: Config) => {
  const s = Number.isInteger(n) ? String(n) : n.toFixed(1)
  return c.lang === 'pt' ? s.replace('.', ',') : s
}

function toReading(u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>, now: number): FuelReading {
  const r: FuelReading = {
    windows: u.rateLimits.map((x: SessionRateLimit) => {
      const f: FuelWindow = { kind: x.kind, percentUsed: x.percentUsed }
      if (x.resetsAt) f.resetsAt = x.resetsAt
      return f
    }),
    ctxWindow: u.context.window,
    readAt: now,
  }
  if (u.context.percent !== undefined) r.ctxPercent = u.context.percent
  if (u.context.tokens !== undefined) r.ctxTokens = u.context.tokens
  if (u.cost) r.costUsd = u.cost.usd
  return r
}

// A window whose reset time has passed counts as 0% until the next reading.
function effective(f: FuelWindow, now: number): number {
  if (f.resetsAt) {
    const t = Date.parse(f.resetsAt)
    if (!Number.isNaN(t) && t <= now) return 0
  }
  return f.percentUsed
}

function worst(r: FuelReading | null, now: number): { win: FuelWindow; value: number } | null {
  let top: { win: FuelWindow; value: number } | null = null
  for (const win of r?.windows ?? []) {
    const value = effective(win, now)
    if (!top || value > top.value) top = { win, value }
  }
  return top
}

async function snapshot($: EngineInterface, c: Config) {
  const now = await $.clock.now()
  const r = await read($, reading)
  const top = worst(r, now)
  const free = await read($, unlocked)
  return { now, r, top, free, locked: !free && top !== null && top.value >= c.lockAt }
}

// --- Pace, budget and per-request cost ---------------------------------------

// %/h over the last hour of samples of this window (at least 10 minutes).
function pace(h: FuelHistory | undefined, f: FuelWindow, now: number): number | null {
  const pts = h?.[f.kind]?.points ?? []
  const recent = pts.filter(x => now - x.t <= 3600_000)
  const first = recent[0] ?? pts[pts.length - 1]
  if (!first) return null
  const hours = (now - first.t) / 3600_000
  if (hours < 1 / 6) return null
  const dp = f.percentUsed - first.p
  return dp < 0 ? null : dp / hours
}

// The short-window outlook (pace and when it would hit the stop) or, for
// weekly windows, the daily budget left until the reset.
function outlook(h: FuelHistory | undefined, f: FuelWindow, now: number, c: Config, w: Words): string {
  const v = effective(f, now)
  if (f.kind.startsWith('seven_day')) {
    if (!f.resetsAt) return ''
    const days = (Date.parse(f.resetsAt) - now) / 86_400_000
    const left = c.lockAt - v
    if (days < 0.5 || left <= 0) return ''
    return w.perDay(pct(Math.max(0, Math.round(left / days)), c))
  }
  const r = pace(h, f, now)
  if (r === null) return ''
  const rate = w.pace(pct(Math.round(r * 10) / 10, c))
  const reset = f.resetsAt ? Date.parse(f.resetsAt) : Number.POSITIVE_INFINITY
  if (r <= 0) return `${rate}, ${w.safe(c.lockAt)}`
  const eta = now + ((c.lockAt - v) / r) * 3600_000
  return eta >= reset ? `${rate}, ${w.safe(c.lockAt)}` : `${rate}, ${w.hitsAt(c.lockAt, when(new Date(eta).toISOString(), now, c, w))}`
}

function costText(cost: Record<string, number> | null, c: Config, w: Words): string {
  if (!cost) return ''
  const parts = Object.entries(cost)
    .filter(([, d]) => d >= 0.5)
    .map(([k, d]) => `${label(k, w)} +${pct(Math.round(d * 10) / 10, c)}%`)
  return parts.length > 0 ? w.lastCost(parts.join(', ')) : w.lastTiny
}

async function record($: EngineInterface, windows: FuelWindow[], now: number): Promise<void> {
  await update($, samples, h => {
    const out: FuelHistory = {}
    for (const f of windows) {
      const prev = h?.[f.kind]
      const same = prev !== undefined && prev.resetsAt === (f.resetsAt ?? null)
      let pts = same ? prev.points.filter(x => now - x.t <= 3 * 3600_000) : []
      const last = pts[pts.length - 1]
      if (!last || last.p !== f.percentUsed || now - last.t >= 5 * 60_000) pts = [...pts, { t: now, p: f.percentUsed }]
      out[f.kind] = { resetsAt: f.resetsAt ?? null, points: pts.slice(-60) }
    }
    return out
  })
}

const kTokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

function modelLine(r: FuelReading | null, now: number, c: Config, w: Words, h?: FuelHistory, cost?: Record<string, number> | null): string {
  const parts: string[] = []
  for (const f of r?.windows ?? []) {
    const q = whenLong(f.resetsAt, now, c, w)
    const o = outlook(h, f, now, c, w)
    const extra = [q ? `${w.resets} ${q}` : '', o].filter(Boolean).join('; ')
    parts.push(`${label(f.kind, w)} ${pct(effective(f, now), c)}%${extra ? ` (${extra})` : ''}`)
  }
  const ct = costText(cost ?? null, c, w)
  if (ct) parts.push(ct)
  if (parts.length === 0) parts.push(w.noReading)
  if (r?.ctxPercent !== undefined) parts.push(w.context(r.ctxPercent, kTokens(r.ctxWindow)))
  if (r && r.windows.length > 0 && now - r.readAt > 15 * 60_000) parts.push(w.old(span(now - r.readAt)))
  return `[${w.prefix}, ${clock(now, c.lang)}] ${parts.join(' | ')} | ${w.hardStop(c.lockAt)}`
}

function why(top: { win: FuelWindow; value: number }, now: number, c: Config, w: Words): string {
  const q = whenLong(top.win.resetsAt, now, c, w)
  return `${label(top.win.kind, w)} ${c.lang === 'pt' ? 'a' : 'at'} ${pct(top.value, c)}%${q ? ` (${w.resets} ${q})` : ''}`
}

async function refresh($: EngineInterface, u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>) {
  const now = await $.clock.now()
  const fresh = toReading(u, now)
  const prev = await read($, reading)
  // No window figures in this response (e.g. a new chat before its first
  // reply): keep the last known windows and their time, update the rest.
  const next: FuelReading =
    fresh.windows.length === 0 && prev && prev.windows.length > 0
      ? { ...fresh, windows: prev.windows, readAt: prev.readAt }
      : fresh
  await update($, reading, () => next)
  if (fresh.windows.length > 0) {
    await record($, fresh.windows, now)
    try {
      await $.store.set('lastReading', { windows: fresh.windows, readAt: now })
    } catch {
      // no store on this host
    }
  }
  return { now, next }
}

// Last known windows from an earlier session: this machine's store, or the
// Cowork gauge artifact (which outlives cloud containers). Newest wins.
async function seed($: EngineInterface, c: Config): Promise<void> {
  const cur = await read($, reading)
  if (cur && cur.windows.length > 0) return
  const found: { windows: FuelWindow[]; readAt: number }[] = []
  try {
    const s = (await $.store.get('lastReading')) as { windows?: FuelWindow[]; readAt?: number } | undefined
    if (s && Array.isArray(s.windows) && typeof s.readAt === 'number') found.push({ windows: s.windows, readAt: s.readAt })
  } catch {
    // no store
  }
  if (c.gaugeUrl) {
    try {
      const res = (await $.tool.call({ tool: 'ArtifactData', action: 'get', url: c.gaugeUrl, collection: 'data/users/me', doc_id: 'gauge' } as never)) as { text?: string }
      const line = (res.text ?? '').split('\n').find(l => l.startsWith('{"id":"gauge"'))
      const doc = line ? (JSON.parse(line) as { data?: { updatedAt?: number; windows?: { kind: string; percent: number; resetsAt?: string | null }[] } }) : null
      const d = doc?.data
      if (d && Array.isArray(d.windows) && typeof d.updatedAt === 'number') {
        found.push({
          readAt: d.updatedAt,
          windows: d.windows.map(x => {
            const f: FuelWindow = { kind: x.kind, percentUsed: Number(x.percent) }
            if (x.resetsAt) f.resetsAt = x.resetsAt
            return f
          }),
        })
      }
    } catch {
      // no artifact access on this host
    }
  }
  const best = found.sort((a, b) => b.readAt - a.readAt)[0]
  if (!best) return
  const base: FuelReading = cur ?? { windows: [], ctxWindow: 0, readAt: best.readAt }
  await update($, reading, () => ({ ...base, windows: best.windows, readAt: best.readAt }))
}

// --- Outputs for surfaces that cannot draw the bar ----------------------------

async function payload($: EngineInterface, c: Config, w: Words) {
  const s = await snapshot($, c)
  if (!s.r) return null
  const h = await read($, samples)
  return {
    lang: c.lang,
    account: (await $.env.get('CLAUDE_CODE_USER_EMAIL')) ?? null,
    updatedAt: s.now,
    lockAt: c.lockAt,
    locked: s.locked,
    gaugeUrl: c.gaugeUrl || null,
    windows: s.r.windows.map(f => ({ kind: f.kind, label: label(f.kind, w), percent: f.percentUsed, resetsAt: f.resetsAt ?? null, note: outlook(h, f, s.now, c, w) || null })),
    context: { percent: s.r.ctxPercent ?? null, tokens: s.r.ctxTokens ?? null, window: s.r.ctxWindow },
    lastCost: costText(await read($, lastCost), c, w) || null,
  }
}

const versionOf = (x: unknown): number | null => {
  const m = /version[\\"]*:?\s*(\d+)/.exec(JSON.stringify(x ?? ''))
  return m ? Number(m[1]) : null
}

// Live gauge artifact (Cowork): one small database write, no model tokens.
async function pushGauge($: EngineInterface, c: Config, w: Words): Promise<void> {
  if (!c.gaugeUrl) return
  const data = await payload($, c, w)
  if (!data) return
  const base = { tool: 'ArtifactData', url: c.gaugeUrl, collection: 'data/users/me', doc_id: 'gauge' }
  const write = (v: number) => $.tool.call({ ...base, action: 'set', data, ...(v > 0 ? { if_version: v } : {}) } as never)
  let res: unknown = await write(await read($, gaugeVersion))
  let v = versionOf(res)
  if (v === null || /refused|failed|not found|conflict/i.test(JSON.stringify(res))) {
    res = await write(versionOf(await $.tool.call({ ...base, action: 'get' } as never)) ?? 0)
    v = versionOf(res)
  }
  if (v !== null) await update($, gaugeVersion, () => v as number)
}

// Windows taskbar icon: a small JSON file. Written locally, or through the
// Windows-MCP connector when the session runs in the cloud (Cowork).
async function pushTray($: EngineInterface, c: Config, w: Words): Promise<void> {
  if (!c.trayFile) return
  const data = await payload($, c, w)
  if (!data) return
  const text = JSON.stringify(data)
  if (await $.env.get('CLAUDE_CODE_REMOTE')) {
    await $.tool.call({ tool: 'mcp__remote-devices__Windows-MCP__FileSystem', mode: 'write', path: c.trayFile, content: text, overwrite: true } as never)
  } else {
    await $.fs.write(c.trayFile, text)
  }
}

async function pushAll($: EngineInterface, c: Config, w: Words): Promise<string[]> {
  const errors: string[] = []
  try {
    await pushGauge($, c, w)
  } catch (err) {
    errors.push(`gauge: ${String(err).slice(0, 160)}`)
  }
  try {
    await pushTray($, c, w)
  } catch (err) {
    errors.push(`tray: ${String(err).slice(0, 160)}`)
  }
  return errors
}

// --- Drawing -----------------------------------------------------------------

const C_OK = '#5B8DEF'
const C_WARN = '#E0A100'
const C_CRIT = '#E5484D'
const colorFor = (v: number, c: Config) => (v >= Math.min(90, c.lockAt) ? C_CRIT : v >= 75 ? C_WARN : C_OK)
const themeFor = (v: number, c: Config) => (v >= Math.min(90, c.lockAt) ? 'error' : v >= 75 ? 'warning' : 'text')

function barSvg(v: number, width: number, height: number, c: Config): string {
  const fill = (Math.max(0, Math.min(100, v)) / 100) * width
  const r = height / 2
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" rx="${r}" fill="rgba(128,128,128,0.25)"/>` +
    (fill > 0 ? `<rect width="${Math.max(fill, height).toFixed(1)}" height="${height}" rx="${r}" fill="${colorFor(v, c)}"/>` : '') +
    `</svg>`
  )
}

function barText(v: number, n: number): string {
  const full = Math.round((Math.max(0, Math.min(100, v)) / 100) * n)
  return '▰'.repeat(full) + '▱'.repeat(n - full)
}

// --- Hooks -------------------------------------------------------------------

export const register: Register = (on, options) => {
  const c = readConfig(options)
  const w: Words = WORDS[c.lang]
  const warnText = c.warnAt.map(n => `${n}%`).join(c.lang === 'pt' ? ' e ' : ' and ')
  const levels = [...c.warnAt.filter(n => n < c.lockAt), c.lockAt]

  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: TOOL, description: w.tool(c.lockAt), inputSchema: { type: 'object', properties: {} }, isDeferred: false })
    await $.command.register({ name: 'fuel', description: w.cmd })
    try {
      await refresh($, await $.session.usage())
    } catch {
      // no reading yet: the first API response brings the values
    }
    await seed($, c)
    return next(e)
  })

  // Figures pushed by the engine after each turn and whenever a window moves.
  on('session.measure', async ($, e, next) => {
    const { now, next: fresh } = await refresh($, e)
    const done = await read($, warned)
    const free = await read($, unlocked)
    const running = await read($, inTurn)
    const after: Record<string, number> = { ...done }
    for (const f of fresh.windows) {
      const v = effective(f, now)
      if (v < levels[0]!) {
        delete after[f.kind]
        continue
      }
      const level = [...levels].reverse().find(t => v >= t) ?? 0
      if (level <= (done[f.kind] ?? 0)) continue
      after[f.kind] = level
      const text = why({ win: f, value: v }, now, c, w)
      $.ui.toast(`Fuel Gauge: ${text}`)
      if (!running) continue
      try {
        const row = level >= c.lockAt && !free ? w.lockRow(text) : w.warnRow(text)
        await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: row }] } })
      } catch {
        // no running turn to join: the next message's line covers it
      }
    }
    await update($, warned, () => after)
    await pushAll($, c, w)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      await update($, inTurn, () => true)
      try {
        const r = await read($, reading)
        const start = Object.fromEntries((r?.windows ?? []).map(f => [f.kind, f.percentUsed]))
        await update($, turnStart, () => (Object.keys(start).length > 0 ? start : null))
      } catch {
        // no reading yet
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      await update($, inTurn, () => false)
      // A go-ahead covers only the request it was given for.
      await update($, unlocked, () => false)
      // What this request cost, from the figures of its last response.
      try {
        const start = await read($, turnStart)
        const u = await $.session.usage()
        if (start && u.rateLimits.length > 0) {
          const cost: Record<string, number> = {}
          for (const x of u.rateLimits) if (x.kind in start) cost[x.kind] = Math.max(0, x.percentUsed - (start[x.kind] ?? x.percentUsed))
          await update($, lastCost, () => cost)
        }
        await update($, turnStart, () => null)
      } catch {
        // keep the previous cost
      }
    }
    return next(e)
  })

  // Each message carries the line; past the stop only an explicit go-ahead passes.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || FREE_ORIGINS.has(e.origin?.kind ?? '')) return next(e)
    const goAhead = GO_AHEAD.test(e.text)
    if (goAhead) await update($, unlocked, () => true)
    const s = await snapshot($, c)
    if (s.locked && s.top) return { drop: w.drop(why(s.top, s.now, c, w)) }
    const extra: string[] = []
    if (c.contextLine) extra.push(modelLine(s.r, s.now, c, w, await read($, samples), await read($, lastCost)))
    if (goAhead && s.top && s.top.value >= c.lockAt) extra.push(w.allowed(c.lockAt))
    if (extra.length === 0) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...extra] })
  }).catch(($, e, next) => next(e))

  // Hard stop for tools (subagents included) past the threshold.
  on('tool.call', async ($, e, next) => {
    if (String(e.tool) === TOOL_FULL) return next(e)
    const s = await snapshot($, c)
    if (s.locked && s.top) return { deny: w.deny(why(s.top, s.now, c, w)) }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: TOOL_FULL }, async $ => {
    try {
      await refresh($, await $.session.usage())
    } catch {
      // keep the last reading
    }
    const errors = await pushAll($, c, w)
    const s = await snapshot($, c)
    const lines = [modelLine(s.r, s.now, c, w, await read($, samples), await read($, lastCost))]
    if (s.r?.ctxTokens !== undefined) lines.push(w.tokens(s.r.ctxTokens, s.r.ctxWindow))
    if (s.locked) lines.push(w.stateLocked)
    else if (s.free) lines.push(w.stateUnlocked)
    if (errors.length > 0) lines.push(`(${errors.join('; ')})`)
    return { result: lines.join('\n') }
  })

  on('command.run', { command: 'fuel' }, async $ => {
    await $.ui.open({ id: PANE, title: w.paneTitle })
    const s = await snapshot($, c)
    return { text: modelLine(s.r, s.now, c, w, await read($, samples), await read($, lastCost)) }
  })

  // --- The bar next to the prompt (terminal and desktop) ---------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const s = await snapshot($, c)
    const R = $.ui.resolve(e)
    const { Box, Text, Button } = R
    const Svg = 'Svg' in R && e.surface !== 'terminal' ? R.Svg : undefined

    const gauges = (s.r?.windows ?? []).map(f => {
      const v = effective(f, s.now)
      const q = when(f.resetsAt, s.now, c, w)
      return (
        <Box key={`w-${f.kind}`} flexDirection="row" alignItems="center" gap={1}>
          <Text size="caption" weight="medium">{label(f.kind, w)}</Text>
          {Svg ? (
            <Svg source={barSvg(v, 52, 6, c)} alt={`${label(f.kind, w)} ${pct(v, c)}%`} width={52} height={6} />
          ) : (
            <Text color={themeFor(v, c)}>{barText(v, 8)}</Text>
          )}
          <Text size="caption" tabular color={themeFor(v, c)} weight="semibold">{pct(v, c)}%</Text>
          {q ? <Text size="caption" dimColor>{q}</Text> : null}
        </Box>
      )
    })

    return (
      <Box flexDirection="row" alignItems="center" flexWrap="wrap" columnGap={3}>
        {s.locked ? <Text size="caption" weight="bold" color="error">{w.locked}</Text> : null}
        {gauges.length > 0 ? gauges : <Text size="caption" dimColor>{w.waiting}</Text>}
        {s.r?.ctxPercent !== undefined ? (
          <Box key="ctx" flexDirection="row" gap={1}>
            <Text size="caption" weight="medium">{w.ctx}</Text>
            <Text size="caption" tabular dimColor>{s.r.ctxPercent}%</Text>
          </Box>
        ) : null}
        {s.locked ? <Button key="unlock" variant="primary" label={w.unlock} onPress={() => update($, unlocked, () => true)} /> : null}
        <Button key="details" plain label={w.details} onPress={() => $.ui.open({ id: PANE, title: w.paneTitle })} />
      </Box>
    )
  })

  // --- Detail panel -----------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = await snapshot($, c)
    const h = await read($, samples)
    const cost = costText(await read($, lastCost), c, w)
    const R = $.ui.resolve(e)
    const { Box, Text, Button } = R
    const Svg = 'Svg' in R && e.surface !== 'terminal' ? R.Svg : undefined

    return (
      <Box flexDirection="column" gap={1} padding={1}>
        <Text size="heading" weight="semibold">{w.paneTitle}</Text>
        {(s.r?.windows ?? []).length === 0 ? <Text dimColor>{w.paneEmpty}</Text> : null}
        {(s.r?.windows ?? []).map(f => {
          const v = effective(f, s.now)
          const q = whenLong(f.resetsAt, s.now, c, w)
          return (
            <Box key={`p-${f.kind}`} flexDirection="column" gap={0}>
              <Box flexDirection="row" justifyContent="space-between">
                <Text weight="medium">{label(f.kind, w)}</Text>
                <Text tabular weight="semibold" color={themeFor(v, c)}>{pct(v, c)}%</Text>
              </Box>
              {Svg ? (
                <Svg source={barSvg(v, 240, 8, c)} alt={`${label(f.kind, w)} ${pct(v, c)}%`} width={240} height={8} />
              ) : (
                <Text color={themeFor(v, c)}>{barText(v, 24)}</Text>
              )}
              {q ? <Text size="caption" dimColor>{w.resets} {q}</Text> : null}
              {outlook(h, f, s.now, c, w) ? <Text size="caption" dimColor>{outlook(h, f, s.now, c, w)}</Text> : null}
            </Box>
          )
        })}
        {s.r ? (
          <Box flexDirection="column">
            <Text size="caption">
              {w.ctx}: {s.r.ctxPercent !== undefined ? `${s.r.ctxPercent}%` : 'n/a'}
              {s.r.ctxTokens !== undefined ? ` (${kTokens(s.r.ctxTokens)} / ${kTokens(s.r.ctxWindow)})` : ''}
            </Text>
            {s.r.costUsd !== undefined ? (
              <Text size="caption" dimColor>{w.cost}: {pct(Number(s.r.costUsd.toFixed(2)), c)} USD</Text>
            ) : null}
            {cost ? <Text size="caption">{cost}</Text> : null}
            <Text size="caption" dimColor>{w.lastRead}: {clock(s.r.readAt, c.lang)}</Text>
          </Box>
        ) : null}
        <Text size="caption" dimColor>{w.rules(c.lockAt, warnText)}</Text>
        {s.locked ? (
          <Button key="p-unlock" variant="primary" label={w.unlock} onPress={() => update($, unlocked, () => true)} />
        ) : s.free ? (
          <Text size="caption" color="warning">{w.unlockedNext}</Text>
        ) : null}
      </Box>
    )
  })
}
