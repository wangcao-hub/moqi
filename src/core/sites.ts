// Site grants for web tools. Within one conversation turn, opening a site is asked once; after that,
// browsing and clicking there runs without asking, as long as the page is still on a granted site. What the
// model writes itself (text it types, addresses it makes up) is what could carry the user's words away, so
// typing is always asked and a new site is asked.

export type SiteRole = "goto" | "within";

/** What a turn knows about the web: the sites the user granted, and the site of the page the browser is on. */
export interface SiteGrant {
  readonly granted: Set<string>;
  current?: string | undefined;
  /** Addresses, normalised, that appeared in what the model was given this turn; see `appeared`. */
  readonly seen?: Set<string>;
}

/**
 * The host of an http(s) address, lower case, without "www." and without a trailing dot ("com." is "com", so it
 * covers only itself), with its port when it is not the usual one.
 */
export function hostOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    const name = u.hostname
      .toLowerCase()
      .replace(/\.+$/, "")
      .replace(/^www\./, "");
    if (!name) return undefined;
    return u.port ? `${name}:${u.port}` : name;
  } catch {
    return undefined;
  }
}

/** A granted site covers itself and its subdomains; a one-label host (localhost, com) covers only itself. */
function covers(granted: ReadonlySet<string>, host: string): boolean {
  for (const g of granted) if (host === g || (g.includes(".") && host.endsWith(`.${g}`))) return true;
  return false;
}

/** Run it, ask for its site, or `undefined` for the usual rules (not on a granted page, or not a web address). */
export function siteDecision(
  role: SiteRole,
  args: Record<string, unknown>,
  grant: SiteGrant,
): { readonly run: true } | { readonly host: string; readonly url: string } | undefined {
  const url = typeof args.url === "string" ? args.url : undefined;
  if (role === "within" || url === undefined)
    return grant.current !== undefined && covers(grant.granted, grant.current) ? { run: true } : undefined;
  const host = hostOf(url);
  if (!host) return undefined;
  return covers(grant.granted, host) ? { run: true } : { host, url };
}

/**
 * The site of the page a browser tool's result says it is on: Playwright's own "- Page URL:" line, read
 * only before the page's content starts, so text on a page cannot claim to be somewhere else.
 */
export function pageHost(result: string): string | undefined {
  const head = result.split("### Snapshot")[0] ?? "";
  const line = /^- Page URL: (\S+)\s*$/m.exec(head);
  return line?.[1] ? hostOf(line[1]) : undefined;
}

/** What a tool marked `readsUrl` answers, instead of reading, for an address the turn has not seen. */
export const UNSEEN_ADDRESS =
  "没有读：这一轮读到了外部内容，之后只能读这一轮里原样出现过的网址，这个网址没有出现过。要读的话，请用户把网址发过来。";

/** An address as `seen` keeps it: parsed and printed back (host case, encoding), without the part after #. */
function normalised(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    u.hash = "";
    return u.href;
  } catch {
    return undefined;
  }
}

const TRAILING = ".,;:!?";

/** Drops what ends a sentence, and a closing parenthesis the address did not open (a Markdown link's). Linear. */
function trimmed(url: string): string {
  let open = 0;
  let close = 0;
  for (const c of url) {
    if (c === "(") open++;
    else if (c === ")") close++;
  }
  let end = url.length;
  for (;;) {
    const c = url[end - 1];
    if (c !== undefined && TRAILING.includes(c)) end--;
    else if (c === ")" && close > open) {
      end--;
      close--;
    } else break;
  }
  return url.slice(0, end);
}

/** The http(s) addresses in a text, as a reader picks them out: up to white space, quotes, brackets or Chinese punctuation. */
export function addressesIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s"'<>`{}[\]，。；！？、（）【】「」《》]+/gi)].map((m) => trimmed(m[0]));
}

/** Keeps the addresses a text holds, normalised, for `appeared`. */
export function noteAddresses(seen: Set<string>, text: string): void {
  for (const url of addressesIn(text)) {
    const n = normalised(url);
    if (n) seen.add(n);
  }
}

/** Whether an address appeared in the turn, as is or cut shorter: cutting an address adds nothing to it. */
export function appeared(seen: ReadonlySet<string>, url: string): boolean {
  const wanted = normalised(url);
  if (!wanted) return false;
  for (const s of seen) if (s.startsWith(wanted)) return true;
  return false;
}
