#!/usr/bin/env node
/**
 * AUDITORIA DE CONTA KOMMO (somente leitura) — node auditoria/auditoria-kommo.mjs
 *
 * Lê a conta pela API v4 (SÓ GET: nada é criado, alterado ou apagado), calcula
 * como a conta funciona hoje e grava:
 *   saida/metricas.json   números agregados (base dos relatórios)
 *   saida/resumo.md       leitura rápida dos números
 *   saida/bruto/*.json    respostas cruas da API (TEM DADO DE LEAD: fica fora do git)
 *
 * Variáveis:
 *   KOMMO_TOKEN          token de longa duração (eyJ...) · ou KOMMO_TOKEN_FILE com o caminho
 *   KOMMO_DOMAIN         opcional (https://<conta>.kommo.com). Padrão: api_domain do token
 *   DIAS                 janela de análise (padrão 90)
 *   HORARIO              horário comercial local, seg–sex (padrão "8-18")
 *   SAIDA                pasta de saída (padrão auditoria/saida)
 *   MAX_PAGINAS          teto de páginas por lista (padrão 400 × 250 = 100 mil registros)
 *   MAX_PAGINAS_EVENTOS  teto de páginas por tipo de evento (padrão 150 × 100)
 * Atrás de proxy HTTP (Node 22+): rode com NODE_USE_ENV_PROXY=1
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const env = process.env
const token = (env.KOMMO_TOKEN || (env.KOMMO_TOKEN_FILE ? fs.readFileSync(env.KOMMO_TOKEN_FILE, 'utf8') : '')).trim()
if (!token.startsWith('eyJ')) { console.error('Defina KOMMO_TOKEN (token de longa duração, começa com eyJ).'); process.exit(1) }
const jwt = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
const base = (env.KOMMO_DOMAIN || jwt.api_domain || '').replace(/\/+$/, '').replace(/^(?!https?:\/\/)/, 'https://')
if (!base) { console.error('Defina KOMMO_DOMAIN (https://<conta>.kommo.com).'); process.exit(1) }

const DIAS = Number(env.DIAS || 90)
const [H_INI, H_FIM] = (env.HORARIO || '8-18').split('-').map(Number)
const SAIDA = path.resolve(env.SAIDA || path.join(path.dirname(fileURLToPath(import.meta.url)), 'saida'))
const BRUTO = path.join(SAIDA, 'bruto')
const MAX_PAG = Number(env.MAX_PAGINAS || 400)
const MAX_PAG_EV = Number(env.MAX_PAGINAS_EVENTOS || 150)
const DIA = 86400
const AGORA = Math.floor(Date.now() / 1000)
const DESDE = AGORA - DIAS * DIA
const GANHO = 142
const PERDIDO = 143
fs.mkdirSync(BRUTO, { recursive: true })

// ───────────────────────────── coleta ─────────────────────────────

const falhas = []
const truncados = []
let ultimaChamada = 0
const espera = ms => new Promise(r => setTimeout(r, ms))

async function get(p, { opcional = false } = {}) {
  for (let tentativa = 0; ; tentativa++) {
    // ~5 req/s: o limite da Kommo é 7 req/s por conta, e a conta segue em uso
    const folga = ultimaChamada + 200 - Date.now()
    if (folga > 0) await espera(folga)
    ultimaChamada = Date.now()
    let r
    try {
      r = await fetch(`${base}/api/v4/${p}`, { headers: { Authorization: `Bearer ${token}` } })
    } catch (e) {
      if (tentativa < 4) { await espera(2000 * 2 ** tentativa); continue }
      const msg = `${p} -> rede: ${e.cause?.code || e.message}`
      if (opcional) { falhas.push(msg); return null }
      throw new Error(msg)
    }
    if (r.status === 204) return null
    if ((r.status === 429 || r.status >= 500) && tentativa < 4) { await espera(2000 * 2 ** tentativa); continue }
    if (!r.ok) {
      const msg = `${p} -> ${r.status}: ${(await r.text()).slice(0, 200)}`
      if (opcional) { falhas.push(msg); return null }
      throw new Error(msg)
    }
    return r.json()
  }
}

async function paginar(p, chave, { limite = 250, maxPag = MAX_PAG, opcional = false } = {}) {
  const itens = []
  const sep = p.includes('?') ? '&' : '?'
  for (let pag = 1; pag <= maxPag; pag++) {
    const j = await get(`${p}${sep}limit=${limite}&page=${pag}`, { opcional })
    const lote = j?._embedded?.[chave] || []
    itens.push(...lote)
    if (!j?._links?.next || lote.length === 0) return itens
    if (pag === maxPag) truncados.push(`${p} (parou em ${itens.length} registros)`)
  }
  return itens
}

const salvar = (nome, dado) => fs.writeFileSync(path.join(BRUTO, `${nome}.json`), JSON.stringify(dado, null, 2))

async function coletar() {
  const conta = await get('account?with=amojo_id,users_groups,task_types,version,datetime_settings,entity_names')
  console.log(`Conta: ${conta.name} · ${conta.subdomain}.kommo.com · id ${conta.id}`)

  const d = { conta }
  const etapa = async (nome, fn) => { process.stdout.write(`  ${nome}… `); d[nome] = await fn(); salvar(nome, d[nome]); console.log(Array.isArray(d[nome]) ? d[nome].length : 'ok') }

  await etapa('usuarios', () => paginar('users?with=role,group', 'users'))
  await etapa('funis', async () => (await get('leads/pipelines'))?._embedded?.pipelines || [])
  await etapa('motivosPerda', async () => (await get('leads/loss_reasons', { opcional: true }))?._embedded?.loss_reasons || [])
  await etapa('camposLead', () => paginar('leads/custom_fields', 'custom_fields'))
  await etapa('camposContato', () => paginar('contacts/custom_fields', 'custom_fields'))
  await etapa('camposEmpresa', () => paginar('companies/custom_fields', 'custom_fields', { opcional: true }))
  await etapa('tagsLead', () => paginar('leads/tags', 'tags'))
  await etapa('tagsContato', () => paginar('contacts/tags', 'tags', { opcional: true }))
  await etapa('fontes', async () => (await get('sources', { opcional: true }))?._embedded?.sources || [])
  await etapa('webhooks', async () => (await get('webhooks', { opcional: true }))?._embedded?.webhooks || [])
  await etapa('widgets', () => paginar('widgets', 'widgets', { opcional: true }))
  await etapa('catalogos', async () => (await get('catalogs', { opcional: true }))?._embedded?.catalogs || [])
  await etapa('templatesChat', () => paginar('chats/templates', 'chat_templates', { limite: 50, opcional: true }))
  await etapa('leads', () => paginar('leads?with=contacts,loss_reason,source_id', 'leads'))
  await etapa('contatos', () => paginar('contacts', 'contacts'))
  await etapa('empresas', () => paginar('companies', 'companies', { opcional: true }))
  await etapa('tarefasAbertas', () => paginar('tasks?filter[is_completed]=0', 'tasks'))
  await etapa('tarefasConcluidas', () => paginar(`tasks?filter[is_completed]=1&filter[updated_at][from]=${DESDE}`, 'tasks', { opcional: true }))
  await etapa('entradaResumo', () => get('leads/unsorted/summary', { opcional: true }))
  await etapa('entrada', () => paginar('leads/unsorted', 'unsorted', { opcional: true }))

  d.eventos = {}
  const tipos = ['lead_added', 'lead_status_changed', 'incoming_chat_message', 'outgoing_chat_message', 'robot_replied',
    'entity_responsible_changed', 'incoming_call', 'outgoing_call', 'lead_deleted']
  for (const t of tipos) {
    process.stdout.write(`  eventos ${t}… `)
    const antes = truncados.length
    d.eventos[t] = await paginar(`events?filter[type]=${t}&filter[created_at][from]=${DESDE}`, 'events', { limite: 100, maxPag: MAX_PAG_EV, opcional: true })
    d.eventos[`${t}__truncado`] = truncados.length > antes
    salvar(`eventos_${t}`, d.eventos[t])
    console.log(d.eventos[t].length)
  }
  return d
}

// ───────────────────────────── análise ─────────────────────────────

const quantil = (arr, q) => {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const i = (s.length - 1) * q
  const lo = Math.floor(i), hi = Math.ceil(i)
  return s[lo] + (s[hi] - s[lo]) * (i - lo)
}
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null)
const r1 = x => (x == null ? null : Math.round(x * 10) / 10)
const soma = arr => arr.reduce((t, x) => t + (Number(x) || 0), 0)
const contar = (arr, fn) => { const m = new Map(); for (const x of arr) { const k = fn(x); m.set(k, (m.get(k) || 0) + 1) } return [...m].sort((a, b) => b[1] - a[1]) }
const normalizar = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '')

function analisar(d) {
  const { conta } = d
  const tz = conta._embedded?.datetime_settings?.timezone || conta.datetime_settings?.timezone || 'America/Sao_Paulo'
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const local = ts => {
    const partes = fmt.formatToParts(new Date(ts * 1000))
    return { dow: DOW.indexOf(partes.find(p => p.type === 'weekday').value), h: Number(partes.find(p => p.type === 'hour').value) % 24 }
  }
  const foraDoHorario = ts => { const { dow, h } = local(ts); return dow === 0 || dow === 6 || h < H_INI || h >= H_FIM }

  const usuarios = new Map(d.usuarios.map(u => [u.id, u]))
  const nomeUsuario = id => (id === 0 ? 'Robô/integração' : usuarios.get(id)?.name || `#${id}`)
  const ativo = u => u?.rights?.is_active !== false
  const tiposTarefa = new Map((conta._embedded?.task_types || []).map(t => [t.id, t.name]))
  tiposTarefa.set(1, tiposTarefa.get(1) || 'Follow-up'); tiposTarefa.set(2, tiposTarefa.get(2) || 'Reunião')

  const leads = d.leads.filter(l => !l.is_deleted)
  const fechado = l => l.status_id === GANHO || l.status_id === PERDIDO
  const abertos = leads.filter(l => !fechado(l))
  const criadosJanela = leads.filter(l => l.created_at >= DESDE)
  const fechadosJanela = leads.filter(l => fechado(l) && (l.closed_at || l.updated_at) >= DESDE)
  const ganhos = fechadosJanela.filter(l => l.status_id === GANHO)
  const perdidos = fechadosJanela.filter(l => l.status_id === PERDIDO)
  const ev = d.eventos
  const statusDe = v => v?.[0]?.lead_status

  // entrada na etapa atual = último evento de mudança de etapa
  const entradaNaEtapa = new Map()
  for (const e of ev.lead_status_changed) {
    if (e.entity_type !== 'lead') continue
    if ((entradaNaEtapa.get(e.entity_id) || 0) < e.created_at) entradaNaEtapa.set(e.entity_id, e.created_at)
  }
  const diasNaEtapa = l => {
    const t = entradaNaEtapa.get(l.id) ?? (l.created_at >= DESDE ? l.created_at : null)
    return t == null ? null : (AGORA - t) / DIA
  }

  // etapas alcançadas por lead (para o funil de passagem)
  const alcancou = new Map()
  const marca = (id, st) => { if (!st) return; if (!alcancou.has(id)) alcancou.set(id, new Set()); alcancou.get(id).add(`${st.pipeline_id}:${st.id}`) }
  for (const e of ev.lead_added) if (e.entity_type === 'lead') marca(e.entity_id, statusDe(e.value_after))
  for (const e of ev.lead_status_changed) if (e.entity_type === 'lead') { marca(e.entity_id, statusDe(e.value_before)); marca(e.entity_id, statusDe(e.value_after)) }
  for (const l of leads) marca(l.id, { pipeline_id: l.pipeline_id, id: l.status_id })

  // de qual etapa o lead foi perdido
  const perdaPorEtapa = new Map()
  for (const e of ev.lead_status_changed) {
    const de = statusDe(e.value_before), para = statusDe(e.value_after)
    if (para?.id === PERDIDO && de) perdaPorEtapa.set(`${de.pipeline_id}:${de.id}`, (perdaPorEtapa.get(`${de.pipeline_id}:${de.id}`) || 0) + 1)
  }

  // ── funis ──
  const funis = d.funis.map(p => {
    const statuses = [...p._embedded.statuses].sort((a, b) => a.sort - b.sort)
    const doFunil = leads.filter(l => l.pipeline_id === p.id)
    const ab = doFunil.filter(l => !fechado(l))
    const g = ganhos.filter(l => l.pipeline_id === p.id)
    const pe = perdidos.filter(l => l.pipeline_id === p.id)
    const coorte = criadosJanela.filter(l => [...(alcancou.get(l.id) || [])].some(k => k.startsWith(`${p.id}:`)))
    const sortDe = new Map(statuses.map(s => [s.id, s.sort]))
    const maxSort = l => {
      let m = -Infinity
      for (const k of alcancou.get(l.id) || []) {
        const [pid, sid] = k.split(':').map(Number)
        if (pid !== p.id) continue
        if (sid === GANHO) return Infinity
        if (sid !== PERDIDO) m = Math.max(m, sortDe.get(sid) ?? -Infinity)
      }
      return m
    }
    const maximos = coorte.map(maxSort)
    const etapas = statuses.map(s => {
      const final = s.id === GANHO || s.id === PERDIDO
      const naEtapa = doFunil.filter(l => l.status_id === s.id)
      if (final) {
        const janela = (s.id === GANHO ? g : pe)
        return { id: s.id, nome: s.name, final: true, totalHistorico: naEtapa.length, naJanela: janela.length, valorNaJanela: soma(janela.map(l => l.price)) }
      }
      const dias = naEtapa.map(diasNaEtapa)
      const parado = n => naEtapa.filter(l => l.updated_at < AGORA - n * DIA).length
      return {
        id: s.id, nome: s.name, tipo: s.type === 1 ? 'entrada' : 'normal', final: false,
        leads: naEtapa.length, valor: soma(naEtapa.map(l => l.price)),
        diasNaEtapaMediana: r1(quantil(dias.map(x => x ?? DIAS), 0.5)),
        semMudancaNaJanela: dias.filter(x => x == null).length,
        semAtualizacao7d: parado(7), semAtualizacao15d: parado(15), semAtualizacao30d: parado(30),
        passagemCoorte: maximos.filter(m => m >= s.sort).length,
        perdidosDestaEtapa: perdaPorEtapa.get(`${p.id}:${s.id}`) || 0,
      }
    })
    return {
      id: p.id, nome: p.name, principal: p.is_main, arquivado: p.is_archive, entradaLigada: p.is_unsorted_on,
      leadsAbertos: ab.length, valorAberto: soma(ab.map(l => l.price)),
      criadosNaJanela: doFunil.filter(l => l.created_at >= DESDE).length,
      coorteJanela: coorte.length,
      ganhos: g.length, perdidos: pe.length, taxaGanho: pct(g.length, g.length + pe.length),
      receita: soma(g.map(l => l.price)), ticketMedio: g.length ? Math.round(soma(g.map(l => l.price)) / g.length) : null,
      cicloDiasMediana: r1(quantil(g.map(l => ((l.closed_at || l.updated_at) - l.created_at) / DIA), 0.5)),
      etapas,
    }
  })

  // ── perdas ──
  const motivo = l => l._embedded?.loss_reason?.[0]?.name || (l.loss_reason_id ? `#${l.loss_reason_id}` : null)
  const perdas = {
    total: perdidos.length,
    comMotivo: perdidos.filter(motivo).length,
    pctComMotivo: pct(perdidos.filter(motivo).length, perdidos.length),
    porMotivo: contar(perdidos.filter(motivo), motivo).slice(0, 15),
    motivosCadastrados: d.motivosPerda.map(m => m.name),
    motivoObrigatorioLigado: conta.is_loss_reason_enabled,
  }

  // ── tarefas ──
  const tAbertas = d.tarefasAbertas
  const atrasada = t => t.complete_till < AGORA
  const leadsComTarefa = new Set(tAbertas.filter(t => t.entity_type === 'leads').map(t => t.entity_id))
  const semTarefa = abertos.filter(l => !leadsComTarefa.has(l.id) && !l.closest_task_at)
  const tarefas = {
    abertas: tAbertas.length,
    atrasadas: tAbertas.filter(atrasada).length,
    atrasadasMais7d: tAbertas.filter(t => t.complete_till < AGORA - 7 * DIA).length,
    atrasadasMais30d: tAbertas.filter(t => t.complete_till < AGORA - 30 * DIA).length,
    porTipo: contar(tAbertas, t => tiposTarefa.get(t.task_type_id) || `tipo ${t.task_type_id}`),
    concluidasNaJanela: d.tarefasConcluidas.length,
    leadsAbertosSemTarefa: semTarefa.length,
    pctLeadsAbertosSemTarefa: pct(semTarefa.length, abertos.length),
  }

  // ── atendimento (chat) ──
  const inc = ev.incoming_chat_message, out = ev.outgoing_chat_message
  let inicioCobertura = DESDE
  if (ev.incoming_chat_message__truncado || ev.outgoing_chat_message__truncado) {
    const maisAntigo = arr => (arr.length ? Math.min(...arr.map(e => e.created_at)) : AGORA)
    inicioCobertura = Math.max(maisAntigo(inc), maisAntigo(out))
  }
  const msgs = [...inc.map(e => ({ ...e, dir: 'in' })), ...out.map(e => ({ ...e, dir: 'out' }))]
    .filter(e => e.created_at >= inicioCobertura).sort((a, b) => a.created_at - b.created_at)
  const conversa = e => e.value_after?.[0]?.message?.talk_id ?? `${e.entity_type}:${e.entity_id}`
  const porConversa = new Map()
  for (const m of msgs) { const k = conversa(m); if (!porConversa.has(k)) porConversa.set(k, []); porConversa.get(k).push(m) }
  const respostas = [], pendentes = []
  for (const lista of porConversa.values()) {
    let aguardando = null, entidade = null
    for (const m of lista) {
      if (m.dir === 'in') { if (aguardando == null) { aguardando = m.created_at; entidade = m } }
      else if (aguardando != null) {
        respostas.push({ min: (m.created_at - aguardando) / 60, por: m.created_by, fora: foraDoHorario(aguardando) })
        aguardando = null
      }
    }
    if (aguardando != null) pendentes.push({ desde: aguardando, entidade: `${entidade.entity_type}:${entidade.entity_id}` })
  }
  const resumoTempo = arr => ({
    n: arr.length,
    medianaMin: r1(quantil(arr, 0.5)), p75Min: r1(quantil(arr, 0.75)), p90Min: r1(quantil(arr, 0.9)),
    pctAte5min: pct(arr.filter(x => x <= 5).length, arr.length),
    pctAte1h: pct(arr.filter(x => x <= 60).length, arr.length),
    pctMais24h: pct(arr.filter(x => x > 1440).length, arr.length),
  })
  const porHora = Array(24).fill(0), porDia = Array(7).fill(0)
  for (const m of msgs) if (m.dir === 'in') { const { dow, h } = local(m.created_at); porHora[h]++; porDia[dow]++ }
  const recebidas = msgs.filter(m => m.dir === 'in')
  const enviadas = msgs.filter(m => m.dir === 'out')
  const atendimento = {
    inicioCobertura, coberturaDias: r1((AGORA - inicioCobertura) / DIA),
    truncado: !!(ev.incoming_chat_message__truncado || ev.outgoing_chat_message__truncado),
    recebidas: recebidas.length, enviadas: enviadas.length, conversas: porConversa.size,
    pctRecebidasForaDoHorario: pct(recebidas.filter(m => foraDoHorario(m.created_at)).length, recebidas.length),
    porCanal: contar(msgs, m => m.value_after?.[0]?.message?.origin || 'desconhecido'),
    enviadasPor: contar(enviadas, m => nomeUsuario(m.created_by)),
    pctEnviadasPorRobo: pct(enviadas.filter(m => m.created_by === 0).length, enviadas.length),
    respostasDoRobo: ev.robot_replied.length,
    tempoPrimeiraResposta: resumoTempo(respostas.map(r => r.min)),
    tempoRespostaDentroHorario: resumoTempo(respostas.filter(r => !r.fora).map(r => r.min)),
    tempoRespostaForaHorario: resumoTempo(respostas.filter(r => r.fora).map(r => r.min)),
    tempoRespostaHumano: resumoTempo(respostas.filter(r => r.por !== 0).map(r => r.min)),
    tempoRespostaPorUsuario: [...new Set(respostas.map(r => r.por))].map(id => ({ usuario: nomeUsuario(id), ...resumoTempo(respostas.filter(r => r.por === id).map(r => r.min)) })).sort((a, b) => b.n - a.n),
    aguardandoRespostaMais1h: pendentes.filter(p => AGORA - p.desde > 3600).length,
    aguardandoRespostaMais24h: pendentes.filter(p => AGORA - p.desde > DIA).length,
    recebidasPorHora: porHora, recebidasPorDiaSemana: porDia,
    ligacoes: { recebidas: ev.incoming_call.length, feitas: ev.outgoing_call.length },
  }

  // ── entrada de leads ──
  const fontes = new Map(d.fontes.map(f => [f.id, f.name]))
  const campoPorCodigo = (l, code) => l.custom_fields_values?.find(f => f.field_code === code)?.values?.[0]?.value
  const semana = ts => Math.floor((AGORA - ts) / (7 * DIA))
  const porSemana = Array(Math.ceil(DIAS / 7)).fill(0)
  for (const l of criadosJanela) { const s = semana(l.created_at); if (s < porSemana.length) porSemana[s]++ }
  const camposOrigem = d.camposLead.filter(f => /origem|fonte|canal|source|m[ií]dia|campanha/i.test(f.name) && f.enums)
  const entrada = {
    criadosNaJanela: criadosJanela.length,
    porSemanaMaisRecentePrimeiro: porSemana,
    porFunil: contar(criadosJanela, l => d.funis.find(p => p.id === l.pipeline_id)?.name || `#${l.pipeline_id}`),
    porFonte: contar(criadosJanela, l => fontes.get(l.source_id) || (l.source_id ? `fonte #${l.source_id}` : 'sem fonte')),
    porUtmSource: contar(criadosJanela, l => campoPorCodigo(l, 'UTM_SOURCE') || 'sem utm_source').slice(0, 15),
    pctComUtm: pct(criadosJanela.filter(l => campoPorCodigo(l, 'UTM_SOURCE')).length, criadosJanela.length),
    criadosPor: contar(criadosJanela, l => nomeUsuario(l.created_by)).slice(0, 15),
    camposDeOrigem: camposOrigem.map(f => ({
      campo: f.name,
      distribuicao: contar(criadosJanela, l => l.custom_fields_values?.find(v => v.field_id === f.id)?.values?.[0]?.value || 'vazio').slice(0, 15),
    })),
    caixaDeEntrada: {
      resumo: d.entradaResumo,
      pendentes: d.entrada.length,
      pendentesPorCategoria: contar(d.entrada, u => u.category),
      pendentesMaisAntigoDias: d.entrada.length ? r1((AGORA - Math.min(...d.entrada.map(u => u.created_at))) / DIA) : null,
    },
  }

  // ── qualidade de dados ──
  const baseLeads = [...new Map([...abertos, ...criadosJanela].map(l => [l.id, l])).values()]
  const nomeGenerico = l => !l.name || /^(lead|neg[oó]cio|deal|novo lead|venda|sale|oportunidade)?\s*#?\s*\d*$/i.test(l.name.trim())
  const preenchimento = (campos, registros) => campos.map(f => {
    const n = registros.filter(r => r.custom_fields_values?.some(v => v.field_id === f.id && v.values?.some(x => x.value !== '' && x.value != null))).length
    return { id: f.id, nome: f.name, tipo: f.type, codigo: f.code || null, preenchidos: n, pct: pct(n, registros.length), obrigatorioEmEtapas: (f.required_statuses || []).length }
  }).sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))
  const duplicadosPorNome = campos => contar(campos, f => normalizar(f.name)).filter(([, n]) => n > 1).map(([k, n]) => ({ nome: campos.find(f => normalizar(f.name) === k).name, vezes: n }))

  const fone = c => (c.custom_fields_values?.find(f => f.field_code === 'PHONE')?.values || []).map(v => v.value)
  const email = c => (c.custom_fields_values?.find(f => f.field_code === 'EMAIL')?.values || []).map(v => v.value)
  const chaveFone = v => {
    let s = String(v).replace(/\D/g, '')
    if (s.length >= 12 && s.startsWith('55')) s = s.slice(2)
    if (s.length === 11 && s[2] === '9') s = s.slice(0, 2) + s.slice(3) // celular com e sem o 9 é o mesmo número
    return s.length >= 8 ? s.slice(-10) : null
  }
  const porFone = new Map()
  for (const c of d.contatos) for (const k of new Set(fone(c).map(chaveFone).filter(Boolean))) {
    if (!porFone.has(k)) porFone.set(k, []); porFone.get(k).push(c.id)
  }
  const gruposDup = [...porFone.values()].filter(ids => ids.length > 1)

  const tagsUsadas = new Set(leads.flatMap(l => (l._embedded?.tags || []).map(t => t.id)))
  const gruposTags = contar(d.tagsLead, t => normalizar(t.name)).filter(([, n]) => n > 1)
  const qualidade = {
    leadsAnalisados: baseLeads.length,
    abertosSemContato: abertos.filter(l => !l._embedded?.contacts?.length).length,
    abertosSemValor: abertos.filter(l => !l.price).length,
    pctAbertosSemValor: pct(abertos.filter(l => !l.price).length, abertos.length),
    abertosComNomeGenerico: abertos.filter(nomeGenerico).length,
    abertosComResponsavelInativo: abertos.filter(l => usuarios.has(l.responsible_user_id) && !ativo(usuarios.get(l.responsible_user_id))).length,
    camposLead: preenchimento(d.camposLead, baseLeads),
    camposLeadNuncaPreenchidos: preenchimento(d.camposLead, baseLeads).filter(f => f.preenchidos === 0).length,
    camposLeadDuplicados: duplicadosPorNome(d.camposLead),
    camposContato: preenchimento(d.camposContato, d.contatos),
    contatos: d.contatos.length,
    contatosSemTelefoneNemEmail: d.contatos.filter(c => !fone(c).length && !email(c).length).length,
    contatosSemTelefone: d.contatos.filter(c => !fone(c).length).length,
    telefonesDuplicados: { grupos: gruposDup.length, contatosEnvolvidos: soma(gruposDup.map(g => g.length)) },
    empresas: d.empresas.length,
    tags: { cadastradas: d.tagsLead.length, usadasEmLeads: tagsUsadas.size, semUso: d.tagsLead.filter(t => !tagsUsadas.has(t.id)).length, grafiasParecidas: gruposTags.length,
      maisUsadasEmAbertos: contar(abertos.flatMap(l => (l._embedded?.tags || []).map(t => t.name)), x => x).slice(0, 20) },
  }

  // ── equipe ──
  const equipe = d.usuarios.map(u => {
    const meus = abertos.filter(l => l.responsible_user_id === u.id)
    const g = ganhos.filter(l => l.responsible_user_id === u.id)
    const p = perdidos.filter(l => l.responsible_user_id === u.id)
    return {
      id: u.id, nome: u.name, ativo: ativo(u), admin: !!u.rights?.is_admin, gratuito: !!u.rights?.is_free,
      papel: u._embedded?.roles?.[0]?.name || null, grupo: u._embedded?.groups?.[0]?.name || null,
      leadsAbertos: meus.length, valorAberto: soma(meus.map(l => l.price)),
      leadsAbertosSemTarefa: semTarefa.filter(l => l.responsible_user_id === u.id).length,
      tarefasAbertas: tAbertas.filter(t => t.responsible_user_id === u.id).length,
      tarefasAtrasadas: tAbertas.filter(t => t.responsible_user_id === u.id && atrasada(t)).length,
      ganhos: g.length, perdidos: p.length, taxaGanho: pct(g.length, g.length + p.length), receita: soma(g.map(l => l.price)),
      mensagensEnviadas: enviadas.filter(m => m.created_by === u.id).length,
    }
  }).sort((a, b) => b.leadsAbertos - a.leadsAbertos)

  // ── automação e integrações ──
  const mudancas = ev.lead_status_changed
  const automacao = {
    mudancasDeEtapa: mudancas.length,
    pctMudancasPorRoboOuIntegracao: pct(mudancas.filter(e => e.created_by === 0).length, mudancas.length),
    mudancasPor: contar(mudancas, e => nomeUsuario(e.created_by)).slice(0, 15),
    trocasDeResponsavel: ev.entity_responsible_changed.length,
    trocasDeResponsavelPorRobo: ev.entity_responsible_changed.filter(e => e.created_by === 0).length,
    leadsExcluidosNaJanela: ev.lead_deleted.length,
    webhooks: d.webhooks.map(w => ({ destino: w.destination, eventos: w.settings, desativado: !!w.disabled })),
    widgetsAtivos: d.widgets.filter(w => w.is_active_in_account).map(w => ({ codigo: w.code, versao: w.version, fonteDeLead: !!w.is_lead_source, usaDigitalPipeline: !!w.is_work_with_dp })),
    fontes: d.fontes.map(f => ({ nome: f.name, funil: d.funis.find(p => p.id === f.pipeline_id)?.name || null, origem: f.origin_code || null })),
    catalogos: d.catalogos.map(c => c.name),
    templatesDeChat: d.templatesChat.length,
  }

  return {
    geradoEm: new Date(AGORA * 1000).toISOString(), janelaDias: DIAS, horarioComercial: `${H_INI}h–${H_FIM}h seg–sex`, fusoHorario: tz,
    conta: {
      id: conta.id, nome: conta.name, subdominio: conta.subdomain, pais: conta.country, moeda: conta.currency,
      criadaEm: conta.created_at ? new Date(conta.created_at * 1000).toISOString().slice(0, 10) : null,
      entradaLigada: conta.is_unsorted_on, motivoPerdaLigado: conta.is_loss_reason_enabled, helpbotLigado: conta.is_helpbot_enabled,
      modoClientes: conta.customers_mode, contaTecnica: conta.is_technical_account,
      usuarios: d.usuarios.length, usuariosAtivos: d.usuarios.filter(ativo).length,
    },
    volume: {
      leadsTotal: leads.length, leadsAbertos: abertos.length, valorAberto: soma(abertos.map(l => l.price)),
      criadosNaJanela: criadosJanela.length, ganhosNaJanela: ganhos.length, perdidosNaJanela: perdidos.length,
      taxaGanho: pct(ganhos.length, ganhos.length + perdidos.length), receitaNaJanela: soma(ganhos.map(l => l.price)),
      ticketMedio: ganhos.length ? Math.round(soma(ganhos.map(l => l.price)) / ganhos.length) : null,
      cicloDiasMediana: r1(quantil(ganhos.map(l => ((l.closed_at || l.updated_at) - l.created_at) / DIA), 0.5)),
    },
    funis, perdas, tarefas, atendimento, entrada, qualidade, equipe, automacao,
    limitacoes: { falhas, truncados },
  }
}

// ───────────────────────────── resumo ─────────────────────────────

function resumo(m) {
  const n = x => (x == null ? '—' : typeof x === 'number' ? x.toLocaleString('pt-BR') : x)
  const v = x => `${m.conta.moeda || ''} ${n(Math.round(x || 0))}`.trim()
  const L = []
  L.push(`# Auditoria Kommo · ${m.conta.nome} (${m.conta.subdominio})`, '', `Gerado em ${m.geradoEm} · janela de ${m.janelaDias} dias · fuso ${m.fusoHorario}`, '')
  L.push('## Volume', '', `| Leads abertos | Valor aberto | Criados | Ganhos | Perdidos | Taxa de ganho | Receita | Ticket | Ciclo (mediana) |`, '|---|---|---|---|---|---|---|---|---|')
  const o = m.volume
  L.push(`| ${n(o.leadsAbertos)} | ${v(o.valorAberto)} | ${n(o.criadosNaJanela)} | ${n(o.ganhosNaJanela)} | ${n(o.perdidosNaJanela)} | ${n(o.taxaGanho)}% | ${v(o.receitaNaJanela)} | ${v(o.ticketMedio)} | ${n(o.cicloDiasMediana)} d |`, '')
  for (const p of m.funis) {
    L.push(`## Funil: ${p.nome}${p.principal ? ' (principal)' : ''}${p.arquivado ? ' (arquivado)' : ''}`, '')
    L.push(`Abertos ${n(p.leadsAbertos)} · criados ${n(p.criadosNaJanela)} · ganhos ${n(p.ganhos)} · perdidos ${n(p.perdidos)} · taxa ${n(p.taxaGanho)}% · ciclo ${n(p.cicloDiasMediana)} d`, '')
    L.push('| Etapa | Leads | Dias na etapa (mediana) | Sem atualização >15d | Passagem (coorte) | Perdidos daqui |', '|---|---|---|---|---|---|')
    for (const e of p.etapas) {
      if (e.final) L.push(`| **${e.nome}** | ${n(e.naJanela)} na janela | | | | |`)
      else L.push(`| ${e.nome} | ${n(e.leads)} | ${n(e.diasNaEtapaMediana)} | ${n(e.semAtualizacao15d)} | ${n(e.passagemCoorte)}/${n(p.coorteJanela)} | ${n(e.perdidosDestaEtapa)} |`)
    }
    L.push('')
  }
  const a = m.atendimento
  L.push('## Atendimento', '', `Cobertura ${n(a.coberturaDias)} dias · recebidas ${n(a.recebidas)} · enviadas ${n(a.enviadas)} (${n(a.pctEnviadasPorRobo)}% por robô) · ${n(a.pctRecebidasForaDoHorario)}% chegam fora do horário`, '')
  const t = a.tempoPrimeiraResposta
  L.push(`Primeira resposta: mediana ${n(t.medianaMin)} min · p90 ${n(t.p90Min)} min · até 5 min ${n(t.pctAte5min)}% · mais de 24h ${n(t.pctMais24h)}%`)
  L.push(`Aguardando resposta agora: ${n(a.aguardandoRespostaMais1h)} há mais de 1h · ${n(a.aguardandoRespostaMais24h)} há mais de 24h`, '')
  L.push('## Tarefas', '', `Abertas ${n(m.tarefas.abertas)} · atrasadas ${n(m.tarefas.atrasadas)} (${n(m.tarefas.atrasadasMais30d)} há mais de 30 dias) · leads abertos sem tarefa ${n(m.tarefas.leadsAbertosSemTarefa)} (${n(m.tarefas.pctLeadsAbertosSemTarefa)}%)`, '')
  L.push('## Perdas', '', `${n(m.perdas.total)} perdidos · ${n(m.perdas.pctComMotivo)}% com motivo · motivo obrigatório: ${m.perdas.motivoObrigatorioLigado ? 'sim' : 'não'}`, '')
  for (const [k, c] of m.perdas.porMotivo) L.push(`- ${k}: ${c}`)
  const q = m.qualidade
  L.push('', '## Qualidade de dados', '', `Abertos sem contato ${n(q.abertosSemContato)} · sem valor ${n(q.abertosSemValor)} (${n(q.pctAbertosSemValor)}%) · nome genérico ${n(q.abertosComNomeGenerico)} · responsável inativo ${n(q.abertosComResponsavelInativo)}`)
  L.push(`Campos de lead nunca preenchidos ${n(q.camposLeadNuncaPreenchidos)}/${n(q.camposLead.length)} · telefones duplicados ${n(q.telefonesDuplicados.grupos)} grupos · tags sem uso ${n(q.tags.semUso)}/${n(q.tags.cadastradas)}`, '')
  L.push('## Equipe', '', '| Usuário | Ativo | Abertos | Sem tarefa | Atrasadas | Ganhos | Perdidos | Taxa | Mensagens |', '|---|---|---|---|---|---|---|---|---|')
  for (const u of m.equipe) L.push(`| ${u.nome} | ${u.ativo ? 'sim' : 'não'} | ${n(u.leadsAbertos)} | ${n(u.leadsAbertosSemTarefa)} | ${n(u.tarefasAtrasadas)} | ${n(u.ganhos)} | ${n(u.perdidos)} | ${n(u.taxaGanho)}% | ${n(u.mensagensEnviadas)} |`)
  if (m.limitacoes.falhas.length || m.limitacoes.truncados.length) {
    L.push('', '## Limitações da coleta', '')
    for (const f of m.limitacoes.falhas) L.push(`- falha: ${f}`)
    for (const f of m.limitacoes.truncados) L.push(`- truncado: ${f}`)
  }
  return L.join('\n') + '\n'
}

// ───────────────────────────── main ─────────────────────────────

const dados = await coletar()
const metricas = analisar(dados)
fs.writeFileSync(path.join(SAIDA, 'metricas.json'), JSON.stringify(metricas, null, 2))
fs.writeFileSync(path.join(SAIDA, 'resumo.md'), resumo(metricas))
console.log(`\nPronto: ${path.join(SAIDA, 'metricas.json')} e resumo.md`)
if (falhas.length) console.log(`Chamadas opcionais que falharam: ${falhas.length} (ver resumo.md)`)
