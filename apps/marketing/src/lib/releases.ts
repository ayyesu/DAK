/**
 * Where release artifacts live.
 *
 * NOT `ayyesu/DAK`: that repository is private, so this API answers 404 for every
 * anonymous visitor and the download page silently fell back to its own GitHub
 * link - which 404s too. The installers and the update-feed manifests are published
 * to a public mirror that holds artifacts and no source, so the buttons resolve
 * real asset URLs and a download starts on this site rather than on github.com.
 *
 * The source repository keeps its own releases for people with access; only the
 * public read path used by the site lives here.
 */
const REPO = "ayyesu/dak-releases";

export const RELEASES_URL = `https://github.com/${REPO}/releases`;
export const NIGHTLY_RELEASES_URL = `${RELEASES_URL}?q=nightly&expanded=true`;

const LATEST_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
// The `latest` endpoint skips prereleases, so nightly needs the list. GitHub
// returns it newest first and nightlies land several times a day, so the first
// nightly tag in a small page is the current build.
const LIST_API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=10`;

export type ReleaseChannel = "stable" | "nightly";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  published_at: string;
  assets: ReleaseAsset[];
}

function cacheKey(channel: ReleaseChannel) {
  return `dak-${channel}-release`;
}

/**
 * How long a cached release may answer before the page must ask GitHub again.
 * Long enough to spare the anonymous API quota across navigations, short
 * enough that a fresh release shows up on the next visit.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;

interface CachedRelease {
  readonly fetchedAt: number;
  readonly release: Release;
}

/**
 * Chrome restores sessionStorage for restored tabs, so a cache written days
 * ago would otherwise pin a returning visitor to that old version. Entries
 * must be fresh and shaped like a release; anything else counts as a miss.
 */
function readCache(key: string, maxAgeMs: number): Release | undefined {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as CachedRelease;
    if (!parsed.release?.tag_name || !Array.isArray(parsed.release.assets)) return undefined;
    if (Date.now() - parsed.fetchedAt > maxAgeMs) return undefined;
    return parsed.release;
  } catch {
    return undefined;
  }
}

async function fetchRelease(url: string): Promise<Release> {
  // A rate-limited response still parses as JSON, but it is an error payload,
  // never a release. Reject it so callers fall back and nothing gets cached.
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GitHub releases responded ${response.status}`);
  }
  return (await response.json()) as Release;
}

async function fetchStable(): Promise<Release> {
  return fetchRelease(LATEST_API_URL);
}

async function fetchNightly(): Promise<Release> {
  const list: Release[] = await fetchRelease(LIST_API_URL);
  const nightly = Array.isArray(list)
    ? list.find((release) => release.tag_name?.includes("-nightly."))
    : undefined;
  if (!nightly) throw new Error("No nightly release in the latest page");
  return nightly;
}

export async function fetchLatestRelease(channel: ReleaseChannel = "stable"): Promise<Release> {
  const key = cacheKey(channel);
  const cached = readCache(key, CACHE_TTL_MS);
  if (cached) return cached;

  const data = channel === "nightly" ? await fetchNightly() : await fetchStable();
  if (!data?.tag_name || !Array.isArray(data.assets)) {
    throw new Error(`No usable ${channel} release payload`);
  }

  sessionStorage.setItem(key, JSON.stringify({ fetchedAt: Date.now(), release: data }));
  return data;
}
