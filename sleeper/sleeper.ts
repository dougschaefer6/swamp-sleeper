import { z } from "npm:zod@4.3.6";
import {
  avatarUrls,
  blankToUndefined,
  buildPlayerIndex,
  type DataHandle,
  type EnrichmentContext,
  fetchLeagueMembers,
  type FileContext,
  loadPlayerIndex,
  lookupPlayer,
  type MethodContext,
  num,
  ownerLabel,
  type PlayerIndexEntry,
  playerIndexInstance,
  resolveLeagueId,
  SleeperGlobalArgsSchema,
  sleeperList,
  sleeperObject,
  slugify,
  str,
  strList,
} from "./_client.ts";

/**
 * One player as reported on a roster, a starting lineup, or a transaction —
 * the shape {@link lookupPlayer} produces by joining a Sleeper player ID to the
 * cached catalogue. Fields other than `playerId` read `null` (and `name` falls
 * back to the raw ID) when the catalogue has not been synced.
 */
const PlayerRefSchema = z.object({
  playerId: z.string(),
  name: z.string(),
  position: z.string().nullable(),
  team: z.string().nullable(),
  status: z.string().nullable(),
  injuryStatus: z.string().nullable(),
});

/** A player reference plus the roster the player moved to or from. */
const PlayerMoveSchema = PlayerRefSchema.extend({ rosterId: z.number() });

/** One entry in the cached player catalogue, as returned by `findPlayers`. */
const PlayerEntrySchema = z.object({
  playerId: z.string(),
  name: z.string(),
  position: z.string().nullable(),
  team: z.string().nullable(),
  status: z.string().nullable(),
  injuryStatus: z.string().nullable(),
  fantasyPositions: z.array(z.string()),
  searchRank: z.number().nullable(),
  number: z.number().nullable(),
  active: z.boolean(),
  searchName: z.string(),
});

/**
 * `@dougschaefer/sleeper` model — reads fantasy league state from the
 * [Sleeper](https://sleeper.com) platform's public API.
 *
 * The Sleeper API is read-only and unauthenticated: there is no key to store,
 * and no endpoint that mutates a league. This model is therefore a pure
 * observer. It resolves a username to a user ID, lists that user's leagues and
 * drafts, and then reads the league in depth — settings and scoring, rosters
 * with standings, weekly matchups, the transaction log, traded picks, playoff
 * brackets, the draft board, and league-wide add/drop trends.
 *
 * Sleeper identifies managers and players by opaque numeric IDs. Left alone,
 * a roster reads as a list of numbers, so the methods here join two lookups
 * before writing: league members (fetched per call, since a league has at most
 * a few dozen) and the player catalogue (~14 MB, so `syncPlayers` caches it and
 * the other methods read the cached copy). Enrichment is best-effort — an
 * un-synced catalogue degrades names to raw IDs rather than failing the read.
 *
 * One trap shapes the error handling throughout: Sleeper answers a request for
 * a record that does not exist with **HTTP 200 and a `null` body**, not a 404.
 * The client raises on that, so a mistyped username is an error rather than an
 * empty result. A genuinely empty list is the opposite case and is preserved —
 * before a draft, rosters, matchups, and transactions are all legitimately
 * empty, and each resource records that with an explicit `count` and `empty`.
 *
 * Identity and connection facts live in `globalArguments`, so one model
 * definition is one Sleeper user in one sport.
 */
