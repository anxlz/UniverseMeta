/**
 * Placeholder rendering for every staff-configurable string — ticket names, channel topics,
 * welcome messages, embed footers.
 *
 * The point of doing this centrally is validation at set time. A typo like `{hoem}` in a
 * name template would otherwise sit in config until the next match opened a channel called
 * `match-{hoem}-vs-bravo`, and nobody would know why. `validateTemplate` rejects it at the
 * moment staff type it, and names the placeholders that do exist.
 */

export interface TemplateContext {
  home: string;
  away: string;
  id: string;
  category: string;
  mode: string;
  kickoff: string;
  date: string;
  time: string;
  captain_home: string;
  captain_away: string;
  league: string;
}

/** Every placeholder, with the description shown in `/ticketconfig placeholders`. */
export const PLACEHOLDERS: Record<keyof TemplateContext, string> = {
  home: "Home team tag, or its name when no tag is set",
  away: "Away team tag, or its name when no tag is set",
  id: "Public match ID, e.g. CODM-20260814-000127",
  category: "Match category — scrim, official, tournament, practice",
  mode: "Game mode once known, otherwise 'tbd'",
  kickoff: "Kickoff time, rendered in each viewer's own timezone",
  date: "Kickoff date in the league timezone",
  time: "Kickoff time in the league timezone",
  captain_home: "Mention of the home captain",
  captain_away: "Mention of the away captain",
  league: "League name from /embedconfig name",
};

export const PLACEHOLDER_KEYS = Object.keys(PLACEHOLDERS) as Array<keyof TemplateContext>;

const TOKEN_PATTERN = /\{([a-z_]+)\}/g;

export interface TemplateValidation {
  valid: boolean;
  unknown: string[];
  used: string[];
}

export function validateTemplate(template: string): TemplateValidation {
  const used: string[] = [];
  const unknown: string[] = [];

  for (const match of template.matchAll(TOKEN_PATTERN)) {
    const token = match[1]!;
    if ((PLACEHOLDER_KEYS as string[]).includes(token)) {
      if (!used.includes(token)) used.push(token);
    } else if (!unknown.includes(token)) {
      unknown.push(token);
    }
  }

  return { valid: unknown.length === 0, unknown, used };
}

export function renderTemplate(template: string, context: TemplateContext): string {
  return template.replace(TOKEN_PATTERN, (whole, token: string) => {
    const value = context[token as keyof TemplateContext];
    // An unknown token is left verbatim rather than blanked — a visible {typo} is easier to
    // diagnose than a silently missing word.
    return value === undefined ? whole : value;
  });
}

/**
 * Discord channel names: lowercase, no spaces, no punctuation beyond hyphens, 100 chars.
 * Applied after rendering, so a team tag with brackets still yields a legal channel name.
 */
export function slugifyChannelName(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    // Keep Unicode letters and digits — Discord accepts them, and an Arabic or Japanese
    // team tag would otherwise slug down to nothing.
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (slug || "match").slice(0, 90);
}

/** Sample values for `preview`, so staff can see a template without scheduling a match. */
export const SAMPLE_CONTEXT: TemplateContext = {
  home: "ALP",
  away: "BRV",
  id: "CODM-20260814-000127",
  category: "scrim",
  mode: "hardpoint",
  kickoff: "Friday 22 August 2026 20:30",
  date: "2026-08-22",
  time: "20:30",
  captain_home: "@AlphaCaptain",
  captain_away: "@BravoCaptain",
  league: "UM League",
};
