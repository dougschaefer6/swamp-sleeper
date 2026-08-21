import { z } from "npm:zod@4.3.6";

/**
 * Shared client, schemas, and context types for the `@dougschaefer/sleeper`
 * model.
 *
 * Sleeper (https://sleeper.com) is a fantasy sports platform. Its public API at
 * `https://api.sleeper.app/v1` is **read-only and unauthenticated** — there is
 * no API key, no OAuth, and no write surface at all. Nothing in this model can
 * set a lineup, make a waiver claim, or propose a trade; every method reads
 * public league state.
 *
 * Two behaviours of that API drive the design here:
 *
 * 1. **A missing record can arrive as HTTP 200 with a `null` body.** Ask for a
 *    username that does not exist and Sleeper answers `200 null` rather than
 *    404. Treating that as success would write an empty record and let a typo
 *    read as "this user has nothing". {@link sleeperRequest} raises
 *    {@link SleeperNotFoundError} for a `null` body on any status, so a
 *    not-found is always an error and never silent data.
 *
 * 2. **A genuinely empty collection is a real answer.** Before a draft, rosters
 *    exist but `players` is `[]`, and `matchups`, `transactions`, and
 *    `draft/picks` all return `[]`. That is the league's true state, not a
 *    failure, so the methods record it with an explicit `count` and `empty`
 *    flag rather than discarding it.
 *
 * Sleeper asks callers to stay under 1000 requests per minute and to cache the
 * player catalogue rather than re-fetching it (it is ~14 MB and changes at most
 * daily). {@link buildPlayerIndex} trims that payload to the fantasy-relevant
 * fields so `syncPlayers` can store it once and the enrichment helpers can join
 * player IDs to names from the local copy.
 *
 * Plain `fetch` over HTTPS is used throughout, so the bundle carries no native
 * dependencies.
 */

/** Connection facts and default identity for one Sleeper account. */
export const SleeperGlobalArgsSchema = z.object({
  username: z.string().describe(
    "Sleeper username to resolve, e.g. jdoe. Case-insensitive.",
  ),
  sport: z.string().default("nfl").describe(
    "Sleeper sport code. Fantasy football is 'nfl'.",
  ),
  defaultLeagueId: z.string().optional().describe(
    "League ID used when a method's leagueId argument is omitted",
  ),
  baseUrl: z.string().default("https://api.sleeper.app/v1").describe(
    "Base URL of the Sleeper read-only API",
  ),
  cdnUrl: z.string().default("https://sleepercdn.com").describe(
    "Base URL of the Sleeper CDN that serves avatars",
  ),
  timeoutMs: z.number().int().default(30000).describe(
    "Per-request timeout in milliseconds",
  ),
});

/** Resolved connection facts and default identity for one Sleeper account. */
export type SleeperGlobalArgs = z.infer<typeof SleeperGlobalArgsSchema>;

/**
 * Raised when Sleeper has no record for the thing that was asked for. Sleeper
 * signals this two different ways — a 404, or a 200 carrying a `null` body —
 * and both land here so callers never mistake "no such user" for "user with no
 * data".
 */
export class SleeperNotFoundError extends Error {
  /** Request path that produced the not-found answer. */
  readonly path: string;

  /** Build a not-found error for `path`, describing what was missing. */
  constructor(path: string, detail: string) {
    super(`Sleeper has no record at ${path}: ${detail}`);
    this.name = "SleeperNotFoundError";
    this.path = path;
  }
}

/** Trim any trailing slashes from a configured base URL. */
function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Sleep for `ms`, used to back off between rate-limited retries. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Low-level Sleeper GET. Returns the parsed JSON body and throws on anything
 * that is not a usable answer.
 *
 * A 429 or 5xx is retried up to `attempts` times with linear backoff, honouring
 * a `retry-after` header when Sleeper sends one. A 404, or a `null` body on any
 * status, raises {@link SleeperNotFoundError} — see the module note on why the
 * `null` case matters. An empty array is returned as-is, because for Sleeper
 * that is a real answer.
 */
