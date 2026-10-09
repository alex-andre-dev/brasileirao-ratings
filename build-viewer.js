import { db } from './db.js';
import { readFileSync, writeFileSync } from 'node:fs';

const LEAGUE = 71; // Brasileirão Série A

// Jogadores de linha, de todas as temporadas com rating calculado
const rows = db.prepare(`
  SELECT p.id, p.name, r.season,
    r.pos_group AS pos, r.minutes, r.provisional AS prov,
    r.finalizacao AS fin, r.passe AS pas, r.drible AS dri,
    r.defesa AS dfe, r.duelos AS due, r.overall AS ovr,
    s.appearances AS jogos, s.goals AS gols, s.assists AS assist,
    s.shots_total AS chutes, s.shots_on AS no_alvo,
    s.passes_total AS passes, s.passes_key AS passes_chave,
    s.dribbles_attempts AS dribles_tent, s.dribbles_success AS dribles_ok,
    s.tackles AS desarmes, s.interceptions AS intercep,
    s.duels_total AS duelos_tot, s.duels_won AS duelos_ganhos,
    s.raw
  FROM ratings r
  JOIN players p ON p.id = r.player_id
  JOIN player_stats s ON s.player_id = r.player_id AND s.season = r.season
`).all();

// Goleiros (só existem depois de rodar gk-ratings.js)
const hasGk = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gk_ratings'").get();
const gkRows = !hasGk ? [] : db.prepare(`
  SELECT p.id, p.name, g.season, 'GK' AS pos, g.minutes, g.provisional AS prov,
    g.apr, g.seg, g.pen, g.passe AS gpas, g.overall AS ovr,
    g.saves, g.conceded, g.pen_saved,
    s.appearances AS jogos, s.passes_total AS passes, s.raw
  FROM gk_ratings g
  JOIN players p ON p.id = g.player_id
  JOIN player_stats s ON s.player_id = g.player_id AND s.season = g.season
`).all();

if (rows.length + gkRows.length === 0) {
  console.error('Nenhum rating encontrado. Rode antes: node ratings.js 2024');
  process.exit(1);
}

// O time vem do JSON original de cada temporada, porque a tabela players
// guarda só o time do último sync e ficaria errado nas temporadas antigas.
const data = [...rows, ...gkRows].map(({ raw, ...r }) => {
  const item = JSON.parse(raw);
  const st = item.statistics.find((x) => x.league?.id === LEAGUE) ?? item.statistics[0];
  return { ...r, team: st?.team?.name ?? '' };
});

const template = readFileSync(new URL('./viewer.template.html', import.meta.url), 'utf8');
const json = JSON.stringify(data).replace(/</g, '\\u003c');

writeFileSync('viewer.html', template.replace('__DATA__', () => json));

const seasons = [...new Set(data.map((r) => r.season))].sort();
console.log(`viewer.html gerado: ${rows.length} jogadores de linha, ${gkRows.length} goleiros, temporadas ${seasons.join(', ')}.`);