export const model = {
  type: "@dougschaefer/sleeper",
  version: "2026.08.21.1",
  globalArguments: SleeperGlobalArgsSchema,
  resources: {
    user: {
      description: "Sleeper user identity resolved from a username",
      schema: z.object({
        userId: z.string(),
        username: z.string(),
        displayName: z.string(),
        avatarId: z.string().nullable(),
        avatarUrl: z.string().nullable(),
        avatarThumbUrl: z.string().nullable(),
        isBot: z.boolean(),
        capturedAt: z.iso.datetime(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
    state: {
      description: "Current season, week, and season type for a sport",
      schema: z.object({
        sport: z.string(),
        season: z.string(),
        seasonType: z.string(),
        week: z.number(),
        displayWeek: z.number(),
        leg: z.number(),
        leagueSeason: z.string(),
        previousSeason: z.string(),
        seasonStartDate: z.string().nullable(),
        seasonHasScores: z.boolean(),
        capturedAt: z.iso.datetime(),
      }),
      lifetime: "1d",
      garbageCollection: 10,
    },
    leagueIndex: {
      description: "Every league a user belongs to in one season",
      schema: z.object({
        userId: z.string(),
        username: z.string(),
        sport: z.string(),
        season: z.string(),
        count: z.number(),
        empty: z.boolean(),
        leagues: z.array(z.object({
          leagueId: z.string(),
          name: z.string(),
          status: z.string().nullable(),
          seasonType: z.string().nullable(),
          totalRosters: z.number(),
          draftId: z.string().nullable(),
          previousLeagueId: z.string().nullable(),
          avatarUrl: z.string().nullable(),
        })),
        capturedAt: z.iso.datetime(),
      }),
      lifetime: "30d",
      garbageCollection: 10,
    },
    league: {
      description: "Full settings and scoring rules for one league",
      schema: z.object({
        leagueId: z.string(),
        name: z.string(),
        sport: z.string(),
        season: z.string(),
        seasonType: z.string().nullable(),
        status: z.string().nullable(),
        totalRosters: z.number(),
        draftId: z.string().nullable(),
        previousLeagueId: z.string().nullable(),
        avatarUrl: z.string().nullable(),
        rosterPositions: z.array(z.string()),
        starterSlots: z.array(z.string()),
        benchSlots: z.number(),
        playoffTeams: z.number(),
        playoffWeekStart: z.number(),
        waiverBudget: z.number(),
        scoringSettings: z.record(z.string(), z.number()),
        settings: z.record(z.string(), z.unknown()),
        capturedAt: z.iso.datetime(),
      }),
      lifetime: "30d",
      garbageCollection: 10,
    },
    rosters: {
      description: "Every roster in a league, with owners joined and standings",
      schema: z.object({
        leagueId: z.string(),
        count: z.number(),
        empty: z.boolean(),
        playersDrafted: z.boolean(),
        playersEnriched: z.boolean(),
        rosters: z.array(z.object({
          rosterId: z.number(),
          ownerId: z.string().nullable(),
          ownerDisplayName: z.string().nullable(),
          teamName: z.string().nullable(),
          wins: z.number(),
          losses: z.number(),
          ties: z.number(),
          fpts: z.number(),
          fptsAgainst: z.number(),
          waiverPosition: z.number(),
          waiverBudgetUsed: z.number(),
          totalMoves: z.number(),
          playerCount: z.number(),
          players: z.array(PlayerRefSchema),
          starters: z.array(PlayerRefSchema),
          reserve: z.array(z.string()),
          taxi: z.array(z.string()),
        })),
        standings: z.array(z.object({
          rank: z.number(),
          rosterId: z.number(),
          label: z.string(),
          wins: z.number(),
          losses: z.number(),
          ties: z.number(),
          fpts: z.number(),
        })),
        capturedAt: z.iso.datetime(),
      }),
      lifetime: "7d",
      garbageCollection: 10,
    },
    matchups: {
      description: "One week of matchups in a league, paired head to head",
      schema: z.object({
        leagueId: z.string(),
        week: z.number(),
        weekSource: z.string(),
        count: z.number(),
        empty: z.boolean(),
        matchups: z.array(z.object({
          matchupId: z.number().nullable(),
          teams: z.array(z.object({
            rosterId: z.number(),
            label: z.string(),
            points: z.number(),
            starterCount: z.number(),
            starters: z.array(PlayerRefSchema),
          })),
          margin: z.number().nullable(),
          leaderRosterId: z.number().nullable(),
        })),
        capturedAt: z.iso.datetime(),
      }),
      lifetime: "30d",
      garbageCollection: 20,
    },
    transactions: {
      description: "Trades, waivers, and free-agent moves for one week",
      schema: z.object({
        leagueId: z.string(),
        round: z.number(),
        roundSource: z.string(),
        count: z.number(),
        empty: z.boolean(),
        byType: z.record(z.string(), z.number()),
        transactions: z.array(z.object({
          transactionId: z.string(),
          type: z.string(),
          status: z.string().nullable(),
          created: z.string().nullable(),
          rosterIds: z.array(z.number()),
          waiverBid: z.number().nullable(),
          adds: z.array(PlayerMoveSchema),
          drops: z.array(PlayerMoveSchema),
          // Passed through unchanged: pick trades carry Sleeper's own shape.
          draftPicks: z.array(z.unknown()),
        })),
        capturedAt: z.iso.datetime(),
      }),
      lifetime: "30d",
      garbageCollection: 20,
    },
    tradedPicks: {
      description:
        "Draft picks that have changed hands, including future years",
      schema: z.object({
        leagueId: z.string(),
        count: z.number(),
        empty: z.boolean(),
        picks: z.array(z.object({
          season: z.string(),
          round: z.number(),
          originalRosterId: z.number(),
          previousOwnerId: z.number().nullable(),
          currentOwnerId: z.number().nullable(),
        })),
        capturedAt: z.iso.datetime(),
      }),
      lifetime: "30d",
      garbageCollection: 10,
    },
    bracket: {
      description: "A league's winners or losers playoff bracket",
      schema: z.object({
        leagueId: z.string(),
        bracket: z.string(),
        count: z.number(),
        empty: z.boolean(),
        rounds: z.number(),
        decided: z.boolean(),
        matches: z.array(z.object({
          matchId: z.number(),
          round: z.number(),
          placement: z.number().nullable(),
          team1: z.string().nullable(),
          team2: z.string().nullable(),
          winnerRosterId: z.number().nullable(),
          loserRosterId: z.number().nullable(),
        })),
        capturedAt: z.iso.datetime(),
      }),
      lifetime: "30d",
      garbageCollection: 10,
    },
    draftIndex: {
      description: "Drafts belonging to a league or to a user in one season",
      schema: z.object({
        scope: z.string(),
        scopeId: z.string(),
        sport: z.string(),
        count: z.number(),
        empty: z.boolean(),
        drafts: z.array(z.object({
          draftId: z.string(),
          leagueId: z.string().nullable(),
          name: z.string().nullable(),
          season: z.string().nullable(),
          status: z.string().nullable(),
          type: z.string().nullable(),
          rounds: z.number(),
          teams: z.number(),
          startTime: z.string().nullable(),
        })),
        capturedAt: z.iso.datetime(),
      }),
      lifetime: "30d",
      garbageCollection: 10,
    },
    draft: {
      description: "Format, timing, and slot mapping for one draft",
      schema: z.object({
        draftId: z.string(),
        leagueId: z.string().nullable(),
        name: z.string().nullable(),
        sport: z.string(),
        season: z.string().nullable(),
        seasonType: z.string().nullable(),
        status: z.string().nullable(),
        type: z.string().nullable(),
        scoringType: z.string().nullable(),
        rounds: z.number(),
        teams: z.number(),
        pickTimerSeconds: z.number(),
        startTime: z.string().nullable(),
        lastPicked: z.string().nullable(),
        orderKnown: z.boolean(),
        slotToRosterId: z.record(z.string(), z.number()),
        draftOrder: z.record(z.string(), z.number()),
        settings: z.record(z.string(), z.unknown()),
        capturedAt: z.iso.datetime(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    draftPicks: {
      description: "Every pick made in a draft, with player names resolved",
      schema: z.object({
        draftId: z.string(),
        count: z.number(),
        empty: z.boolean(),
        playersEnriched: z.boolean(),
        byPosition: z.record(z.string(), z.number()),
        picks: z.array(z.object({
          pickNo: z.number(),
          round: z.number(),
          draftSlot: z.number(),
          rosterId: z.number().nullable(),
          pickedBy: z.string().nullable(),
          isKeeper: z.boolean(),
          playerId: z.string(),
          name: z.string(),
          position: z.string().nullable(),
          team: z.string().nullable(),
        })),
        capturedAt: z.iso.datetime(),
      }),
      lifetime: "infinite",
      garbageCollection: 10,
    },
    playersSummary: {
      description: "Counts describing the locally cached player catalogue",
      schema: z.object({
        sport: z.string(),
        total: z.number(),
        activeCount: z.number(),
        byPosition: z.record(z.string(), z.number()),
        positionFilter: z.string().nullable(),
        activeOnly: z.boolean(),
        indexInstance: z.string(),
        sourceBytes: z.number(),
        capturedAt: z.iso.datetime(),
      }),
      lifetime: "infinite",
      garbageCollection: 5,
    },
    trending: {
      description: "Players most added or dropped across all Sleeper leagues",
      schema: z.object({
        sport: z.string(),
        trend: z.string(),
        lookbackHours: z.number(),
        count: z.number(),
        empty: z.boolean(),
        playersEnriched: z.boolean(),
        players: z.array(z.object({
          rank: z.number(),
          playerId: z.string(),
          transactionCount: z.number(),
          name: z.string(),
          position: z.string().nullable(),
          team: z.string().nullable(),
          status: z.string().nullable(),
          injuryStatus: z.string().nullable(),
        })),
        capturedAt: z.iso.datetime(),
      }),
      lifetime: "1d",
      garbageCollection: 20,
    },
    playerSearch: {
      description: "Matches from the cached player catalogue for one query",
      schema: z.object({
        sport: z.string(),
        query: z.string(),
        positionFilter: z.string().nullable(),
        teamFilter: z.string().nullable(),
        count: z.number(),
        empty: z.boolean(),
        truncated: z.boolean(),
        players: z.array(PlayerEntrySchema),
        capturedAt: z.iso.datetime(),
      }),
      lifetime: "7d",
      garbageCollection: 10,
    },
  },
  files: {
    playerIndex: {
      description:
        "Trimmed Sleeper player catalogue, cached locally for name lookups",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 2,
    },
  },
  methods: {
    user: {
      description:
        "Resolve the configured username to a Sleeper user ID and avatar. Every league and draft lookup keys off this ID, so run it first. A username that does not exist fails here rather than returning an empty result.",
      arguments: z.object({
        username: z.string().optional().describe(
          "Username to resolve instead of the model's configured username",
        ),
      }),
      execute: async (
        args: { username?: string },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const username = blankToUndefined(args.username) ?? g.username;
        const d = await sleeperObject(
          g,
          `/user/${encodeURIComponent(username)}`,
        );
        const userId = str(d.user_id);
        if (!userId) {
          throw new Error(
            `Sleeper returned a user record for '${username}' with no user_id`,
          );
        }
        const avatars = avatarUrls(g, d.avatar);
        const handle = await context.writeResource(
          "user",
          `user-${slugify(username)}`,
          {
            userId,
            username: str(d.username) ?? username,
            displayName: str(d.display_name) ?? username,
            avatarId: str(d.avatar),
            avatarUrl: avatars.avatarUrl,
            avatarThumbUrl: avatars.avatarThumbUrl,
            isBot: d.is_bot === true,
            capturedAt: new Date().toISOString(),
          },
        );
        context.logger.info("Sleeper user '{name}' resolved to ID {id}", {
          name: str(d.display_name) ?? username,
          id: userId,
        });
        return { dataHandles: [handle] };
      },
    },
    state: {
      description:
        "Read the sport's current season, week, and season type. Methods that default a week ask this endpoint, so it is also the quickest check that the API is reachable.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const d = await sleeperObject(g, `/state/${g.sport}`);
        const handle = await context.writeResource(
          "state",
          `state-${g.sport}`,
          {
            sport: g.sport,
            season: str(d.season) ?? "",
            seasonType: str(d.season_type) ?? "",
            week: num(d.week),
            displayWeek: num(d.display_week),
            leg: num(d.leg),
            leagueSeason: str(d.league_season) ?? "",
            previousSeason: str(d.previous_season) ?? "",
            seasonStartDate: str(d.season_start_date),
            seasonHasScores: d.season_has_scores === true,
            capturedAt: new Date().toISOString(),
          },
        );
        context.logger.info(
          "{sport} is in the {type} season of {season}, week {week}",
          {
            sport: g.sport.toUpperCase(),
            type: str(d.season_type) ?? "unknown",
            season: str(d.season) ?? "?",
            week: num(d.week),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    leagues: {
      description:
        "List every league the user belongs to in a season, with each league's ID, status, and draft ID. Use the returned league IDs with the league, rosters, matchups, and transactions methods.",
      arguments: z.object({
        season: z.string().optional().describe(
          "Season to list, e.g. 2026. Defaults to the sport's current season.",
        ),
        userId: z.string().optional().describe(
          "Sleeper user ID to list for, instead of the configured username",
        ),
      }),
      execute: async (
        args: { season?: string; userId?: string },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const { userId, username } = await resolveUser(
          g,
          blankToUndefined(args.userId),
        );
        const season = blankToUndefined(args.season) ??
          await currentSeason(g);
        const rows = await sleeperList(
          g,
          `/user/${userId}/leagues/${g.sport}/${season}`,
        );
        const leagues = rows.map((row) => ({
          leagueId: str(row.league_id) ?? "",
          name: str(row.name) ?? "",
          status: str(row.status),
          seasonType: str(row.season_type),
          totalRosters: num(row.total_rosters),
          draftId: str(row.draft_id),
          previousLeagueId: str(row.previous_league_id),
          avatarUrl: avatarUrls(g, row.avatar).avatarUrl,
        }));
        const handle = await context.writeResource(
          "leagueIndex",
          `leagueIndex-${userId}-${season}`,
          {
            userId,
            username,
            sport: g.sport,
            season,
            count: leagues.length,
            empty: leagues.length === 0,
            leagues,
            capturedAt: new Date().toISOString(),
          },
        );
        if (leagues.length === 0) {
          context.logger.info(
            "{username} belongs to no {sport} leagues in {season}",
            { username, sport: g.sport, season },
          );
        } else {
          context.logger.info("{n} league(s) in {season}: {names}", {
            n: leagues.length,
            season,
            names: leagues.map((l) => `${l.name} (${l.leagueId})`).join(", "),
          });
        }
        return { dataHandles: [handle] };
      },
    },
    league: {
      description:
        "Read one league's full configuration: roster slots, scoring rules, playoff structure, and waiver settings. This is the reference every scoring question resolves against.",
      arguments: z.object({
        leagueId: z.string().optional().describe(
          "League ID. Defaults to the model's defaultLeagueId.",
        ),
      }),
      execute: async (
        args: { leagueId?: string },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const leagueId = resolveLeagueId(g, args.leagueId);
        const d = await sleeperObject(g, `/league/${leagueId}`);
        const settings = (d.settings ?? {}) as Record<string, unknown>;
        const rosterPositions = strList(d.roster_positions);
        const starterSlots = rosterPositions.filter((p) => p !== "BN");
        const scoring: Record<string, number> = {};
        for (
          const [k, v] of Object.entries(
            (d.scoring_settings ?? {}) as Record<string, unknown>,
          )
        ) {
          scoring[k] = num(v);
        }
        const handle = await context.writeResource(
          "league",
          `league-${leagueId}`,
          {
            leagueId,
            name: str(d.name) ?? "",
            sport: str(d.sport) ?? g.sport,
            season: str(d.season) ?? "",
            seasonType: str(d.season_type),
            status: str(d.status),
            totalRosters: num(d.total_rosters),
            draftId: str(d.draft_id),
            previousLeagueId: str(d.previous_league_id),
            avatarUrl: avatarUrls(g, d.avatar).avatarUrl,
            rosterPositions,
            starterSlots,
            benchSlots: rosterPositions.length - starterSlots.length,
            playoffTeams: num(settings.playoff_teams),
            playoffWeekStart: num(settings.playoff_week_start),
            waiverBudget: num(settings.waiver_budget),
            scoringSettings: scoring,
            settings,
            capturedAt: new Date().toISOString(),
          },
        );
        context.logger.info(
          "League '{name}' ({status}): {teams} teams, {starters} starters + {bench} bench",
          {
            name: str(d.name) ?? leagueId,
            status: str(d.status) ?? "unknown",
            teams: num(d.total_rosters),
            starters: starterSlots.length,
            bench: rosterPositions.length - starterSlots.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    rosters: {
      description:
        "Read every roster in a league in one call, joining each to its owner's display name and team name, and deriving the standings. Before the draft the rosters exist but hold no players — that is reported as playersDrafted false, not as an error.",
      arguments: z.object({
        leagueId: z.string().optional().describe(
          "League ID. Defaults to the model's defaultLeagueId.",
        ),
      }),
      execute: async (
        args: { leagueId?: string },
        context: EnrichmentContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const leagueId = resolveLeagueId(g, args.leagueId);
        const [rows, members, index] = await Promise.all([
          sleeperList(g, `/league/${leagueId}/rosters`),
          fetchLeagueMembers(g, leagueId),
          loadPlayerIndex(context),
        ]);

        const rosters = rows.map((row) => {
          const ownerId = str(row.owner_id);
          const settings = (row.settings ?? {}) as Record<string, unknown>;
          const players = strList(row.players);
          // Sleeper pads unfilled starting slots with the sentinel "0".
          const starters = strList(row.starters).filter((p) => p !== "0");
          return {
            rosterId: num(row.roster_id),
            ownerId,
            ...ownerLabel(members, ownerId),
            wins: num(settings.wins),
            losses: num(settings.losses),
            ties: num(settings.ties),
            fpts: pointsOf(settings, "fpts"),
            fptsAgainst: pointsOf(settings, "fpts_against"),
            waiverPosition: num(settings.waiver_position),
            waiverBudgetUsed: num(settings.waiver_budget_used),
            totalMoves: num(settings.total_moves),
            playerCount: players.length,
            players: players.map((p) => lookupPlayer(index, p)),
            starters: starters.map((p) => lookupPlayer(index, p)),
            reserve: strList(row.reserve),
            taxi: strList(row.taxi),
          };
        });

        const standings = [...rosters]
          .sort((a, b) => b.wins - a.wins || b.fpts - a.fpts)
          .map((r, i) => ({
            rank: i + 1,
            rosterId: r.rosterId,
            label: r.teamName ?? r.ownerDisplayName ?? `Roster ${r.rosterId}`,
            wins: r.wins,
            losses: r.losses,
            ties: r.ties,
            fpts: r.fpts,
          }));

        const drafted = rosters.some((r) => r.playerCount > 0);
        const handle = await context.writeResource(
          "rosters",
          `rosters-${leagueId}`,
          {
            leagueId,
            count: rosters.length,
            empty: rosters.length === 0,
            playersDrafted: drafted,
            playersEnriched: index !== null,
            rosters,
            standings,
            capturedAt: new Date().toISOString(),
          },
        );
        context.logger.info(
          "{n} roster(s) in league {leagueId}; {state}",
          {
            n: rosters.length,
            leagueId,
            state: drafted
              ? `${
                rosters.reduce((s, r) => s + r.playerCount, 0)
              } players rostered`
              : "no players rostered yet (pre-draft)",
          },
        );
        return { dataHandles: [handle] };
      },
    },
    matchups: {
      description:
        "Read one week of matchups, pairing the two rosters in each and reporting the current margin. Defaults to the live week; in the preseason it defaults to week 1, since no regular-season week has been played.",
      arguments: z.object({
        leagueId: z.string().optional().describe(
          "League ID. Defaults to the model's defaultLeagueId.",
        ),
        week: z.number().int().optional().describe(
          "Regular-season week, 1-18. Defaults to the current week.",
        ),
      }),
      execute: async (
        args: { leagueId?: string; week?: number },
        context: EnrichmentContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const leagueId = resolveLeagueId(g, args.leagueId);
        const { week, source } = await resolveWeek(g, args.week);
        const [rows, members, index] = await Promise.all([
          sleeperList(g, `/league/${leagueId}/matchups/${week}`),
          fetchLeagueMembers(g, leagueId),
          loadPlayerIndex(context),
        ]);

        // Sleeper returns one row per roster, tied together by matchup_id.
        const rosterRows = await sleeperList(g, `/league/${leagueId}/rosters`);
        const ownerByRoster = new Map<number, string>();
        for (const r of rosterRows) {
          const label = ownerLabel(members, str(r.owner_id));
          ownerByRoster.set(
            num(r.roster_id),
            label.teamName ?? label.ownerDisplayName ??
              `Roster ${num(r.roster_id)}`,
          );
        }

        const grouped = new Map<string, typeof rows>();
        for (const row of rows) {
          const key = row.matchup_id === null || row.matchup_id === undefined
            ? `bye-${num(row.roster_id)}`
            : String(row.matchup_id);
          const bucket = grouped.get(key) ?? [];
          bucket.push(row);
          grouped.set(key, bucket);
        }

        const matchups = [...grouped.entries()].map(([key, bucket]) => {
          const teams = bucket.map((row) => {
            const rosterId = num(row.roster_id);
            const starters = strList(row.starters).filter((p) => p !== "0");
            return {
              rosterId,
              label: ownerByRoster.get(rosterId) ?? `Roster ${rosterId}`,
              points: num(row.points),
              starterCount: starters.length,
              starters: starters.map((p) => lookupPlayer(index, p)),
            };
          });
          const sorted = [...teams].sort((a, b) => b.points - a.points);
          return {
            matchupId: key.startsWith("bye-") ? null : Number(key),
            teams,
            margin: sorted.length === 2
              ? Math.round((sorted[0].points - sorted[1].points) * 100) / 100
              : null,
            leaderRosterId:
              sorted.length === 2 && sorted[0].points > sorted[1].points
                ? sorted[0].rosterId
                : null,
          };
        });

        const handle = await context.writeResource(
          "matchups",
          `matchups-${leagueId}-w${week}`,
          {
            leagueId,
            week,
            weekSource: source,
            count: matchups.length,
            empty: matchups.length === 0,
            matchups,
            capturedAt: new Date().toISOString(),
          },
        );
        if (matchups.length === 0) {
          context.logger.info(
            "Week {week} of league {leagueId} has no matchups yet — Sleeper returned an empty list, which before the season means the schedule is not posted",
            { week, leagueId },
          );
        } else {
          context.logger.info("{n} matchup(s) in week {week}", {
            n: matchups.length,
            week,
          });
        }
        return { dataHandles: [handle] };
      },
    },
    transactions: {
      description:
        "Read the trade, waiver, and free-agent log for one week, resolving added and dropped player IDs to names. Sleeper calls the week a 'round' on this endpoint.",
      arguments: z.object({
        leagueId: z.string().optional().describe(
          "League ID. Defaults to the model's defaultLeagueId.",
        ),
        round: z.number().int().optional().describe(
          "Week of transactions to read. Defaults to the current week.",
        ),
      }),
      execute: async (
        args: { leagueId?: string; round?: number },
        context: EnrichmentContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const leagueId = resolveLeagueId(g, args.leagueId);
        const { week: round, source } = await resolveWeek(g, args.round);
        const [rows, index] = await Promise.all([
          sleeperList(g, `/league/${leagueId}/transactions/${round}`),
          loadPlayerIndex(context),
        ]);

        const byType: Record<string, number> = {};
        const transactions = rows.map((row) => {
          const type = str(row.type) ?? "unknown";
          byType[type] = (byType[type] ?? 0) + 1;
          const settings = (row.settings ?? {}) as Record<string, unknown>;
          return {
            transactionId: str(row.transaction_id) ?? "",
            type,
            status: str(row.status),
            created: epochToIso(row.created),
            rosterIds: Array.isArray(row.roster_ids)
              ? row.roster_ids.map((r) => num(r))
              : [],
            waiverBid: settings.waiver_bid === undefined
              ? null
              : num(settings.waiver_bid),
            adds: playerMoves(row.adds, index),
            drops: playerMoves(row.drops, index),
            draftPicks: Array.isArray(row.draft_picks) ? row.draft_picks : [],
          };
        });

        const handle = await context.writeResource(
          "transactions",
          `transactions-${leagueId}-r${round}`,
          {
            leagueId,
            round,
            roundSource: source,
            count: transactions.length,
            empty: transactions.length === 0,
            byType,
            transactions,
            capturedAt: new Date().toISOString(),
          },
        );
        context.logger.info(
          transactions.length === 0
            ? "No transactions recorded in week {round} of league {leagueId}"
            : "{n} transaction(s) in week {round}: {breakdown}",
          {
            n: transactions.length,
            round,
            leagueId,
            breakdown: Object.entries(byType)
              .map(([t, c]) => `${c} ${t}`)
              .join(", "),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    tradedPicks: {
      description:
        "List every draft pick in the league that has changed hands, including picks in future seasons. Empty in a redraft league that has never traded a pick.",
      arguments: z.object({
        leagueId: z.string().optional().describe(
          "League ID. Defaults to the model's defaultLeagueId.",
        ),
      }),
      execute: async (
        args: { leagueId?: string },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const leagueId = resolveLeagueId(g, args.leagueId);
        const rows = await sleeperList(g, `/league/${leagueId}/traded_picks`);
        const picks = rows.map((row) => ({
          season: str(row.season) ?? "",
          round: num(row.round),
          originalRosterId: num(row.roster_id),
          previousOwnerId: row.previous_owner_id === null
            ? null
            : num(row.previous_owner_id),
          currentOwnerId: row.owner_id === null ? null : num(row.owner_id),
        }));
        const handle = await context.writeResource(
          "tradedPicks",
          `tradedPicks-${leagueId}`,
          {
            leagueId,
            count: picks.length,
            empty: picks.length === 0,
            picks,
            capturedAt: new Date().toISOString(),
          },
        );
        context.logger.info(
          "{n} traded pick(s) in league {leagueId}",
          { n: picks.length, leagueId },
        );
        return { dataHandles: [handle] };
      },
    },
    bracket: {
      description:
        "Read a league's playoff bracket. Sleeper publishes the bracket structure as soon as the league is created, so seeds and winners read as null until the playoffs are played.",
      arguments: z.object({
        leagueId: z.string().optional().describe(
          "League ID. Defaults to the model's defaultLeagueId.",
        ),
        bracket: z.enum(["winners", "losers"]).default("winners").describe(
          "Which bracket to read: the championship or the consolation side",
        ),
      }),
      execute: async (
        args: { leagueId?: string; bracket: "winners" | "losers" },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const leagueId = resolveLeagueId(g, args.leagueId);
        const rows = await sleeperList(
          g,
          `/league/${leagueId}/${args.bracket}_bracket`,
        );
        const matches = rows.map((row) => ({
          matchId: num(row.m),
          round: num(row.r),
          placement: row.p === undefined || row.p === null ? null : num(row.p),
          team1: bracketSlot(row.t1, row.t1_from),
          team2: bracketSlot(row.t2, row.t2_from),
          winnerRosterId: row.w === null || row.w === undefined
            ? null
            : num(row.w),
          loserRosterId: row.l === null || row.l === undefined
            ? null
            : num(row.l),
        }));
        const rounds = matches.reduce((max, m) => Math.max(max, m.round), 0);
        const decided = matches.length > 0 &&
          matches.every((m) => m.winnerRosterId !== null);
        const handle = await context.writeResource(
          "bracket",
          `bracket-${leagueId}-${args.bracket}`,
          {
            leagueId,
            bracket: args.bracket,
            count: matches.length,
            empty: matches.length === 0,
            rounds,
            decided,
            matches,
            capturedAt: new Date().toISOString(),
          },
        );
        context.logger.info(
          "{bracket} bracket: {n} match(es) across {rounds} round(s), {state}",
          {
            bracket: args.bracket,
            n: matches.length,
            rounds,
            state: decided ? "fully decided" : "not yet played",
          },
        );
        return { dataHandles: [handle] };
      },
    },
    drafts: {
      description:
        "List the drafts attached to a league, or every draft the user took part in during a season. Returns the draft IDs the draft and draftPicks methods need.",
      arguments: z.object({
        scope: z.enum(["league", "user"]).default("league").describe(
          "List a league's drafts, or all of the user's drafts in a season",
        ),
        leagueId: z.string().optional().describe(
          "League ID when scope is 'league'. Defaults to defaultLeagueId.",
        ),
        season: z.string().optional().describe(
          "Season when scope is 'user'. Defaults to the current season.",
        ),
      }),
      execute: async (
        args: { scope: "league" | "user"; leagueId?: string; season?: string },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        let path: string;
        let scopeId: string;
        if (args.scope === "league") {
          scopeId = resolveLeagueId(g, args.leagueId);
          path = `/league/${scopeId}/drafts`;
        } else {
          const { userId } = await resolveUser(g);
          const season = blankToUndefined(args.season) ??
            await currentSeason(g);
          scopeId = `${userId}-${season}`;
          path = `/user/${userId}/drafts/${g.sport}/${season}`;
        }
        const rows = await sleeperList(g, path);
        const drafts = rows.map((row) => {
          const settings = (row.settings ?? {}) as Record<string, unknown>;
          const metadata = (row.metadata ?? {}) as Record<string, unknown>;
          return {
            draftId: str(row.draft_id) ?? "",
            leagueId: str(row.league_id),
            name: str(metadata.name),
            season: str(row.season),
            status: str(row.status),
            type: str(row.type),
            rounds: num(settings.rounds),
            teams: num(settings.teams),
            startTime: epochToIso(row.start_time),
          };
        });
        const handle = await context.writeResource(
          "draftIndex",
          `draftIndex-${args.scope}-${scopeId}`,
          {
            scope: args.scope,
            scopeId,
            sport: g.sport,
            count: drafts.length,
            empty: drafts.length === 0,
            drafts,
            capturedAt: new Date().toISOString(),
          },
        );
        context.logger.info("{n} draft(s) found: {ids}", {
          n: drafts.length,
          ids: drafts.map((d) => `${d.draftId} (${d.status})`).join(", ") ||
            "none",
        });
        return { dataHandles: [handle] };
      },
    },
    draft: {
      description:
        "Read one draft's format, timing, and slot-to-roster mapping. Before a draft starts Sleeper leaves draft_order null, which is reported as orderKnown false.",
      arguments: z.object({
        draftId: z.string().describe(
          "Draft ID, as returned by the drafts or leagues method",
        ),
      }),
      execute: async (
        args: { draftId: string },
        context: MethodContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const draftId = requireArg(args.draftId, "draftId");
        const d = await sleeperObject(g, `/draft/${draftId}`);
        const settings = (d.settings ?? {}) as Record<string, unknown>;
        const metadata = (d.metadata ?? {}) as Record<string, unknown>;
        const draftOrder = numberMap(d.draft_order);
        const handle = await context.writeResource(
          "draft",
          `draft-${draftId}`,
          {
            draftId: draftId,
            leagueId: str(d.league_id),
            name: str(metadata.name),
            sport: str(d.sport) ?? g.sport,
            season: str(d.season),
            seasonType: str(d.season_type),
            status: str(d.status),
            type: str(d.type),
            scoringType: str(metadata.scoring_type),
            rounds: num(settings.rounds),
            teams: num(settings.teams),
            pickTimerSeconds: num(settings.pick_timer),
            startTime: epochToIso(d.start_time),
            lastPicked: epochToIso(d.last_picked),
            orderKnown: Object.keys(draftOrder).length > 0,
            slotToRosterId: numberMap(d.slot_to_roster_id),
            draftOrder,
            settings,
            capturedAt: new Date().toISOString(),
          },
        );
        context.logger.info(
          "Draft {id}: {type}, {rounds} rounds x {teams} teams, status {status}; draft order {order}",
          {
            id: draftId,
            type: str(d.type) ?? "unknown",
            rounds: num(settings.rounds),
            teams: num(settings.teams),
            status: str(d.status) ?? "unknown",
            order: Object.keys(draftOrder).length > 0 ? "set" : "not yet set",
          },
        );
        return { dataHandles: [handle] };
      },
    },
    draftPicks: {
      description:
        "Read every pick made in a draft, in order, with player names and positions resolved and a positional breakdown. An un-started draft returns zero picks, reported as empty.",
      arguments: z.object({
        draftId: z.string().describe(
          "Draft ID, as returned by the drafts or leagues method",
        ),
      }),
      execute: async (
        args: { draftId: string },
        context: EnrichmentContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const draftId = requireArg(args.draftId, "draftId");
        const [rows, index] = await Promise.all([
          sleeperList(g, `/draft/${draftId}/picks`),
          loadPlayerIndex(context),
        ]);
        const byPosition: Record<string, number> = {};
        const picks = rows.map((row) => {
          const playerId = str(row.player_id) ?? "";
          const metadata = (row.metadata ?? {}) as Record<string, unknown>;
          const looked = lookupPlayer(index, playerId);
          // Sleeper embeds name and position on each pick, which is the more
          // reliable source when the cached catalogue is stale or missing.
          const embeddedName = [
            str(metadata.first_name),
            str(metadata.last_name),
          ]
            .filter(Boolean).join(" ");
          const position = str(metadata.position) ?? looked.position;
          if (position) byPosition[position] = (byPosition[position] ?? 0) + 1;
          return {
            pickNo: num(row.pick_no),
            round: num(row.round),
            draftSlot: num(row.draft_slot),
            rosterId: row.roster_id === null || row.roster_id === undefined
              ? null
              : num(row.roster_id),
            pickedBy: str(row.picked_by),
            isKeeper: row.is_keeper === true,
            playerId,
            name: embeddedName || looked.name,
            position,
            team: str(metadata.team) ?? looked.team,
          };
        });
        picks.sort((a, b) => a.pickNo - b.pickNo);
        const handle = await context.writeResource(
          "draftPicks",
          `draftPicks-${draftId}`,
          {
            draftId: draftId,
            count: picks.length,
            empty: picks.length === 0,
            playersEnriched: index !== null,
            byPosition,
            picks,
            capturedAt: new Date().toISOString(),
          },
        );
        context.logger.info(
          picks.length === 0
            ? "Draft {id} has no picks yet — it has not started"
            : "{n} pick(s) in draft {id}: {breakdown}",
          {
            n: picks.length,
            id: draftId,
            breakdown: Object.entries(byPosition)
              .map(([p, c]) => `${c} ${p}`)
              .join(", "),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    syncPlayers: {
      description:
        "Download the Sleeper player catalogue and cache a trimmed copy locally, so roster, draft, and trending reads can resolve player IDs to names. The full payload is ~14 MB and Sleeper asks that it be fetched no more than once a day.",
      arguments: z.object({
        position: z.string().optional().describe(
          "Fetch only one position, e.g. TE. Narrows the download considerably.",
        ),
        activeOnly: z.boolean().default(false).describe(
          "Ask Sleeper for active players only",
        ),
      }),
      execute: async (
        args: { position?: string; activeOnly: boolean },
        context: FileContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const query: Record<string, string> = {};
        const positionFilter = blankToUndefined(args.position);
        if (positionFilter) query.position = positionFilter;
        if (args.activeOnly) query.active = "true";
        context.logger.info(
          "Downloading the {sport} player catalogue from Sleeper — this is the one large request this model makes",
          { sport: g.sport },
        );
        const raw = await sleeperObject(g, `/players/${g.sport}`, { query });
        const index = buildPlayerIndex(raw);
        const entries = Object.values(index);

        const byPosition: Record<string, number> = {};
        let activeCount = 0;
        for (const p of entries) {
          if (p.position) {
            byPosition[p.position] = (byPosition[p.position] ?? 0) + 1;
          }
          if (p.active) activeCount++;
        }

        const serialized = JSON.stringify(index);
        const writer = context.createFileWriter(
          "playerIndex",
          playerIndexInstance(g.sport),
        );
        const fileHandle = await writer.writeText(serialized);

        const summaryHandle = await context.writeResource(
          "playersSummary",
          `playersSummary-${g.sport}`,
          {
            sport: g.sport,
            total: entries.length,
            activeCount,
            byPosition,
            positionFilter: positionFilter ?? null,
            activeOnly: args.activeOnly,
            indexInstance: playerIndexInstance(g.sport),
            sourceBytes: serialized.length,
            capturedAt: new Date().toISOString(),
          },
        );
        context.logger.info(
          "Cached {n} {sport} players ({active} active) as {bytes} KB; other methods will now resolve names",
          {
            n: entries.length,
            sport: g.sport,
            active: activeCount,
            bytes: Math.round(serialized.length / 1024),
          },
        );
        return { dataHandles: [fileHandle, summaryHandle] };
      },
    },
    trending: {
      description:
        "Read the players most added or dropped across every Sleeper league in a lookback window — the platform's waiver-wire signal. Names are resolved from the cached catalogue when syncPlayers has been run.",
      arguments: z.object({
        trend: z.enum(["add", "drop"]).default("add").describe(
          "Whether to read the most-added or most-dropped players",
        ),
        lookbackHours: z.number().int().default(24).describe(
          "Size of the lookback window in hours",
        ),
        limit: z.number().int().default(25).describe(
          "Maximum number of players to return",
        ),
      }),
      execute: async (
        args: { trend: "add" | "drop"; lookbackHours: number; limit: number },
        context: EnrichmentContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const [rows, index] = await Promise.all([
          sleeperList(g, `/players/${g.sport}/trending/${args.trend}`, {
            query: {
              lookback_hours: String(args.lookbackHours),
              limit: String(args.limit),
            },
          }),
          loadPlayerIndex(context),
        ]);
        const players = rows.map((row, i) => {
          const playerId = str(row.player_id) ?? "";
          const looked = lookupPlayer(index, playerId);
          return {
            rank: i + 1,
            playerId,
            transactionCount: num(row.count),
            name: looked.name,
            position: looked.position,
            team: looked.team,
            status: looked.status,
            injuryStatus: looked.injuryStatus,
          };
        });
        const handle = await context.writeResource(
          "trending",
          `trending-${g.sport}-${args.trend}`,
          {
            sport: g.sport,
            trend: args.trend,
            lookbackHours: args.lookbackHours,
            count: players.length,
            empty: players.length === 0,
            playersEnriched: index !== null,
            players,
            capturedAt: new Date().toISOString(),
          },
        );
        if (index === null) {
          context.logger.info(
            "No cached player catalogue, so trending players are listed by ID only — run syncPlayers to resolve names",
          );
        }
        context.logger.info(
          "Top {trend}s over {hours}h: {top}",
          {
            trend: args.trend,
            hours: args.lookbackHours,
            top: players.slice(0, 5)
              .map((p) => `${p.name} (${p.transactionCount})`)
              .join(", ") || "none",
          },
        );
        return { dataHandles: [handle] };
      },
    },
    findPlayers: {
      description:
        "Search the locally cached player catalogue by name, optionally narrowed to a position or NFL team. Reads the copy syncPlayers stored and makes no API call, so it costs nothing against Sleeper's rate limit.",
      arguments: z.object({
        query: z.string().describe(
          "Name fragment to match, e.g. 'jefferson'. Case and punctuation are ignored.",
        ),
        position: z.string().optional().describe(
          "Restrict to one position, e.g. WR",
        ),
        team: z.string().optional().describe(
          "Restrict to one NFL team abbreviation, e.g. MIN",
        ),
        limit: z.number().int().default(25).describe(
          "Maximum number of matches to return",
        ),
      }),
      execute: async (
        args: {
          query: string;
          position?: string;
          team?: string;
          limit: number;
        },
        context: EnrichmentContext,
      ): Promise<{ dataHandles: DataHandle[] }> => {
        const g = context.globalArgs;
        const index = await loadPlayerIndex(context);
        if (index === null) {
          throw new Error(
            "No cached player catalogue to search. Run the syncPlayers method " +
              "first — findPlayers reads the local copy and never calls Sleeper.",
          );
        }
        const needle = args.query.toLowerCase().replace(/[^a-z0-9]/g, "");
        const position = blankToUndefined(args.position)?.toUpperCase();
        const team = blankToUndefined(args.team)?.toUpperCase();
        const matches = Object.values(index)
          .filter((p: PlayerIndexEntry) => {
            if (!p.searchName.includes(needle)) return false;
            if (position && p.position !== position) return false;
            if (team && p.team !== team) return false;
            return true;
          })
          .sort((a, b) => (a.searchRank ?? 1e9) - (b.searchRank ?? 1e9));
        const limited = matches.slice(0, Math.max(1, args.limit));
        const handle = await context.writeResource(
          "playerSearch",
          `playerSearch-${
            slugify(
              [args.query, position ?? "", team ?? ""].join("-"),
            )
          }`,
          {
            sport: g.sport,
            query: args.query,
            positionFilter: position ?? null,
            teamFilter: team ?? null,
            count: limited.length,
            empty: limited.length === 0,
            truncated: matches.length > limited.length,
            players: limited,
            capturedAt: new Date().toISOString(),
          },
        );
        context.logger.info(
          "{n} of {total} cached players match '{query}': {names}",
          {
            n: limited.length,
            total: matches.length,
            query: args.query,
            names: limited.slice(0, 5)
              .map((p) => `${p.name} ${p.position ?? "?"}/${p.team ?? "FA"}`)
              .join(", ") || "none",
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};

/**
 * Require a non-blank value for an argument the method cannot default. Zod
 * accepts `""` for a required string, and a blank ID would otherwise be sent to
 * Sleeper as a malformed path.
 */
function requireArg(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`The '${name}' argument is required and cannot be blank`);
  }
  return trimmed;
}

/** Read a points field that Sleeper splits into whole and decimal halves. */
function pointsOf(settings: Record<string, unknown>, key: string): number {
  const whole = num(settings[key]);
  const decimal = num(settings[`${key}_decimal`]);
  return Math.round((whole + decimal / 100) * 100) / 100;
}

/** Convert a Sleeper epoch-milliseconds timestamp to ISO-8601, or `null`. */
function epochToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value).toISOString();
}

/** Coerce a Sleeper `{ key: number }` map, tolerating a null or missing field. */
function numberMap(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = num(v);
  }
  return out;
}

/**
 * Expand a transaction's `adds`/`drops` map — `{ player_id: roster_id }` — into
 * named records. Sleeper sends `null` rather than `{}` when nothing moved.
 */
function playerMoves(
  value: unknown,
  index: Parameters<typeof lookupPlayer>[0],
): Array<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).map((
    [playerId, rosterId],
  ) => ({
    ...lookupPlayer(index, playerId),
    rosterId: num(rosterId),
  }));
}

/**
 * Describe one side of a bracket match. Sleeper gives either a seeded roster ID
 * or, for a slot still waiting on an earlier result, a `{ w: n }` / `{ l: n }`
 * pointer at the match that feeds it.
 */
function bracketSlot(team: unknown, from: unknown): string | null {
  if (typeof team === "number") return `roster ${team}`;
  if (typeof from === "object" && from !== null) {
    const f = from as Record<string, unknown>;
    if (f.w !== undefined) return `winner of match ${num(f.w)}`;
    if (f.l !== undefined) return `loser of match ${num(f.l)}`;
  }
  return null;
}

/** Resolve the configured (or supplied) user to an ID and display name. */
async function resolveUser(
  g: z.infer<typeof SleeperGlobalArgsSchema>,
  userId?: string,
): Promise<{ userId: string; username: string }> {
  if (userId) {
    const d = await sleeperObject(g, `/user/${userId}`);
    return {
      userId,
      username: str(d.display_name) ?? str(d.username) ?? userId,
    };
  }
  const d = await sleeperObject(
    g,
    `/user/${encodeURIComponent(g.username)}`,
  );
  const resolved = str(d.user_id);
  if (!resolved) {
    throw new Error(
      `Sleeper returned no user_id for username '${g.username}'`,
    );
  }
  return { userId: resolved, username: str(d.display_name) ?? g.username };
}

/** Read the sport's current season from Sleeper's state endpoint. */
async function currentSeason(
  g: z.infer<typeof SleeperGlobalArgsSchema>,
): Promise<string> {
  const d = await sleeperObject(g, `/state/${g.sport}`);
  const season = str(d.season);
  if (!season) {
    throw new Error(`Sleeper state for ${g.sport} carries no season`);
  }
  return season;
}

/**
 * Choose the week a matchup or transaction read should target.
 *
 * The state endpoint reports a week within the *current* season type, so during
 * the preseason `week: 2` means the second preseason week — asking for regular
 * season week 2 would silently read a week that has not happened. Outside the
 * regular season this falls back to week 1 and says so in `weekSource`.
 */
async function resolveWeek(
  g: z.infer<typeof SleeperGlobalArgsSchema>,
  week?: number,
): Promise<{ week: number; source: string }> {
  if (week !== undefined) return { week, source: "argument" };
  const d = await sleeperObject(g, `/state/${g.sport}`);
  const seasonType = str(d.season_type) ?? "";
  if (seasonType !== "regular" && seasonType !== "post") {
    return { week: 1, source: `defaulted to week 1 (${seasonType} season)` };
  }
  return { week: num(d.week), source: `current ${seasonType} week` };
}
