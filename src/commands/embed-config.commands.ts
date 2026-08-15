/**
 * §5-adjacent: embed branding, configurable per guild.
 *
 * Everything here writes through the DB-backed config path, so a colour set today survives
 * a restart the same way a toggle does. Nothing in this file changes *what* an embed says —
 * only how it looks — so the §5 rules (bold body text, edit in place) are untouched.
 */

import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { getConfig, setConfig, type ConfigKey } from "../lib/automation-config";
import {
  COLORS,
  buildEmbed,
  field,
  formatHexColor,
  parseHexColor,
  replyError,
  resolveTheme,
  successEmbed,
  type EmbedTone,
} from "../lib/embeds";
import { hasManagerPermission } from "../lib/permissions";
import { PLACEHOLDERS, SAMPLE_CONTEXT, renderTemplate, validateTemplate } from "../lib/templates";
import type { CommandModule } from "./types";

/** Only the tones a guild can meaningfully re-skin. `info` follows `brand`. */
const THEMEABLE: Array<{ tone: EmbedTone; key: ConfigKey; label: string; usedFor: string }> = [
  { tone: "brand", key: "embed_color_brand", label: "Brand", usedFor: "Neutral and informational embeds" },
  { tone: "pending", key: "embed_color_pending", label: "Pending", usedFor: "Awaiting confirmation, approval or resolution" },
  { tone: "confirmed", key: "embed_color_confirmed", label: "Confirmed", usedFor: "Confirmed matches and successful actions" },
  { tone: "cancelled", key: "embed_color_cancelled", label: "Cancelled", usedFor: "Cancelled and forfeited matches" },
  { tone: "danger", key: "embed_color_danger", label: "Error", usedFor: "Errors and refusals" },
];

