# 4-Way Chess — Cost Model

Verified July 2026. Free tiers change; re-check before relying on any number here.

---

## Summary

| Stage | What it covers | Cost |
|---|---|---|
| Phase 0–2 | Engine, board, all three themes, hotseat, bots | **$0** |
| Phase 3 | Accounts, profiles, saved games | **$0** |
| Phase 4 | Correspondence online play + push notifications | **$0** |
| Phase 5 | iOS + Android app store release | **$124 first year, $99/yr after** |
| Phase 6 | Realtime, leaderboards, scale | **$0–25/mo** |

**There is no meaningful up-front cost.** The first unavoidable dollar is Apple's developer fee, and it does
not arrive until Phase 5 — which is realistically many months of work away. Everything before that runs on
free tiers that permit commercial use, or on your own machine.

Optional early spend: a domain, roughly **$10–15/yr** (Cloudflare Registrar sells at cost).

---

## Phase 0–2 — $0

Nothing here touches a hosted service. It is all local development.

| Item | Cost |
|---|---|
| Node, TypeScript, monorepo tooling | Free |
| `@shopify/react-native-skia`, CanvasKit | Free, open source |
| Expo SDK | Free |
| Local dev server | Free |

You could build the entire engine, the board, all three themes, hotseat play and the bots without creating
a single account anywhere.

---

## Phase 3 — accounts, $0

Two viable free options, and the choice hinges on one behavioural difference:

| | Supabase Free | Neon Free |
|---|---|---|
| Storage | 500 MB | 0.5 GB per project, 100 projects |
| Auth | **50,000 MAU included** | Not included — bring your own |
| Compute | Runs continuously | Scale-to-zero, suspends after 5 min |
| **Inactivity** | **Pauses entirely after 1 week, manual unpause** | Resumes instantly, no manual step |
| Other | 5 GB egress, 1 GB files, 500k edge fn calls, 200 realtime conns | Database branching |

**The Supabase auto-pause (tightened Feb 2026) is the thing to know about.** On a solo project with
irregular activity, coming back after a quiet fortnight to a paused database is a real friction. Supabase's
counter-argument is that it bundles auth, storage and realtime, which otherwise become separate
integrations.

If Neon is chosen, auth alternatives on free tiers include Clerk and Better-Auth (self-hosted, free).

---

## Phase 4 — correspondence online, $0

This is the payoff of the correspondence-first decision. Async play needs only HTTP endpoints, a database
and push notifications — no stateful host, no always-on process, no per-connection cost.

| Item | Cost |
|---|---|
| API endpoints (Cloudflare Workers / Netlify Functions) | Free tier |
| Database | Free tier, as above |
| **Expo Push Notifications** | **Free and unlimited** (600/sec rate limit) |

Push being genuinely free and unlimited is one of the better bargains in this stack, and it is precisely
the thing correspondence play depends on.

---

## Phase 5 — mobile, $124 then $99/yr

| Item | Cost |
|---|---|
| **Apple Developer Program** | **$99/year, required, unavoidable** |
| **Google Play Console** | **$25 one-time** |
| EAS Build free tier | 15 iOS + 15 Android cloud builds/month |
| Local builds | Unlimited, free |

### ⚠ Gotcha: you are on Windows, and iOS builds require macOS

Local iOS builds need a Mac. You do not have one, so your only path to an iOS build is **EAS cloud builds**,
where the free tier gives **15 iOS builds per month**. That is usually workable — but it is a hard
dependency rather than a convenience, and if you exceed it the next tier up is a meaningful jump.

Options if 15/month proves tight:
- Batch builds; use Expo Go and dev clients for day-to-day iteration so real builds are rare.
- Borrow or rent a Mac (Mac mini ~$599 one-off, or a cloud Mac by the hour).
- Android-first release — Google Play costs $25 once, has no macOS dependency, and lets the mobile app
  prove itself before Apple's recurring fee starts.

**Recommendation: ship Android first.** It removes the Mac dependency and the $99/yr entirely from the
first mobile release, and the Skia board renderer is identical on both platforms anyway.

---

## Phase 6 — realtime and scale, $0–25/mo

| Option | Free tier | Paid |
|---|---|---|
| SpacetimeDB Maincloud | 2,500 TeV/month energy credits | Pro $25/mo, 100k TeV |
| SpacetimeDB self-hosted | Free (Docker) | Your server cost |
| Node WS server (Fly/Railway/Render) | Small allowances, free tiers spin down | ~$5–20/mo for always-on |

Your instinct is right: **SpacetimeDB has a free tier that is fine for now** — and since it is only a spike
rather than a commitment, it costs nothing either way. Self-hosting via Docker is free if the managed tier
ever becomes a constraint.

---

## ⚠ Gotcha: do not host this on Vercel's free plan

**Vercel's Hobby plan is non-commercial only, and Vercel actively enforces it.** Their definition of
commercial is broad — any deployment used for the financial gain of anyone involved in producing it. Given
this project has logins, leaderboards and eventual monetisation in its plan, the free tier is not available
to you. Vercel Pro is $20/developer/month.

Free alternatives that **do** permit commercial use:

| Host | Free tier | Commercial use |
|---|---|---|
| **Cloudflare Pages** | Unlimited bandwidth, 500 builds/mo | **Allowed** |
| **Netlify** | 100 GB bandwidth, 300 build min, 125k fn calls | **Allowed** |

**Recommendation: Cloudflare Pages.** Unlimited bandwidth on the free tier matters for a game shipping a
multi-MB CanvasKit WASM payload, and the commercial-use permission means you never have to migrate later.
This changes nothing about the code — Next.js deploys to Cloudflare fine — but it is far cheaper to decide
now than to move a live product.

---

## The real discretionary cost: art and sound

This is the only place meaningful money could go, and it is entirely optional.

| Approach | Cost |
|---|---|
| I generate a custom SVG piece set | $0 |
| Open-licensed sets (Cburnett, Merida, etc.) | $0 — **check licences carefully**; several are copyleft or require attribution |
| Commissioned custom piece family | ~$300–1,500 |
| Sound: freesound.org CC0 | $0 |
| Commissioned sound design | ~$200–800 |

Given three themes (RISKS.md R10), commissioning triples if each theme needs distinct silhouettes. The
mitigation stands: one piece *geometry*, three *treatments*.

---

## Bottom line

Start building. Through Phase 4 you will spend **nothing** beyond an optional domain. The decisions that
save you money later — Cloudflare over Vercel, Android before iOS, SpacetimeDB as a spike rather than a
commitment — are all free to make right now and expensive to reverse once there is a live product.