export async function sleeperRequest(
  g: SleeperGlobalArgs,
  path: string,
  opts: { query?: Record<string, string>; attempts?: number } = {},
): Promise<unknown> {
  const url = new URL(trimSlash(g.baseUrl) + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const attempts = opts.attempts ?? 3;

  let lastTransient = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), g.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();

    if (res.status === 429 || res.status >= 500) {
      lastTransient = `HTTP ${res.status}: ${text.slice(0, 200)}`;
      if (attempt < attempts) {
        const retryAfter = Number(res.headers.get("retry-after") ?? 0);
        await delay(retryAfter > 0 ? retryAfter * 1000 : attempt * 1000);
        continue;
      }
      throw new Error(`Sleeper GET ${path} -> ${lastTransient}`);
    }

    if (res.status === 404) {
      throw new SleeperNotFoundError(path, "HTTP 404");
    }
    if (!res.ok) {
      throw new Error(
        `Sleeper GET ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`,
      );
    }

    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(
        `Sleeper GET ${path} returned a non-JSON body: ${text.slice(0, 200)}`,
      );
    }
    if (data === null) {
      // A 200 with a null body is Sleeper's other way of saying "no such
      // record" — never let it through as empty-but-successful data.
      throw new SleeperNotFoundError(path, "HTTP 200 with a null body");
    }
    return data;
  }
  throw new Error(`Sleeper GET ${path} -> ${lastTransient}`);
}

/** Fetch `path` and require a JSON array, which most Sleeper list routes return. */
export async function sleeperList(
  g: SleeperGlobalArgs,
  path: string,
  opts: { query?: Record<string, string> } = {},
): Promise<Record<string, unknown>[]> {
  const data = await sleeperRequest(g, path, opts);
  if (!Array.isArray(data)) {
    throw new Error(
      `Sleeper GET ${path} was expected to return a list, got ${typeof data}`,
    );
  }
  return data as Record<string, unknown>[];
}

/** Fetch `path` and require a JSON object, which the single-record routes return. */
export async function sleeperObject(
  g: SleeperGlobalArgs,
  path: string,
  opts: { query?: Record<string, string> } = {},
): Promise<Record<string, unknown>> {
  const data = await sleeperRequest(g, path, opts);
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new Error(
      `Sleeper GET ${path} was expected to return an object, got ${typeof data}`,
    );
  }
  return data as Record<string, unknown>;
}

/** Full-size and thumbnail CDN URLs for an avatar ID, or nulls when unset. */
export function avatarUrls(
  g: SleeperGlobalArgs,
  avatarId: unknown,
): { avatarUrl: string | null; avatarThumbUrl: string | null } {
  if (typeof avatarId !== "string" || avatarId === "") {
    return { avatarUrl: null, avatarThumbUrl: null };
  }
  const base = trimSlash(g.cdnUrl);
  return {
    avatarUrl: `${base}/avatars/${avatarId}`,
    avatarThumbUrl: `${base}/avatars/thumbs/${avatarId}`,
  };
}

/** Read a string field, collapsing null/undefined to `null`. */
export function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Read a numeric field, collapsing anything unparseable to `0`. */
export function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Read a string array field, collapsing null/undefined to `[]`. */
export function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

/** Lowercase, hyphenate, and trim a string for use in a data instance name. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "all";
}

/**
 * Normalise an optional string argument, treating a blank value as absent.
 *
 * Workflow inputs default to `""` rather than being omitted, so without this a
 * `leagueId: ""` passed down from a workflow would satisfy `??` and suppress
 * the model's own default.
 */
