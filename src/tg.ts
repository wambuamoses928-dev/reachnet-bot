import { Bot, Context } from "grammy";
import pino from "pino";
import { db, syncGroups, updateLink, type BotLink } from "./store.js";

const log = pino({ name: "tg" });

/**
 * Telegram side: a group admin adds the bot to their group (or the user
 * messages the bot in a group they own). The bot then registers that group
 * under the ReachNet user who linked it via /link <code>.
 */
export function startTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    log.warn("TELEGRAM_BOT_TOKEN not set — telegram disabled");
    return null;
  }

  const bot = new Bot(token);

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "ReachNet broadcast bot. To link this Telegram account to your ReachNet profile, open ReachNet → Broadcast → Link Telegram and send me the 6-character code."
    );
  });

  // Link: user sends /link <code> from ReachNet UI. We match the code to a
  // pending bot_links row and bind their telegram chat id.
  bot.command("link", async (ctx) => {
    const code = ctx.match?.trim();
    if (!code) return void (await ctx.reply("Usage: /link CODE (from ReachNet)"));
    const { data: pending } = await db
      .from("bot_links")
      .select("*")
      .eq("platform", "telegram")
      .eq("status", "pending")
      .eq("pairing_code", code)
      .single();
    if (!pending) return void (await ctx.reply("Unknown code. Get a fresh one from ReachNet."));

    await updateLink(pending.id, {
      status: "connected",
      telegram_chat_id: String(ctx.chat.id),
      pairing_code: null,
    });
    await ctx.reply(
      "Linked! Now add me as admin to any group you want to broadcast to — I'll register them automatically."
    );
  });

  // When added to a group (or any chat member joins), register the group
  // under the link whose telegram_chat_id matches the user that added us.
  bot.on("my_chat_member", async (ctx) => {
    const member = ctx.myChatMember;
    if (member.new_chat_member.status === "administrator" && member.chat.type === "group") {
      const { data: links } = await db
        .from("bot_links")
        .select("*")
        .eq("platform", "telegram")
        .eq("status", "connected")
        .eq("telegram_chat_id", String(member.from.id));
      const link = (links ?? [])[0] as BotLink | undefined;
      if (!link) return;

      try {
        const admins = await ctx.api.getChatAdministrators(member.chat.id);
        const memberCount = (await ctx.api.getChatMemberCount(member.chat.id)) ?? 0;
        const me = admins.find((a) => "user" in a.user ? false : false);
        const tgid = (member.chat as { id: number }).id;
        const info = await ctx.api.getChat(tgid);
        const bio = "bio" in info ? String((info as { bio?: string }).bio ?? "") : "";

        await syncGroups(link.id, "telegram", [
          {
            group_ref: String(tgid),
            name: member.chat.title ?? "Untitled group",
            member_count: memberCount,
            description: bio || null,
            links: (bio.match(/https?:\/\/[^\s]+/g) ?? []),
            owner_is_user: admins.some((a) => a.user.id === member.from.id),
            attributes: {
              addedBy: member.from.id,
              isAnnouncement: member.new_chat_member.can_post_messages === false,
              memberCount,
            },
          },
        ]);
        log.info({ chatId: tgid }, "telegram group registered");
      } catch (e) {
        log.error({ err: String(e) }, "telegram group register failed");
      }
    }
  });

  void bot.start({ drop_pending_updates: true });
  log.info("telegram bot started");
  return bot;
}

export async function sendToTelegramGroup(
  bot: Bot,
  groupRef: string,
  content: string
): Promise<boolean> {
  try {
    await bot.api.sendMessage(Number(groupRef), content);
    return true;
  } catch (e) {
    log.error({ groupRef, err: String(e) }, "telegram send failed");
    return false;
  }
}
