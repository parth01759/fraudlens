# FraudLens MVP

Digital risk protection for **Instagram** and the **Apple App Store**. FraudLens scores accounts and apps that impersonate a brand, using the checks in *FraudLens Detection Logic* (S1–S10 for social, A1–A9 for apps), and never flags the brand's own official assets.

## Run it

Needs **Node.js 18 or newer** (check with `node --version`). No `npm install`: there are no dependencies.

| How | Command | What you get |
| --- | --- | --- |
| Live | double-click `start.bat`, or `node server.js` | Real Instagram profiles and real App Store results |
| Demo | double-click `start-demo.bat`, or `node server.js --demo` | Bundled sample brand, accounts and apps; works with no internet |

Then open **http://localhost:4321**. You can also switch demo data on and off under **Monitoring sources**.

## Hosted demo (Vercel)

The repo deploys to Vercel as-is (`vercel.json` and `api/index.js`). The hosted copy always runs on the bundled demo data, because Vercel's servers can't keep files between requests and Instagram blocks data-centre traffic. Anything changed there is shared by everyone viewing it and resets from time to time, and it never stores Instagram or Graph API credentials. For live data, run it locally as above.

## Use it

1. **Brand profile**: enter the brand name, official Instagram accounts, official iOS apps (bundle ID or App Store ID), official domains and a logo. Select **Look up apps** to confirm the apps and pull the official developer names. Save.
2. **Social monitoring**: paste the Instagram usernames to watch, then **Scan watchlist**. Select **Review** on any row to see every check, its points and its evidence.
3. **Name variants**: generate the usernames an impersonator would register and check which ones exist. Add any that are taken to the watchlist.
4. **App store monitoring**: choose the store country and search terms, then **Scan App Store**.
5. Set a status on each finding (Under review, Resolved, False positive) and export CSV or per-finding evidence (JSON).

The official registry is published at **http://localhost:4321/official-channels.json**. That is the list the "false official claims" check (S7) compares against.

## Data sources and limits

| Source | How | Limits |
| --- | --- | --- |
| Instagram, public profiles (default) | Instagram's own web profile endpoint | No setup. Public profiles only. Instagram often refuses it for logged-out requests (rate limit). FraudLens then reads the public profile page instead: name, picture, follower and post counts only, marked **limited data**. Bio, link and post checks show "not available" and the confidence figure drops to match. Limited copies are retried after 15 minutes. Automated access sits outside Instagram's terms, so keep scans small. |
| Instagram session (optional) | The `sessionid` cookie of a logged-in account, pasted in **Monitoring sources** | Gives full data when the logged-out route is blocked. Use a spare account: Instagram can restrict accounts used for automated reads. To get it: log in on instagram.com, open developer tools → Application → Cookies → `sessionid`, copy the value. |
| Instagram Graph API (optional) | Business Discovery, with your token and business account ID set in **Monitoring sources** | Official and reliable. Sees business and creator accounts only. |
| Apple App Store | iTunes Search and Lookup API | Free, no key, about 20 requests a minute. Cached 1 h. |

Account creation dates are not public on Instagram. FraudLens compares account IDs (they increase over time, so a higher ID was created later) and, for accounts with 12 or fewer posts, the date of the first post.

## Files

- `server.js`: the local server, the Instagram and App Store adapters, the image proxy and storage.
- `public/js/detect.js`: the detection engine (brand profile validation, S1–S10, A1–A9, guardrails, name variants).
- `public/js/app.js`, `public/js/views.js`: the interface.
- `data/`: your brand profile, watchlist, findings, last scans and cache, created on first run. Delete the folder to start fresh.
- `fixtures/`: the demo data.
