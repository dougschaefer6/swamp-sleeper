# @dougschaefer/sleeper

A [swamp](https://github.com/swamp-club/swamp) model for
[Sleeper](https://sleeper.com), the fantasy sports platform. It reads league
state — settings and scoring, rosters, matchups, transactions, drafts, playoff
brackets, and the league-wide waiver-wire trend — and lands all of it in the
swamp data model where CEL expressions and workflows can reach it.

Sleeper's public API is **read-only and unauthenticated**. There is no API key,
no OAuth, and no write surface: nothing here can set a lineup, submit a waiver
claim, or propose a trade. This model is a pure observer.

## Installation

```bash
swamp extension pull @dougschaefer/sleeper
```

## Setup

No credentials, no vault. A model definition is one Sleeper user in one sport:

```bash
swamp model create @dougschaefer/sleeper sleeper-nfl \
  --global-arg username=yourusername \
  --global-arg defaultLeagueId=1234567890123456789
```

`defaultLeagueId` is optional but worth setting — it saves passing `leagueId` to
every league method. To find it, create the definition with just the username,
then run `leagues`:

```bash
swamp model @dougschaefer/sleeper method run leagues sleeper-nfl
```

| Global argument   | Default                       | Purpose                                    |
| ----------------- | ----------------------------- | ------------------------------------------ |
| `username`        | *(required)*                  | Sleeper username, case-insensitive         |
| `sport`           | `nfl`                         | Sleeper sport code                         |
| `defaultLeagueId` | —                             | League used when `leagueId` is omitted     |
| `baseUrl`         | `https://api.sleeper.app/v1`  | API base URL                               |
| `cdnUrl`          | `https://sleepercdn.com`      | CDN that serves avatars                    |
| `timeoutMs`       | `30000`                       | Per-request timeout                        |

## Methods

| Method         | Reads                                                                    |
| -------------- | ------------------------------------------------------------------------ |
| `user`         | Username → user ID and avatar URLs. Run it first; everything keys off it. |
| `state`        | The sport's current season, week, and season type.                       |
| `leagues`      | Every league the user belongs to in a season, with IDs and draft IDs.     |
| `league`       | One league's roster slots, scoring rules, playoffs, and waiver settings.  |
| `rosters`      | Every roster, joined to owners and team names, with standings derived.    |
| `matchups`     | One week's matchups, paired head to head, with the current margin.        |
| `transactions` | One week's trades, waivers, and free-agent moves, with names resolved.    |
| `tradedPicks`  | Every draft pick that has changed hands, including future seasons.        |
| `bracket`      | The winners or losers playoff bracket.                                    |
| `drafts`       | Drafts belonging to a league, or to the user across a season.             |
| `draft`        | One draft's format, timing, and slot-to-roster mapping.                   |
| `draftPicks`   | Every pick made, in board order, with a positional breakdown.             |
| `syncPlayers`  | Downloads the player catalogue and caches a trimmed copy locally.         |
| `trending`     | Players most added or dropped across all Sleeper leagues.                 |
| `findPlayers`  | Searches the cached catalogue. Makes no API call.                         |

### Run the player sync first

Sleeper identifies players by opaque numeric IDs, so an un-enriched roster reads
as a list of numbers. `syncPlayers` downloads the catalogue once (~14 MB, which
it trims to ~2.5 MB) and every other method joins against the cached copy:

```bash
swamp model @dougschaefer/sleeper method run syncPlayers sleeper-nfl
```

Sleeper asks that this be pulled no more than once a day. Enrichment is
best-effort — if the catalogue has never been synced, reads still succeed and
report players by raw ID, with `playersEnriched: false` on the resource saying
so. `findPlayers` is the exception: it reads only the cache, so it fails with an
actionable error rather than returning nothing.

### Examples

```bash
# Standings, with owners and team names joined
swamp model @dougschaefer/sleeper method run rosters sleeper-nfl

# A specific week's matchups in a league other than the default
swamp model @dougschaefer/sleeper method run matchups sleeper-nfl \
  --arg leagueId=1234567890123456789 --arg week=7

# This week's waiver-wire signal
swamp model @dougschaefer/sleeper method run trending sleeper-nfl \
  --arg trend=add --arg limit=25

# Who is on the wire at tight end
swamp model @dougschaefer/sleeper method run findPlayers sleeper-nfl \
  --arg query=njoku --arg position=TE
```

Query the results with CEL rather than re-fetching:

```bash
swamp data get sleeper-nfl rosters-1234567890123456789 --json
swamp data query sleeper-nfl 'content.playersDrafted == true'
```

## Workflow

`@dougschaefer/sleeper-league-snapshot` captures a league end to end in one run:
refresh the catalogue, then read state, leagues, settings, rosters, matchups,
transactions, traded picks, the bracket, and the trend.

```bash
swamp workflow run sleeper-league-snapshot --input instance=sleeper-nfl
```

Steps run sequentially because they share one model instance and would otherwise
contend on the per-model lock. The catalogue refresh is `allowFailure: true`, so
a rate-limited sync degrades the names rather than stopping the snapshot.

## Two behaviours of the Sleeper API worth knowing

**A missing record can arrive as HTTP 200 with a `null` body.** Ask for a
username that does not exist and Sleeper answers `200 null`, not `404`. A client
that trusts the status code writes an empty record, and a typo reads as "this
user has nothing". This model raises on a `null` body from any status, so a
not-found is always an error:

```
Error: Sleeper has no record at /user/notarealuser: HTTP 200 with a null body
```

**A genuinely empty collection is a real answer.** Before a draft, rosters exist
with no players, and matchups, transactions, and draft picks all return `[]`.
That is the league's true state, so every collection resource carries an explicit
`count` and `empty`, plus a specific flag where one helps — `playersDrafted` on
rosters, `orderKnown` on a draft, `decided` on a bracket. An empty result is
never silently discarded and never reported as a failure.

The week defaults follow from the same care. Sleeper's state endpoint reports a
week within the *current* season type, so during the preseason `week: 2` means
the second preseason week. `matchups` and `transactions` fall back to week 1
outside the regular season and record why in `weekSource`.

## Rate limits

Sleeper asks callers to stay under 1000 requests per minute. Every method here
makes one to three requests, except `syncPlayers`, which makes one large one.
Transient `429` and `5xx` responses are retried with backoff, honouring
`retry-after`.

## License

MIT — see `LICENSE.txt`.
