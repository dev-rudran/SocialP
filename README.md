# SocialP

A privacy-first, peer-to-peer photo & video sharing app. Feed, stories, profiles, likes and comments, but **no accounts and no servers that store your data**.

- **Identity is a keypair.** A new profile generates an Ed25519 keypair in the browser. Your public 32-character ID is `base32(sha256(publicKey)[0..20])`. Everything you publish is signed, so friends can verify authorship even when a post is relayed by someone else.
- **Data lives on your device.** Posts, stories, media and friends are stored in IndexedDB.
- **Sharing is peer-to-peer.** Friends connect directly over WebRTC (DTLS-encrypted). Signaling uses public Nostr relays by default, or your own relay or TURN server (Settings → Network).
- **Friends re-seed.** Friends cache your posts and can serve them to people on your signed friend list while you're offline, and to nobody else.
- **Portable.** Settings → Export creates an encrypted `.socialp` archive (Argon2id + AES-256-GCM). Import it on any device to log in.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (identity, signatures, policy, archive, cache eviction)
npm run build      # production build + PWA service worker
```

To try several users in one browser, add `?slot=<name>` to the URL. Each slot is an independent profile with its own database, e.g. `http://localhost:5173/?slot=alice` and `http://localhost:5173/?slot=bob` in two tabs.

## How it works

```
src/
  core/identity.ts   keypair, ID derivation, sign/verify
  core/records.ts    signed record types: profile, friends, post/story, like, comment, delete
  core/db.ts         Dexie schema, storage rules, garbage collection, cache eviction
  core/archive.ts    encrypted export / import
  core/media.ts      image crop/resize, thumbnails, video posters
  p2p/net.ts         rooms, authentication, sync, media transfer (Trystero)
  p2p/policy.ts      who may receive which record
  routes/, ui/       the app
```

**Rooms.** Every user listens in `inbox:<id>`, where people with your ID drop friend requests. Each friendship gets its own `pair:<hash(a,b)>` room, and that is where syncing happens. Rooms are password-protected with IDs only the participants know. Every peer must sign a challenge to prove it owns its ID before any data is exchanged.

**Sync.** On connect, friends swap manifests (`id`, `ts`), pull the records they're missing, and verify every signature. Media is fetched lazily by SHA-256 hash and checked on arrival. New records are pushed to online friends immediately.

**Visibility.** A record belongs to the author of the post it hangs off. A friend may receive it if they are that author, or appear on the author's latest signed friend list.

**Storage.** Stories expire after 24h. Friends' full-size media not viewed for 7 days is evicted (captions, comments and thumbnails stay, and media is re-fetched on demand). A configurable cap (default 1 GB) evicts the least recently viewed media first. Your own content is never evicted.

## Known limits

- Losing your browser data without an export means losing your profile.
- Removing a friend stops future sharing but can't erase what they already received.
- Direct connections reveal your IP address to friends. Use a TURN relay to avoid that.
- Using the same profile on two devices at the same time isn't supported yet.

## License & credits

Font: JetBrains Mono Nerd Font (SIL Open Font License, see `src/assets/fonts/OFL.txt`).
