/**
 * postinstall: swaps Baileys 6.7.24's WAProto definitions with a newer
 * schema (vendored, originally generated for gifted-baileys 2.5.8).
 *
 * Why: 6.7.24's proto predates WhatsApp's "group status V2" message type
 * (proto.Message.groupStatusMessageV2, field 103) — without it the group
 * status feature silently does nothing. The newer schema is a superset
 * (all existing field numbers unchanged), so the proven 6.7.24 socket /
 * pairing / crypto logic keeps working; only message definitions change.
 *
 * Original files are kept as *.orig only in the sandbox copy; in
 * node_modules we overwrite in place.
 */
import { copyFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const vendor = join(here, "..", "vendor", "waproto");
const target = join(here, "..", "node_modules", "@whiskeysockets", "baileys", "WAProto");

if (!existsSync(vendor)) {
  console.error("[install-waproto] vendor/waproto missing — skipping swap");
  process.exit(0);
}
if (!existsSync(target)) {
  console.error("[install-waproto] baileys WAProto dir not found — skipping");
  process.exit(0);
}
copyFileSync(join(vendor, "index.js"), join(target, "index.js"));
copyFileSync(join(vendor, "WAProto.proto"), join(target, "WAProto.proto"));
console.log("[install-waproto] WAProto swapped (groupStatusMessageV2 enabled) ✓");