const embedConfig = new SlashCommandBuilder()
  .setName("embedconfig")
  .setDescription("Customize how league embeds look")
  .addSubcommand((s) => s.setName("show").setDescription("Show current embed branding"))
  .addSubcommand((s) => s.setName("preview").setDescription("Preview every embed style"))
  .addSubcommand((s) =>
    s
      .setName("name")
      .setDescription("Set the league name used by the {league} placeholder")
      .addStringOption((o) =>
        o.setName("value").setDescription("e.g. UM League").setRequired(true).setMaxLength(64),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("color")
      .setDescription("Set the colour for one embed state")
      .addStringOption((o) =>
        o
          .setName("state")
          .setDescription("Which embeds this colour applies to")
          .setRequired(true)
          .addChoices(...THEMEABLE.map((t) => ({ name: t.label, value: t.key }))),
      )
      .addStringOption((o) =>
        o.setName("hex").setDescription("Hex colour, e.g. #5865F2").setRequired(true).setMaxLength(9),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("footer")
      .setDescription("Text appended to every embed footer")
      .addStringOption((o) =>
        o.setName("text").setDescription("Supports {league}").setRequired(true).setMaxLength(128),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("logo")
      .setDescription("Default thumbnail for embeds without their own image")
      .addStringOption((o) => o.setName("url").setDescription("Direct image URL").setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName("timestamps")
      .setDescription("Show or hide the timestamp on embeds")
      .addBooleanOption((o) => o.setName("enabled").setDescription("On or off").setRequired(true)),
  )
  .addSubcommand((s) =>
    s
      .setName("reset")
      .setDescription("Reset branding to the built-in defaults")
      .addStringOption((o) =>
        o
          .setName("setting")
          .setDescription("One setting, or everything")
          .addChoices(
            { name: "Everything", value: "all" },
            { name: "Colours only", value: "colors" },
            { name: "Footer", value: "embed_footer_text" },
            { name: "Logo", value: "embed_logo_url" },
          ),
      ),
  );

function themeOverview(guildId: string) {
  const theme = resolveTheme(guildId);

  return buildEmbed({
    title: "Embed Branding",
    description:
      "Colours apply to every league embed by role, so a state you have not customized still reads correctly.",
    tone: "brand",
    guildId,
    fields: [
      field("League name", theme.leagueName ?? "Not set"),
      field("Footer", theme.footerText ?? "Not set"),
      field("Timestamps", theme.timestamps ? "Shown" : "Hidden"),
      ...THEMEABLE.map((t) => {
        const raw = getConfig(guildId, t.key) as string;
        const value = raw ? formatHexColor(parseHexColor(raw) ?? COLORS[t.tone]) : "default";
        return field(t.label, `${value} — ${t.usedFor}`, false);
      }),
      field("Logo", theme.logoUrl ?? "Not set", false),
    ],
  });
}

export const embedConfigCommands: CommandModule[] = [
  {
    data: embedConfig,
    async execute(interaction: ChatInputCommandInteraction) {
      const member = interaction.member as GuildMember;
      if (!hasManagerPermission(member)) {
        return replyError(interaction, "This command is restricted to league staff.");
      }

      const guildId = interaction.guildId!;
      const actor = member.id;
      const sub = interaction.options.getSubcommand();

      if (sub === "show") {
        return void (await interaction.reply({
          embeds: [themeOverview(guildId)],
          flags: MessageFlags.Ephemeral,
        }));
      }

      if (sub === "preview") {
        // One embed per tone, so staff see the whole palette in context rather than guessing
        // what a hex value looks like against Discord's dark background.
        return void (await interaction.reply({
          embeds: THEMEABLE.map((t) =>
            buildEmbed({
              title: `${t.label} — sample`,
              description: `${t.usedFor}.\nThis is how body text renders in this style.`,
              tone: t.tone,
              guildId,
              fields: [field("Match ID", SAMPLE_CONTEXT.id), field("Category", SAMPLE_CONTEXT.category)],
            }),
          ),
          flags: MessageFlags.Ephemeral,
        }));
      }

      if (sub === "name") {
        const value = interaction.options.getString("value", true).trim();
        setConfig(guildId, "league_name", value as never, actor);
        return void (await interaction.reply({
          embeds: [successEmbed("League Name Set", `{league} now renders as "${value}".`, guildId)],
          flags: MessageFlags.Ephemeral,
        }));
      }

      if (sub === "color") {
        const key = interaction.options.getString("state", true) as ConfigKey;
        const hex = interaction.options.getString("hex", true);
        const parsed = parseHexColor(hex);

        if (parsed === null) {
          return replyError(
            interaction,
            `"${hex}" is not a valid hex colour. Use six hex digits, e.g. #5865F2.`,
          );
        }

        setConfig(guildId, key, formatHexColor(parsed).replace("#", "") as never, actor);
        const entry = THEMEABLE.find((t) => t.key === key)!;

        return void (await interaction.reply({
          embeds: [
            buildEmbed({
              title: `${entry.label} Colour Updated`,
              description: `Now ${formatHexColor(parsed)}. This embed is rendered in it.`,
              tone: entry.tone,
              guildId,
              fields: [field("Applies to", entry.usedFor, false)],
            }),
          ],
          flags: MessageFlags.Ephemeral,
        }));
      }

      if (sub === "footer") {
        const text = interaction.options.getString("text", true);
        const validation = validateTemplate(text);
        if (!validation.valid) {
          return replyError(
            interaction,
            `Unknown placeholder(s): ${validation.unknown.map((u) => `{${u}}`).join(", ")}. Footers support {league}.`,
          );
        }
        setConfig(guildId, "embed_footer_text", text as never, actor);
        return void (await interaction.reply({
          embeds: [
            buildEmbed({
              title: "Footer Updated",
              description: "Every embed now carries this footer after its own context.",
              tone: "confirmed",
              guildId,
              fields: [
                field("Preview", renderTemplate(text, SAMPLE_CONTEXT), false),
              ],
            }),
          ],
          flags: MessageFlags.Ephemeral,
        }));
      }

      if (sub === "logo") {
        const url = interaction.options.getString("url", true).trim();
        if (!/^https?:\/\//i.test(url)) {
          return replyError(interaction, "The logo must be a direct http(s) image URL.");
        }
        setConfig(guildId, "embed_logo_url", url as never, actor);
        return void (await interaction.reply({
          embeds: [
            buildEmbed({
              title: "Logo Updated",
              description: "Embeds without their own image now use this logo.",
              tone: "confirmed",
              guildId,
              thumbnail: url,
            }),
          ],
          flags: MessageFlags.Ephemeral,
        }));
      }

      if (sub === "timestamps") {
        const enabled = interaction.options.getBoolean("enabled", true);
        setConfig(guildId, "embed_timestamps", enabled as never, actor);
        return void (await interaction.reply({
          embeds: [
            successEmbed(
              "Timestamps Updated",
              enabled ? "Embeds now show a timestamp." : "Embeds no longer show a timestamp.",
              guildId,
            ),
          ],
          flags: MessageFlags.Ephemeral,
        }));
      }

      // reset
      const setting = interaction.options.getString("setting") ?? "all";
      const colorKeys = THEMEABLE.map((t) => t.key);
      const targets: ConfigKey[] =
        setting === "all"
          ? [...colorKeys, "embed_footer_text", "embed_logo_url"]
          : setting === "colors"
            ? colorKeys
            : [setting as ConfigKey];

      // Writing the empty string is what "use the default" means — resolveTheme falls back
      // whenever a value is blank, so there is no separate delete path to keep in sync.
      for (const key of targets) setConfig(guildId, key, "" as never, actor);

      await interaction.reply({
        embeds: [
          successEmbed(
            "Branding Reset",
            `${targets.length} setting(s) returned to the built-in defaults.`,
            guildId,
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    },
  },
];

export { PLACEHOLDERS };
