import { db } from './db.js';

const SEASON = Number(process.argv[2] ?? 2023);
const FULL_MIN = 900; // rating cheio
const MIN_RATED = 270; // abaixo disso, sem rating

db.exec(`
  CREATE TABLE IF NOT EXISTS ratings (
    player_id INTEGER, season INTEGER,
    pos_group TEXT, minutes INTEGER, provisional INTEGER,
    finalizacao INTEGER, passe INTEGER, drible INTEGER,
    defesa INTEGER, duelos INTEGER, overall INTEGER,
    PRIMARY KEY (player_id, season)
  );
`);

const GROUPS = { Defender: 'DEF', Midfielder: 'MID', Attacker: 'ATT', Forward: 'ATT' };

// peso de cada valência no overall, por posição
const OVERALL_WEIGHTS = {
  DEF: { finalizacao: 0, passe: 0.2, drible: 0.05, defesa: 0.45, duelos: 0.3 },
  MID: { finalizacao: 0.1, passe: 0.4, drible: 0.15, defesa: 0.2, duelos: 0.15 },
  ATT: { finalizacao: 0.8, passe: 0.1, drible: 0.15, defesa: 0, duelos: 0.05 },
};

// métricas de cada valência e seus pesos
const METRICS = {
  finalizacao: [['goals_p90', 0.5], ['shots_on_p90', 0.3], ['shots_p90', 0.2]],
  passe: [['passes_p90', 0.4], ['key_passes_p90', 0.35], ['assists_p90', 0.25]],
  drible: [['dribbles_ok_p90', 0.6], ['dribble_rate', 0.4]],
  defesa: [['tackles_p90', 0.5], ['interceptions_p90', 0.5]],
  duelos: [['duels_won_p90', 0.5], ['duel_rate', 0.5]],
};

const n = (v) => v ?? 0; // NULL vira 0

function features(r) {
  const k = 90 / r.minutes;
  return {
    goals_p90: n(r.goals) * k,
    shots_on_p90: n(r.shots_on) * k,
    shots_p90: n(r.shots_total) * k,
    passes_p90: n(r.passes_total) * k,
    key_passes_p90: n(r.passes_key) * k,
    assists_p90: n(r.assists) * k,
    dribbles_ok_p90: n(r.dribbles_success) * k,
    // taxa "suavizada": poucas tentativas não geram 100% falso
    dribble_rate: (n(r.dribbles_success) + 2) / (n(r.dribbles_attempts) + 5),
    tackles_p90: n(r.tackles) * k,
    interceptions_p90: n(r.interceptions) * k,
    duels_won_p90: n(r.duels_won) * k,
    duel_rate: (n(r.duels_won) + 5) / (n(r.duels_total) + 10),
  };
}

// posição do valor dentro da lista ordenada (0 a 1); empates contam metade
function percentile(sorted, v) {
  let below = 0, equal = 0;
  for (const x of sorted) {
    if (x < v) below++;
    else if (x === v) equal++;
  }
  return (below + equal / 2) / sorted.length;
}

const rows = db.prepare(`
  SELECT p.id, p.name, s.raw,
    s.minutes, s.goals, s.assists, s.shots_total, s.shots_on,
    s.passes_total, s.passes_key, s.dribbles_attempts, s.dribbles_success,
    s.tackles, s.interceptions, s.duels_total, s.duels_won
  FROM player_stats s JOIN players p ON p.id = s.player_id
  WHERE s.season = ? AND s.minutes >= ?
`).all(SEASON, MIN_RATED);

for (const r of rows) {
  const item = JSON.parse(r.raw);
  const st = item.statistics.find((x) => x.league?.id === 71) ?? item.statistics[0];
  r.team = st?.team?.name ?? null;
  r.position = st?.games?.position ?? null;
}

// goleiros ficam de fora por enquanto
const players = rows
  .filter((r) => GROUPS[r.position])

const ref = players.filter((p) => p.minutes >= FULL_MIN);

// grupo de referência
console.log(`${players.length} jogadores de linha com rating (${ref.length} com 900+ min)`);

