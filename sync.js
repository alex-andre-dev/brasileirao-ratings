import { db } from './db.js';

const BASE = 'https://v3.football.api-sports.io';
const LEAGUE = 71; // Brasileirão Série A
const SEASON = Number(process.argv[2] ?? 2023);
const MAX_PAGES = 3; // limite do plano grátis
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const res = await fetch(BASE + path, {
    headers: { 'x-apisports-key': process.env.API_KEY },
  });
  const json = await res.json();
  if (Object.keys(json.errors ?? {}).length) {
    throw new Error(JSON.stringify(json.errors));
  }
  return json;
}

const upsertPlayer = db.prepare(`
  INSERT INTO players (id, name, team, position, age, photo)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name, team = excluded.team,
    position = excluded.position, age = excluded.age, photo = excluded.photo
`);

const upsertStats = db.prepare(`
  INSERT OR REPLACE INTO player_stats VALUES
  (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// 1) Lista os times da Série A (1 requisição)
const teams = await get(`/teams?league=${LEAGUE}&season=${SEASON}`);
console.log(`${teams.response.length} times encontrados`);

// 2) Para cada time, busca os jogadores (até 3 páginas)
for (const { team } of teams.response) {
  let page = 1;
  let totalPages = 1;

  do {
    await sleep(7000); // limite de 10 req/min
    const json = await get(
      `/players?league=${LEAGUE}&season=${SEASON}&team=${team.id}&page=${page}`
    );
    totalPages = Math.min(json.paging.total, MAX_PAGES);

    for (const item of json.response) {
      const { player, statistics } = item;
      const s = statistics.find((x) => x.league?.id === LEAGUE) ?? statistics[0];
      upsertPlayer.run(
        player.id, player.name, s.team?.name ?? team.name,
        s.games?.position ?? null, player.age ?? null, player.photo ?? null
      );
      upsertStats.run(
        player.id, SEASON,
        s.games?.appearences ?? null, // a API escreve "appearences" errado mesmo
        s.games?.minutes ?? null,
        s.goals?.total ?? null, s.goals?.assists ?? null,
        s.shots?.total ?? null, s.shots?.on ?? null,
        s.passes?.total ?? null, s.passes?.key ?? null, s.passes?.accuracy ?? null,
        s.dribbles?.attempts ?? null, s.dribbles?.success ?? null,
        s.tackles?.total ?? null, s.tackles?.interceptions ?? null,
        s.duels?.total ?? null, s.duels?.won ?? null,
        JSON.stringify(item)
      );
    }

    console.log(`${team.name}: página ${page}/${totalPages} ok`);
    page++;
  } while (page <= totalPages);
}

console.log('Pronto!');