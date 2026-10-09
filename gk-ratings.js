import { db } from './db.js';

const LEAGUE = 71;
const FULL_MIN = 900; // rating cheio
const MIN_RATED = 270; // abaixo disso, sem rating

db.exec(`
  CREATE TABLE IF NOT EXISTS gk_ratings (
    player_id INTEGER, season INTEGER, minutes INTEGER, provisional INTEGER,
    apr INTEGER, seg INTEGER, pen INTEGER, passe INTEGER, overall INTEGER,
    saves INTEGER, conceded INTEGER, pen_saved INTEGER,
    PRIMARY KEY (player_id, season)
  );
`);

// peso de cada valência no overall do goleiro
const W = { apr: 0.45, seg: 0.3, passe: 0.15, pen: 0.1 };

const pick = (raw) => {
  const st = JSON.parse(raw).statistics ?? [];
  return st.find((x) => x.league?.id === LEAGUE) ?? st[0];
};

function percentile(sorted, v) {
  let below = 0, equal = 0;
  for (const x of sorted) {
    if (x < v) below++;
    else if (x === v) equal++;
  }
  return (below + equal / 2) / sorted.length;
}

const seasons = db.prepare('SELECT DISTINCT season FROM player_stats ORDER BY season').all().map((r) => r.season);
const insert = db.prepare('INSERT OR REPLACE INTO gk_ratings VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');

for (const season of seasons) {
  const rows = db.prepare(
    'SELECT player_id, minutes, passes_total, raw FROM player_stats WHERE season = ? AND minutes >= ?'
  ).all(season, MIN_RATED);

  const gks = [];
  for (const r of rows) {
    const st = pick(r.raw);
    if (st?.games?.position !== 'Goalkeeper') continue;
    const saves = st.goals?.saves ?? 0;
    const conceded = st.goals?.conceded ?? 0;
    const penSaved = st.penalty?.saved ?? 0;
    const k = 90 / r.minutes;
    gks.push({
      id: r.player_id, minutes: r.minutes, saves, conceded, penSaved,
      f: {
        apr: (saves + 7) / (saves + conceded + 10), // aproveitamento suavizado
        seg: -(conceded * k), // menos gols sofridos = melhor
        pen: penSaved * k,
        passe: n(r.passes_total) * k,
      },
    });
  }
  function n(v) { return v ?? 0; }

  const ref = gks.filter((g) => g.minutes >= FULL_MIN);
  if (ref.length < 5) { console.log(`${season}: goleiros demais com pouco jogo, pulando`); continue; }
  const sorted = Object.fromEntries(Object.keys(W).map((v) => [v, ref.map((g) => g.f[v]).sort((a, b) => a - b)]));

  for (const g of gks) {
    const prov = g.minutes < FULL_MIN;
    g.pct = {};
    g.out = {};
    for (const v of Object.keys(W)) {
      let p = percentile(sorted[v], g.f[v]);
      if (prov) p = 0.5 + (p - 0.5) * (g.minutes / FULL_MIN);
      g.pct[v] = p;
      g.out[v] = Math.round(45 + p * 54);
    }
    g.raw = Object.keys(W).reduce((s, v) => s + W[v] * g.pct[v], 0);
    g.prov = prov;
  }
  const rawSorted = ref.map((g) => g.raw).sort((a, b) => a - b);

  db.exec('BEGIN');
  for (const g of gks) {
    const overall = Math.round(55 + percentile(rawSorted, g.raw) * 40);
    g.overall = overall;
    insert.run(g.id, season, g.minutes, g.prov ? 1 : 0,
      g.out.apr, g.out.seg, g.out.pen, g.out.passe, overall, g.saves, g.conceded, g.penSaved);
  }
  db.exec('COMMIT');
  console.log(`${season}: ${gks.length} goleiros com rating (${ref.length} com 900+ min)`);
}