// ajuste de time: remove metade do efeito do estilo do time no volume de passes
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const leagueMean = mean(ref.map((p) => p.f.passes_p90));
const teamMean = {};
for (const t of new Set(ref.map((p) => p.team))) {
  teamMean[t] = mean(ref.filter((p) => p.team === t).map((p) => p.f.passes_p90));
}
for (const p of players) {
  p.f.passes_p90 -= 0.5 * ((teamMean[p.team] ?? leagueMean) - leagueMean);
}

// 1) percentil de cada métrica contra o grupo de referência
const metricNames = [...new Set(Object.values(METRICS).flat().map(([m]) => m))];
const refMetric = Object.fromEntries(
  metricNames.map((m) => [m, ref.map((p) => p.f[m]).sort((a, b) => a - b)])
);

const composite = (p, valence) =>
  METRICS[valence].reduce((sum, [m, w]) => sum + w * percentile(refMetric[m], p.f[m]), 0);

// 2) distribuição da nota composta de cada valência no grupo de referência
const refComposite = {};
for (const v of Object.keys(METRICS)) {
  refComposite[v] = ref.map((p) => composite(p, v)).sort((a, b) => a - b);
}

// 3) rating final de cada jogador
const results = players.map((p) => {
  const provisional = p.minutes < FULL_MIN;
  const out = { id: p.id, name: p.name, team: p.team, group: p.group, minutes: p.minutes, provisional };
  for (const v of Object.keys(METRICS)) {
    let pct = percentile(refComposite[v], composite(p, v));
    // pouco minuto: aproxima do meio da escala
    if (provisional) pct = 0.5 + (pct - 0.5) * (p.minutes / FULL_MIN);
    out[v] = Math.round(45 + pct * 54); // escala de 45 a 99
  }
  const w = OVERALL_WEIGHTS[p.group];
  out.raw = Object.keys(w).reduce((sum, v) => sum + w[v] * out[v], 0);
  out.overall = Math.round(out.raw);
  return out;
});

// overall: cada valência é comparada só com a mesma posição, depois ponderada
const byGroup = {};
for (const g of ['DEF', 'MID', 'ATT']) {
  const grp = results.filter((r) => r.group === g && !r.provisional);
  byGroup[g] = Object.fromEntries(
    Object.keys(METRICS).map((v) => [v, grp.map((r) => r[v]).sort((a, b) => a - b)])
  );
}
for (const r of results) {
  const w = OVERALL_WEIGHTS[r.group];
  r.raw = Object.keys(w).reduce(
    (sum, v) => sum + w[v] * percentile(byGroup[r.group][v], r[v]), 0
  );
}

const rawByGroup = {};
for (const g of ['DEF', 'MID', 'ATT']) {
  rawByGroup[g] = results
    .filter((r) => r.group === g && !r.provisional)
    .map((r) => r.raw)
    .sort((a, b) => a - b);
}
for (const r of results) {
  r.overall = Math.round(55 + percentile(rawByGroup[r.group], r.raw) * 40);
}

// 4) grava no banco
const insert = db.prepare(`
  INSERT OR REPLACE INTO ratings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
db.exec('BEGIN');
for (const r of results) {
  insert.run(
    r.id, SEASON, r.group, r.minutes, r.provisional ? 1 : 0,
    r.finalizacao, r.passe, r.drible, r.defesa, r.duelos, r.overall
  );
}
db.exec('COMMIT');

// 5) top 10 para conferir com a sua percepção
const full = results.filter((r) => !r.provisional);
for (const v of ['overall', 'finalizacao', 'passe', 'drible', 'defesa', 'duelos']) {
  console.log(`\nTop 10 ${v}`);
  console.table(
    [...full].sort((a, b) => b[v] - a[v]).slice(0, 10)
      .map((r) => ({ nome: r.name, time: r.team, pos: r.group, [v]: r[v] }))
  );
}

for (const g of ['ATT', 'MID', 'DEF']) {
  console.log(`\nTop 10 overall ${g}`);
  console.table(
    full.filter((r) => r.group === g)
      .sort((a, b) => b.overall - a.overall).slice(0, 10)
      .map((r) => ({ nome: r.name, time: r.team, overall: r.overall }))
  );
}