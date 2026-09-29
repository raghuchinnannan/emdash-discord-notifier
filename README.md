# Discord Notifier for EmDash

Sends Discord messages when things happen on your [EmDash](https://github.com/emdash-cms/emdash) site.
A sandboxed plugin: it runs isolated, and site admins approve exactly what it can access.

More at <https://a2plugins.com/discord-notifier/>.

## Free

- One Discord webhook
- Embeds for: published, unpublished, scheduled, schedule cancelled, deleted, restored,
  new comment, comment moderated, media uploaded (each can be toggled)
- Bot name and avatar
- Test button and a dashboard widget

## Pro / Extended

Unlocked with a license key (Pro: 1 site, Extended: unlimited sites), entered under
**Discord Notifier → License**.

- Separate webhooks per category (content, comments, media, forms)
- Only notify for chosen collections
- Role / user mentions, message template (`{event} {title} {collection} {author}`), embed colour
- Daily or weekly activity digest
- Form submissions relay (see below)
- Delivery log with retry

The plugin is MIT licensed and the source is public, so licensing is honour-based. Keys are checked
against LemonSqueezy and activated per site, which is how the 1-site limit is enforced.

## Install

1. Admin → **Registry**, search for *Discord Notifier*, review permissions and install.
2. Set `EMDASH_ENCRYPTION_KEY` for your site (webhook URLs and license keys are stored as encrypted secrets).
3. Open **Discord Notifier**, paste a webhook URL
   (Discord: *Channel settings → Integrations → Webhooks*), save, then press **Send test message**.

## Form submissions (Pro)

EmDash's Forms plugin has no cross-plugin hook, so submissions reach Discord through its per-form webhook:

1. Open **Discord Notifier** → *Form submissions relay* and copy the URL.
2. In the Forms plugin, set the form's **Webhook URL** to it.

The URL contains a secret token. Use **Regenerate token** if it leaks.

## Permissions requested

| Permission | Why |
| --- | --- |
| `content:read` | required by the content hooks; resolves public URLs |
| `media:read` | required by the media upload hook |
| `users:read` | required by every comment hook |
| `network:request` → `discord.com`, `discordapp.com` | delivers messages |
| `network:request` → `api.lemonsqueezy.com` | validates Pro / Extended keys |

Public route: `/_emdash/api/plugins/discord-notifier/forms` (Pro), authenticated by the secret token.

## Safety notes

- Webhook URLs must match `https://discord.com/api/webhooks/…`; anything else is refused.
- Messages set `allowed_mentions` so comment text or form values can never ping `@everyone`.
  Only mention types you configured are allowed.
- Discord rate limits (HTTP 429) are honoured once, then the message is dropped and logged.
