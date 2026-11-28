// Site grants for web tools. Within one conversation turn, opening a site is asked once; after that,
// browsing and clicking there runs without asking, as long as the page is still on a granted site. What the
// model writes itself (text it types, addresses it makes up) is what could carry the user's words away, so
// typing is always asked and a new site is asked.

export type SiteRole = "goto" | "within";

/** What a turn knows about the web: the sites the user granted, and the site of the page the browser is on. */
export interface SiteGrant {
  readonly granted: Set<string>;
  current?: string | undefined;
  /** Addresses, normalised, that the user and the outside world gave the model this turn; see `appeared`. */
  readonly seen?: Set<string>;
  /** How many reads by address passed the check after outside content this turn; see `READS_AFTER_OUTSIDE`. */
  reads?: number;
  /**
   * Outside content came in within the messages the model is shown, before this turn: an address moqi wrote back
   * then may still be in front of the model, so the `readsUrl` rule holds from the turn's start.
   */
  readonly outsideEarlier?: boolean;
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
  "没有读：对话里读到过外部内容，之后只能读用户发来的、或工具结果里原样出现过的网址，这个网址没有出现过。要读的话，请用户把网址发过来。";

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

const TRAILING = ".,;:!?'";

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
  return [...text.matchAll(/https?:\/\/[^\s"<>`{}[\]，。；！？、（）【】「」《》]+/gi)].map((m) => trimmed(m[0]));
}

/**
 * Keeps the addresses a text holds, normalised, for `appeared`. `written`: addresses the model made up in its own
 * tool calls this turn; a tool result that echoes one back (or a longer or shorter form of it) does not make it seen.
 */
export function noteAddresses(seen: Set<string>, text: string, written?: ReadonlySet<string>): void {
  for (const url of addressesIn(text)) {
    const n = normalised(url);
    if (!n) continue;
    let echoed = false;
    if (written) for (const w of written) if (n.startsWith(w) || w.startsWith(n)) echoed = true;
    if (!echoed) seen.add(n);
  }
}

/**
 * Keeps in `written` the addresses in a tool call's arguments (values and keys, at any depth) that have not
 * appeared: those the model put together. An address it copied from what it was given is left out, so a page that
 * links to a longer form of the page's own address can still be followed.
 */
export function noteWritten(written: Set<string>, seen: ReadonlySet<string>, args: unknown): void {
  const strings: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") strings.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v !== null && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        strings.push(k);
        walk(x);
      }
  };
  walk(args);
  for (const text of strings)
    for (const url of addressesIn(text)) {
      const n = normalised(url);
      if (n && !seenAddress(seen, n)) written.add(n);
    }
}

/**
 * The address as it is compared and as it should be used (normalised, no # part), when it appeared in the turn as
 * is or cut shorter (cutting an address adds nothing to it); `undefined` when it did not.
 */
export function seenAddress(seen: ReadonlySet<string>, url: string): string | undefined {
  const wanted = normalised(url);
  if (!wanted) return undefined;
  for (const s of seen) if (s.startsWith(wanted)) return wanted;
  return undefined;
}

/** Whether an address appeared in the turn, as is or cut shorter. */
export function appeared(seen: ReadonlySet<string>, url: string): boolean {
  return seenAddress(seen, url) !== undefined;
}

/**
 * Reads by address after outside content, per turn. Picking which of the seen addresses to read, and in what order,
 * could still spell out the user's words; a few reads are enough to follow a search, and the limit keeps that small.
 */
export const READS_AFTER_OUTSIDE = 5;

/** What a tool marked `readsUrl` answers once the turn has used up `READS_AFTER_OUTSIDE`. */
export const TOO_MANY_READS = `没有读：这一轮已经读了 ${READS_AFTER_OUTSIDE} 个网页，不再读了。要接着读，请用户再说一声。`;
