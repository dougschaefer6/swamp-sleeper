import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  avatarUrls,
  blankToUndefined,
  buildPlayerIndex,
  type DataHandle,
  type EnrichmentContext,
  type FileContext,
  lookupPlayer,
  type MethodContext,
  playerIndexInstance,
  resolveLeagueId,
  sleeperList,
  sleeperObject,
  type SleeperGlobalArgs,
  SleeperNotFoundError,
  sleeperRequest,
  slugify,
} from "./_client.ts";
import { model } from "./sleeper.ts";

const g: SleeperGlobalArgs = {
  username: "jdoe",
  sport: "nfl",
  defaultLeagueId: "1234567890123456789",
  baseUrl: "https://api.sleeper.app/v1",
  cdnUrl: "https://sleepercdn.com",
  timeoutMs: 5000,
};

/** Swap `globalThis.fetch` for a stub; returns a restore function. */
function mockFetch(
  handler: (url: string) => { status: number; body: string },
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const { status, body } = handler(url);
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Recorded `writeResource` and file-writer calls from a fake context. */
interface Recorded {
  writes: Array<{ spec: string; name: string; data: Record<string, unknown> }>;
  files: Array<{ spec: string; name: string; text: string }>;
  logs: string[];
}

/**
 * A fake method context. `playerIndex` seeds the cached catalogue that
 * enrichment reads; pass `null` to simulate a catalogue that was never synced.
 */
function fakeContext(
  playerIndex: Record<string, unknown> | null = null,
): { ctx: EnrichmentContext & FileContext; rec: Recorded } {
  const rec: Recorded = { writes: [], files: [], logs: [] };
  const ctx: EnrichmentContext & FileContext = {
    globalArgs: g,
    logger: {
      info: (msg: string) => rec.logs.push(msg),
      warning: (msg: string) => rec.logs.push(msg),
    },
    writeResource: (spec, name, data): Promise<DataHandle> => {
      rec.writes.push({ spec, name, data });
      return Promise.resolve({ name, specName: spec });
    },
    createFileWriter: (spec, name) => ({
      writeText: (text: string): Promise<DataHandle> => {
        rec.files.push({ spec, name, text });
        return Promise.resolve({ name, specName: spec });
      },
    }),
    dataRepository: {
      getContent: (): Promise<Uint8Array | null> =>
        Promise.resolve(
          playerIndex === null
            ? null
            : new TextEncoder().encode(JSON.stringify(playerIndex)),
        ),
    },
    modelType: "@dougschaefer/sleeper",
    modelId: "test-model-id",
  };
  return { ctx, rec };
}

// deno-lint-ignore no-explicit-any
const methods = model.methods as Record<string, any>;

Deno.test("model exposes every documented Sleeper read as a method", () => {
  assertEquals(model.type, "@dougschaefer/sleeper");
  for (
    const m of [
      "user",
      "state",
      "leagues",
      "league",
      "rosters",
      "matchups",
      "transactions",
      "tradedPicks",
      "bracket",
      "drafts",
      "draft",
      "draftPicks",
      "syncPlayers",
      "trending",
      "findPlayers",
    ]
  ) {
    assert(m in methods, `missing method ${m}`);
  }
});

Deno.test("a 200 with a null body is a not-found, not empty data", async () => {
  const restore = mockFetch(() => ({ status: 200, body: "null" }));
  try {
    const err = await assertRejects(
      () => sleeperRequest(g, "/user/nobody"),
      SleeperNotFoundError,
    );
    assert(
      err.message.includes("null body"),
      "the error should name the null-body case so the trap is obvious",
    );
  } finally {
    restore();
  }
});

Deno.test("a 404 is a not-found too", async () => {
  const restore = mockFetch(() => ({ status: 404, body: "null" }));
  try {
    await assertRejects(
      () => sleeperRequest(g, "/league/0"),
      SleeperNotFoundError,
    );
  } finally {
    restore();
  }
});

Deno.test("an empty list is a real answer and is returned as-is", async () => {
  const restore = mockFetch(() => ({ status: 200, body: "[]" }));
  try {
    assertEquals(await sleeperList(g, "/league/1/matchups/1"), []);
  } finally {
    restore();
  }
});

Deno.test("a transient 5xx is retried before it is surfaced", async () => {
  let calls = 0;
  const restore = mockFetch(() => {
    calls++;
    return calls < 3
      ? { status: 503, body: "unavailable" }
      : { status: 200, body: '{"ok":true}' };
  });
  try {
    const d = await sleeperObject(g, "/state/nfl");
    assertEquals(d.ok, true);
    assertEquals(calls, 3);
  } finally {
    restore();
  }
});

Deno.test("a list route that answers with an object is rejected", async () => {
  const restore = mockFetch(() => ({ status: 200, body: '{"not":"a list"}' }));
  try {
    await assertRejects(() => sleeperList(g, "/league/1/rosters"), Error);
  } finally {
    restore();
  }
});

Deno.test("blank arguments fall back instead of being sent to Sleeper", () => {
  assertEquals(blankToUndefined(""), undefined);
  assertEquals(blankToUndefined("   "), undefined);
  assertEquals(blankToUndefined("1389"), "1389");
  // A workflow input defaulting to "" must not suppress defaultLeagueId.
  assertEquals(resolveLeagueId(g, ""), "1234567890123456789");
  assertEquals(resolveLeagueId(g, "999"), "999");
});

Deno.test("a missing league is named as an actionable error", () => {
  let threw = false;
  try {
    resolveLeagueId({ ...g, defaultLeagueId: undefined }, undefined);
  } catch (err) {
    threw = true;
    assert((err as Error).message.includes("defaultLeagueId"));
  }
  assert(threw, "resolveLeagueId should throw when no league can be resolved");
});

Deno.test("avatar IDs become CDN URLs, and a null avatar stays null", () => {
  assertEquals(avatarUrls(g, "abc123"), {
    avatarUrl: "https://sleepercdn.com/avatars/abc123",
    avatarThumbUrl: "https://sleepercdn.com/avatars/thumbs/abc123",
  });
  assertEquals(avatarUrls(g, null), {
    avatarUrl: null,
    avatarThumbUrl: null,
  });
});

Deno.test("the player index keeps fantasy fields and drops the rest", () => {
  const index = buildPlayerIndex({
    "6794": {
      first_name: "Justin",
      last_name: "Jefferson",
      position: "WR",
      team: "MIN",
      status: "Active",
      active: true,
      search_full_name: "justinjefferson",
      search_rank: 2,
      number: 18,
      fantasy_positions: ["WR"],
      // Fields the model never reads and the index must not carry.
      sportradar_id: "x",
      high_school: "Destrehan",
      practice_description: null,
    },
    "MIN": { first_name: "Minnesota", last_name: "Vikings", position: "DEF" },
  });
  assertEquals(index["6794"].name, "Justin Jefferson");
  assertEquals(index["6794"].position, "WR");
  assertEquals(index["6794"].searchName, "justinjefferson");
  assert(!("high_school" in index["6794"]), "biographical fields are dropped");
  // Team defences are keyed by abbreviation and still get a usable name.
  assertEquals(index["MIN"].name, "Minnesota Vikings");
});

Deno.test("an unknown player degrades to its raw ID rather than failing", () => {
  const index = buildPlayerIndex({
    "6794": { first_name: "Justin", last_name: "Jefferson", position: "WR" },
  });
  assertEquals(lookupPlayer(index, "6794").name, "Justin Jefferson");
  assertEquals(lookupPlayer(index, "9999").name, "9999");
  assertEquals(lookupPlayer(null, "6794").name, "6794");
});

Deno.test("slugify keeps instance names filesystem-safe", () => {
  assertEquals(slugify("Justin Jefferson"), "justin-jefferson");
  assertEquals(slugify("--WR--"), "wr");
  assertEquals(slugify(""), "all");
});

Deno.test("rosters joins owners, derives standings, and flags a pre-draft league", async () => {
  const restore = mockFetch((url) => {
    if (url.includes("/users")) {
      return {
        status: 200,
        body: JSON.stringify([
          {
            user_id: "u1",
            display_name: "firstmanager",
            metadata: { team_name: "Team One" },
          },
          { user_id: "u2", display_name: "secondmanager", metadata: {} },
        ]),
      };
    }
    return {
      status: 200,
      body: JSON.stringify([
        {
          roster_id: 1,
          owner_id: "u1",
          players: [],
          starters: ["0", "0"],
          settings: { wins: 0, losses: 0, fpts: 0 },
        },
        {
          roster_id: 2,
          owner_id: "u2",
          players: ["6794"],
          starters: ["6794", "0"],
          settings: { wins: 2, losses: 0, fpts: 210, fpts_decimal: 45 },
        },
      ]),
    };
  });
  const { ctx, rec } = fakeContext({
    "6794": {
      playerId: "6794",
      name: "Justin Jefferson",
      position: "WR",
      team: "MIN",
      status: "Active",
      injuryStatus: null,
      fantasyPositions: ["WR"],
      searchRank: 2,
      number: 18,
      active: true,
      searchName: "justinjefferson",
    },
  });
  try {
    await methods.rosters.execute({ leagueId: "L1" }, ctx);
  } finally {
    restore();
  }

  assertEquals(rec.writes.length, 1);
  const data = rec.writes[0].data;
  assertEquals(rec.writes[0].spec, "rosters");
  assertEquals(rec.writes[0].name, "rosters-L1");
  assertEquals(data.count, 2);
  assertEquals(data.playersEnriched, true);
  assertEquals(data.playersDrafted, true);

  const rosters = data.rosters as Array<Record<string, unknown>>;
  assertEquals(rosters[0].teamName, "Team One");
  assertEquals(rosters[1].ownerDisplayName, "secondmanager");
  // Sleeper splits points across whole and decimal fields.
  assertEquals(rosters[1].fpts, 210.45);
  // The "0" sentinel for an unfilled starting slot is not a player.
  assertEquals((rosters[1].starters as unknown[]).length, 1);
  assertEquals((rosters[0].starters as unknown[]).length, 0);

  const standings = data.standings as Array<Record<string, unknown>>;
  assertEquals(standings[0].rosterId, 2);
  assertEquals(standings[0].label, "secondmanager");
  assertEquals(standings[1].rank, 2);
});

Deno.test("an empty roster list is recorded as empty, not as a failure", async () => {
  const restore = mockFetch(() => ({ status: 200, body: "[]" }));
  const { ctx, rec } = fakeContext();
  try {
    await methods.rosters.execute({ leagueId: "L1" }, ctx);
  } finally {
    restore();
  }
  assertEquals(rec.writes[0].data.empty, true);
  assertEquals(rec.writes[0].data.count, 0);
  assertEquals(rec.writes[0].data.playersDrafted, false);
  assertEquals(rec.writes[0].data.playersEnriched, false);
});

Deno.test("matchups pair rosters by matchup_id and report the margin", async () => {
  const restore = mockFetch((url) => {
    if (url.includes("/matchups/")) {
      return {
        status: 200,
        body: JSON.stringify([
          { roster_id: 1, matchup_id: 1, points: 101.5, starters: ["6794"] },
          { roster_id: 2, matchup_id: 1, points: 88.25, starters: ["0"] },
          { roster_id: 3, matchup_id: null, points: 70, starters: [] },
        ]),
      };
    }
    if (url.includes("/users")) {
      return {
        status: 200,
        body: JSON.stringify([{ user_id: "u1", display_name: "secondmanager" }]),
      };
    }
    return {
      status: 200,
      body: JSON.stringify([{ roster_id: 1, owner_id: "u1" }]),
    };
  });
  const { ctx, rec } = fakeContext();
  try {
    await methods.matchups.execute({ leagueId: "L1", week: 3 }, ctx);
  } finally {
    restore();
  }

  const data = rec.writes[0].data;
  assertEquals(rec.writes[0].name, "matchups-L1-w3");
  assertEquals(data.week, 3);
  assertEquals(data.weekSource, "argument");
  const matchups = data.matchups as Array<Record<string, unknown>>;
  assertEquals(matchups.length, 2);
  assertEquals(matchups[0].margin, 13.25);
  assertEquals(matchups[0].leaderRosterId, 1);
  assertEquals((matchups[0].teams as unknown[]).length, 2);
  // A roster with no matchup_id is on a bye and has no margin.
  assertEquals(matchups[1].matchupId, null);
  assertEquals(matchups[1].margin, null);
});

Deno.test("the preseason defaults to week 1 rather than the preseason week", async () => {
  const restore = mockFetch((url) => {
    if (url.includes("/state/")) {
      return {
        status: 200,
        body: JSON.stringify({ week: 2, season_type: "pre", season: "2026" }),
      };
    }
    if (url.includes("/transactions/")) return { status: 200, body: "[]" };
    return { status: 200, body: "[]" };
  });
  const { ctx, rec } = fakeContext();
  try {
    await methods.transactions.execute({ leagueId: "L1" }, ctx);
  } finally {
    restore();
  }
  assertEquals(rec.writes[0].data.round, 1);
  assert(
    String(rec.writes[0].data.roundSource).includes("pre"),
    "the resource should say why week 1 was chosen",
  );
});

Deno.test("transactions expand add/drop maps and tally by type", async () => {
  const restore = mockFetch((url) => {
    if (url.includes("/state/")) {
      return {
        status: 200,
        body: JSON.stringify({ week: 5, season_type: "regular" }),
      };
    }
    return {
      status: 200,
      body: JSON.stringify([
        {
          transaction_id: "t1",
          type: "waiver",
          status: "complete",
          created: 1787338561279,
          roster_ids: [2],
          settings: { waiver_bid: 17 },
          adds: { "6794": 2 },
          drops: null,
        },
        {
          transaction_id: "t2",
          type: "trade",
          status: "complete",
          created: null,
          roster_ids: [1, 3],
          adds: null,
          drops: null,
          draft_picks: [{ season: "2027", round: 1 }],
        },
      ]),
    };
  });
  const { ctx, rec } = fakeContext();
  try {
    await methods.transactions.execute({ leagueId: "L1" }, ctx);
  } finally {
    restore();
  }

  const data = rec.writes[0].data;
  assertEquals(data.round, 5);
  assertEquals(data.byType, { waiver: 1, trade: 1 });
  const txns = data.transactions as Array<Record<string, unknown>>;
  assertEquals(txns[0].waiverBid, 17);
  assertEquals((txns[0].adds as unknown[]).length, 1);
  // Sleeper sends null rather than {} when nothing moved.
  assertEquals(txns[0].drops, []);
  assertEquals(txns[1].waiverBid, null);
  // Epoch milliseconds become ISO-8601; a null timestamp stays null.
  assertEquals(txns[0].created, new Date(1787338561279).toISOString());
  assertEquals(txns[1].created, null);
});

Deno.test("a bracket slot names the match it is waiting on", async () => {
  const restore = mockFetch(() => ({
    status: 200,
    body: JSON.stringify([
      { m: 1, r: 1, t1: 11, t2: 7, w: null, l: null },
      { m: 3, r: 2, t1: 8, t2: null, t2_from: { w: 1 }, w: null, l: null },
      { p: 5, m: 5, r: 2, t1: null, t1_from: { l: 1 }, w: null, l: null },
    ]),
  }));
  const { ctx, rec } = fakeContext();
  try {
    await methods.bracket.execute(
      { leagueId: "L1", bracket: "winners" },
      ctx,
    );
  } finally {
    restore();
  }

  const data = rec.writes[0].data;
  assertEquals(rec.writes[0].name, "bracket-L1-winners");
  assertEquals(data.rounds, 2);
  // Structure exists long before the playoffs are played.
  assertEquals(data.decided, false);
  const matches = data.matches as Array<Record<string, unknown>>;
  assertEquals(matches[0].team1, "roster 11");
  assertEquals(matches[1].team2, "winner of match 1");
  assertEquals(matches[2].team1, "loser of match 1");
  assertEquals(matches[2].placement, 5);
});

Deno.test("draft picks prefer Sleeper's embedded names over the cache", async () => {
  const restore = mockFetch(() => ({
    status: 200,
    body: JSON.stringify([
      {
        pick_no: 2,
        round: 1,
        draft_slot: 2,
        roster_id: 2,
        picked_by: "u2",
        player_id: "6794",
        is_keeper: null,
        metadata: {
          first_name: "Justin",
          last_name: "Jefferson",
          position: "WR",
          team: "MIN",
        },
      },
      {
        pick_no: 1,
        round: 1,
        draft_slot: 1,
        roster_id: 1,
        player_id: "4034",
        metadata: { first_name: "Christian", last_name: "McCaffrey", position: "RB" },
      },
    ]),
  }));
  const { ctx, rec } = fakeContext();
  try {
    await methods.draftPicks.execute({ draftId: "D1" }, ctx);
  } finally {
    restore();
  }

  const data = rec.writes[0].data;
  assertEquals(data.count, 2);
  assertEquals(data.byPosition, { WR: 1, RB: 1 });
  const picks = data.picks as Array<Record<string, unknown>>;
  // Picks are returned in board order regardless of API ordering.
  assertEquals(picks[0].pickNo, 1);
  assertEquals(picks[0].name, "Christian McCaffrey");
  // Names resolve from the pick metadata even with no cached catalogue.
  assertEquals(picks[1].name, "Justin Jefferson");
  assertEquals(picks[1].isKeeper, false);
});

Deno.test("an un-started draft reports zero picks as empty", async () => {
  const restore = mockFetch(() => ({ status: 200, body: "[]" }));
  const { ctx, rec } = fakeContext();
  try {
    await methods.draftPicks.execute({ draftId: "D1" }, ctx);
  } finally {
    restore();
  }
  assertEquals(rec.writes[0].data.empty, true);
  assertEquals(rec.writes[0].data.count, 0);
});

Deno.test("a draft with no order set reports orderKnown false", async () => {
  const restore = mockFetch(() => ({
    status: 200,
    body: JSON.stringify({
      draft_id: "D1",
      league_id: "L1",
      status: "pre_draft",
      type: "snake",
      draft_order: null,
      slot_to_roster_id: { "1": 1, "2": 2 },
      settings: { rounds: 14, teams: 12, pick_timer: 120 },
      metadata: { name: "Example League", scoring_type: "ppr" },
    }),
  }));
  const { ctx, rec } = fakeContext();
  try {
    await methods.draft.execute({ draftId: "D1" }, ctx);
  } finally {
    restore();
  }
  const data = rec.writes[0].data;
  assertEquals(data.orderKnown, false);
  assertEquals(data.draftOrder, {});
  assertEquals(data.slotToRosterId, { "1": 1, "2": 2 });
  assertEquals(data.scoringType, "ppr");
  assertEquals(data.pickTimerSeconds, 120);
});

Deno.test("a blank required ID is refused before it reaches Sleeper", async () => {
  const { ctx } = fakeContext();
  await assertRejects(
    () => methods.draft.execute({ draftId: "  " }, ctx),
    Error,
    "cannot be blank",
  );
});

Deno.test("syncPlayers caches a trimmed catalogue and summarises it", async () => {
  const restore = mockFetch(() => ({
    status: 200,
    body: JSON.stringify({
      "6794": {
        first_name: "Justin",
        last_name: "Jefferson",
        position: "WR",
        active: true,
      },
      "99": { first_name: "Retired", last_name: "Guy", position: "RB", active: false },
    }),
  }));
  const { ctx, rec } = fakeContext();
  try {
    await methods.syncPlayers.execute({ activeOnly: false }, ctx);
  } finally {
    restore();
  }

  assertEquals(rec.files.length, 1);
  assertEquals(rec.files[0].spec, "playerIndex");
  assertEquals(rec.files[0].name, playerIndexInstance("nfl"));
  const cached = JSON.parse(rec.files[0].text);
  assertEquals(cached["6794"].name, "Justin Jefferson");

  const summary = rec.writes[0].data;
  assertEquals(summary.total, 2);
  assertEquals(summary.activeCount, 1);
  assertEquals(summary.byPosition, { WR: 1, RB: 1 });
  assertEquals(summary.indexInstance, "playerIndex-nfl");
});

Deno.test("trending says so when it has no catalogue to resolve names from", async () => {
  const restore = mockFetch(() => ({
    status: 200,
    body: JSON.stringify([{ player_id: "6794", count: 84007 }]),
  }));
  const { ctx, rec } = fakeContext(null);
  try {
    await methods.trending.execute(
      { trend: "add", lookbackHours: 24, limit: 25 },
      ctx,
    );
  } finally {
    restore();
  }
  const data = rec.writes[0].data;
  assertEquals(data.playersEnriched, false);
  const players = data.players as Array<Record<string, unknown>>;
  assertEquals(players[0].name, "6794");
  assert(
    rec.logs.some((l) => l.includes("syncPlayers")),
    "the user must be told at info level why names are missing",
  );
});

Deno.test("findPlayers ranks by popularity and reports truncation", async () => {
  const { ctx, rec } = fakeContext({
    "1": {
      playerId: "1",
      name: "Justin Jefferson",
      position: "WR",
      team: "MIN",
      status: "Active",
      injuryStatus: null,
      fantasyPositions: ["WR"],
      searchRank: 2,
      number: 18,
      active: true,
      searchName: "justinjefferson",
    },
    "2": {
      playerId: "2",
      name: "Van Jefferson",
      position: "WR",
      team: "WAS",
      status: "Active",
      injuryStatus: null,
      fantasyPositions: ["WR"],
      searchRank: 900,
      number: 12,
      active: true,
      searchName: "vanjefferson",
    },
  });
  await methods.findPlayers.execute(
    { query: "Jefferson", position: "", team: "", limit: 1 },
    ctx,
  );
  const data = rec.writes[0].data;
  assertEquals(data.count, 1);
  assertEquals(data.truncated, true);
  assertEquals(data.positionFilter, null);
  const players = data.players as Array<Record<string, unknown>>;
  // Lower search_rank is the more widely rostered player.
  assertEquals(players[0].name, "Justin Jefferson");
});

Deno.test("findPlayers refuses to run before the catalogue is synced", async () => {
  const { ctx } = fakeContext(null);
  await assertRejects(
    () => methods.findPlayers.execute({ query: "jefferson", limit: 5 }, ctx),
    Error,
    "syncPlayers",
  );
});

Deno.test("every resource spec is written by at least one method", () => {
  const specs = Object.keys(model.resources);
  const source = Deno.readTextFileSync(
    new URL("./sleeper.ts", import.meta.url),
  );
  for (const spec of specs) {
    assert(
      source.includes(`writeResource(\n          "${spec}"`) ||
        source.includes(`writeResource("${spec}"`),
      `resource spec '${spec}' is declared but never written`,
    );
  }
});

Deno.test("the method context type matches what methods actually use", () => {
  // A compile-time assertion: the narrower MethodContext must satisfy the
  // contexts the enrichment and file methods declare.
  const { ctx } = fakeContext();
  const narrow: MethodContext = ctx;
  assertEquals(narrow.globalArgs.sport, "nfl");
});