export function blankToUndefined(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the league ID a method should act on: the explicit argument first,
 * then the model's `defaultLeagueId`. Throws with both options named rather
 * than silently querying the wrong league.
 */
export function resolveLeagueId(
  g: SleeperGlobalArgs,
  leagueId?: string,
): string {
  const resolved = blankToUndefined(leagueId) ??
    blankToUndefined(g.defaultLeagueId);
  if (!resolved) {
    throw new Error(
      "No league selected: pass --arg leagueId=<id>, or set defaultLeagueId " +
        "on the model definition. Run the 'leagues' method to list league IDs.",
    );
  }
  return resolved;
}

/** One entry in the trimmed player catalogue that `syncPlayers` stores. */
export interface PlayerIndexEntry {
  /** Sleeper player ID; a team abbreviation for team defences. */
  playerId: string;
  /** Display name, falling back to the ID when Sleeper has no name. */
  name: string;
  /** Primary roster position, e.g. `QB`, `WR`, `DEF`. */
  position: string | null;
  /** NFL team abbreviation, or `null` for free agents. */
  team: string | null;
  /** Roster status, e.g. `Active`, `Inactive`, `Injured Reserve`. */
  status: string | null;
  /** Injury designation when one is posted, e.g. `Questionable`. */
  injuryStatus: string | null;
  /** Positions the player is fantasy-eligible at. */
  fantasyPositions: string[];
  /** Sleeper's popularity rank; lower is more widely rostered. */
  searchRank: number | null;
  /** Jersey number when known. */
  number: number | null;
  /** Whether Sleeper currently marks the player as active. */
  active: boolean;
  /** Normalised name Sleeper itself searches on, used by `findPlayers`. */
  searchName: string;
}

/** The trimmed player catalogue as stored by `syncPlayers`, keyed by player ID. */
export type PlayerIndex = Record<string, PlayerIndexEntry>;

/** Build a display name for one raw Sleeper player record. */
function playerName(playerId: string, raw: Record<string, unknown>): string {
  const full = str(raw.full_name);
  if (full) return full;
  const first = str(raw.first_name);
  const last = str(raw.last_name);
  if (first || last) return [first, last].filter(Boolean).join(" ");
  return playerId;
}

/**
 * Reduce Sleeper's ~14 MB player catalogue to the fantasy-relevant fields.
 *
 * The full payload carries a dozen cross-provider ID fields, biographical
 * detail, and practice notes that no method here reads. Trimming at sync time
 * keeps the stored copy small enough to load on every enrichment call.
 */
export function buildPlayerIndex(raw: Record<string, unknown>): PlayerIndex {
  const index: PlayerIndex = {};
  for (const [playerId, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const p = value as Record<string, unknown>;
    index[playerId] = {
      playerId,
      name: playerName(playerId, p),
      position: str(p.position),
      team: str(p.team),
      status: str(p.status),
      injuryStatus: str(p.injury_status),
      fantasyPositions: strList(p.fantasy_positions),
      searchRank: typeof p.search_rank === "number" ? p.search_rank : null,
      number: typeof p.number === "number" ? p.number : null,
      active: p.active === true,
      searchName: str(p.search_full_name) ??
        playerName(playerId, p).toLowerCase().replace(/[^a-z0-9]/g, ""),
    };
  }
  return index;
}

/**
 * Look one player up in a synced index. Returns a placeholder carrying the raw
 * ID when the index is missing or the ID is unknown, so a roster still renders
 * before `syncPlayers` has ever run.
 */
export function lookupPlayer(
  index: PlayerIndex | null,
  playerId: string,
): {
  playerId: string;
  name: string;
  position: string | null;
  team: string | null;
  status: string | null;
  injuryStatus: string | null;
} {
  const hit = index?.[playerId];
  return {
    playerId,
    name: hit?.name ?? playerId,
    position: hit?.position ?? null,
    team: hit?.team ?? null,
    status: hit?.status ?? null,
    injuryStatus: hit?.injuryStatus ?? null,
  };
}

/** Instance name under which `syncPlayers` stores the trimmed catalogue. */
export function playerIndexInstance(sport: string): string {
  return `playerIndex-${sport}`;
}

/**
 * Load the player index that `syncPlayers` previously stored, or `null` when it
 * has never been synced. Enrichment is best-effort by design: a stale or absent
 * catalogue degrades names to raw IDs instead of failing the read.
 */
export async function loadPlayerIndex(
  context: EnrichmentContext,
): Promise<PlayerIndex | null> {
  try {
    const bytes = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      playerIndexInstance(context.globalArgs.sport),
    );
    if (!bytes) return null;
    return JSON.parse(new TextDecoder().decode(bytes)) as PlayerIndex;
  } catch (err) {
    // Deliberately info, not warning: a degraded read is something the user
    // must see, and warning-level output does not render without `-v`.
    context.logger.info(
      "Could not load the cached player index, names will show as raw IDs: {error}",
      { error: err instanceof Error ? err.message : String(err) },
    );
    return null;
  }
}

/** One league member, as joined onto rosters, matchups, and draft picks. */
export interface LeagueMember {
  /** Sleeper user ID of the member. */
  userId: string;
  /** Member's Sleeper display name. */
  displayName: string;
  /** Team name the member set for this league, when they set one. */
  teamName: string | null;
  /** Whether the member is the league commissioner. */
  isOwner: boolean;
  /** Whether the member is a bot account. */
  isBot: boolean;
}

/**
 * Fetch a league's members keyed by user ID.
 *
 * Sleeper's roster, matchup, and draft-pick records identify managers only by
 * an opaque user ID, so every method that reports on them joins this map to
 * turn `608827912585547776` into a display name and team name.
 */
export async function fetchLeagueMembers(
  g: SleeperGlobalArgs,
  leagueId: string,
): Promise<Record<string, LeagueMember>> {
  const rows = await sleeperList(g, `/league/${leagueId}/users`);
  const members: Record<string, LeagueMember> = {};
  for (const row of rows) {
    const userId = str(row.user_id);
    if (!userId) continue;
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    members[userId] = {
      userId,
      displayName: str(row.display_name) ?? userId,
      teamName: str(metadata.team_name),
      isOwner: row.is_owner === true,
      isBot: row.is_bot === true,
    };
  }
  return members;
}

/** Display name for a roster owner, falling back through team name to the ID. */
export function ownerLabel(
  members: Record<string, LeagueMember>,
  ownerId: string | null,
): { ownerDisplayName: string | null; teamName: string | null } {
  if (!ownerId) return { ownerDisplayName: null, teamName: null };
  const member = members[ownerId];
  return {
    ownerDisplayName: member?.displayName ?? ownerId,
    teamName: member?.teamName ?? null,
  };
}

/** Structured logger surface used by this model's methods. */
export interface MethodLogger {
  /** Log an informational message; the only level users see without `-v`. */
  info: (msg: string, props?: Record<string, unknown>) => void;
  /** Log a warning. Not rendered unless the run is verbose. */
  warning: (msg: string, props?: Record<string, unknown>) => void;
}

/** Method context fields this model's write methods use. */
export interface MethodContext {
  /** Validated global arguments from the model definition. */
  globalArgs: SleeperGlobalArgs;
  /** Structured logger for progress and diagnostics. */
  logger: MethodLogger;
  /** Persist a structured resource under one of the model's specs. */
  writeResource: (
    spec: string,
    instance: string,
    data: Record<string, unknown>,
  ) => Promise<DataHandle>;
}

/** Method context fields needed to read the cached player index back. */
export interface EnrichmentContext extends MethodContext {
  /** Low-level data API, used to read the stored player index file. */
  dataRepository: {
    getContent: (
      modelType: string,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
  /** The model type string, e.g. `@dougschaefer/sleeper`. */
  modelType: string;
  /** The model instance ID. */
  modelId: string;
}

/** Method context fields needed to write the player catalogue file. */
export interface FileContext extends MethodContext {
  /** Create a writer for one of the model's file specs. */
  createFileWriter: (spec: string, instance: string) => {
    writeText: (text: string) => Promise<DataHandle>;
  };
}

/** Handle returned by `writeResource` and the file writers. */
export interface DataHandle {
  /** Data artifact name. */
  name: string;
  /** The declared spec name. */
  specName: string;
}
