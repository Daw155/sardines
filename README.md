# Sardines

A small, mobile-friendly Sardines game coordinator. Python/Flask backend, plain HTML/CSS/JavaScript frontend, and no frontend build step.

## Run locally

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open http://localhost:8000. To try multiple players, use different browsers or private windows. Friends on the same Wi-Fi can open `http://YOUR-LAN-IP:8000` if your firewall allows it. Local room data is stored in `.sardines.sqlite3`.

## Deploy to Vercel with Turso

1. Create a database named `sardines` in the [Turso dashboard](https://app.turso.tech/). Choose a region close to your Vercel function region when available.
2. Copy the **database URL** and generate a **read/write database auth token**. The URL can begin with `libsql://` or `https://`. Use a database token, not a Turso platform/account API token. Keep it server-side.
3. In Vercel, open your project → **Settings → Environment Variables** and add:

   ```text
   TURSO_DATABASE_URL=libsql://your-database-your-organization.turso.io
   TURSO_AUTH_TOKEN=your-database-token
   ```

   Enable **Production** and **Preview** as needed. Use a separate Turso database for Preview if you want test games isolated from production.
4. Push this version to the connected Git repository, or redeploy after saving the variables. Vercel detects Flask from `app.py` and `requirements.txt`; leave build/output overrides unset. No new Python packages or frontend build step are required.
5. Open the deployment URL, create a room, join from another phone, and play a short round. The app automatically creates its `sardines_rooms` table and expiry index on the first database request. No manual SQL migration or cron job is needed.

The [Turso CLI](https://docs.turso.tech/cli/installation) can also create the database and retrieve its connection details:

```sh
turso auth login
turso db create sardines
turso db show sardines --url
turso db tokens create sardines
```

The last command prints a secret: copy it directly to Vercel, not into source control or chat. If the token has an expiry, replace it in Vercel before it expires and redeploy.

Without either Turso variable, local development still uses `.sardines.sqlite3`. If only one variable is set, or Turso is missing on Vercel, the app fails explicitly instead of silently writing to local storage. `.env.example` lists the variables; Flask does not automatically load `.env`, so export variables in your shell when testing Turso locally.

Static assets live in `public/assets` so Vercel serves them through its CDN. Flask serves the same paths locally. References: [Flask on Vercel](https://vercel.com/docs/frameworks/backend/flask), [Turso SQL over HTTP](https://docs.turso.tech/sdk/http/quickstart).

### Switching an existing deployment from Redis

- Add the Turso variables **before pushing/deploying this version**. This version uses Turso only in production; the old Upstash/KV variables are ignored.
- Switch between games. Existing Redis rooms are not copied; players create new rooms after deployment. Saved browser sessions for old rooms return to the entry form when the room is not found.
- The migration does not delete or modify your Redis database. Leave the old integration in place until the Turso deployment is verified, then disconnect it and remove its old environment variables if you no longer need it. Old deployments still running the Redis version can continue using Redis until they are retired.
- To roll back, redeploy the previous code with the original Redis variables still configured. New Turso rooms will not appear in the old Redis deployment.

### Optional live Turso connection check

After exporting the two variables in your terminal, run:

```sh
.venv/bin/python scripts/check_turso.py
```

This initializes the schema, creates a randomly named temporary check row, verifies reads and updates, and removes that row. It does not print credentials. Use this to verify the real service before deployment. The automated test suite runs without cloud credentials and simulates Turso's HTTP responses using real local SQL; it does not prove a live Turso connection works.

## How it works

- Create or join using a name and a six-character room code. Names must be unique within the room. A private random token remembers your place on this browser; a name alone cannot impersonate another player. Clearing browser storage loses that session. One active player per browser profile is supported.
- Everyone, including the host, joins as a seeker. The host sets the number of sardines and shuffles roles; changing the count clears the assignments so they can be shuffled again.
- Start sends the sardines into hiding. All selected sardines must tap **I'm hidden!** before the search stopwatch begins. New players can only join before a round or after it ends; existing players can reconnect at any time.
- Sardines can draft hints while hiding. Once seeking begins, they can send immediately or schedule one hint each for the next five-minute boundary (05:00, 10:00, etc.). A new scheduled hint replaces that sardine's previous queued hint. Sending an immediate hint leaves the scheduled one intact. Scheduled drafts are private until publication; published hints are visible to everyone.
- Seekers toggle whether they found a sardine. The final found vote immediately finishes the round, after which undo is no longer available. The host can end hiding or seeking early after confirmation.
- The host returns everyone to the lobby for another round. Leaving between rounds transfers hosting to the next player. Closing a tab does not remove the player, so they can reconnect; if someone abandons an active round, the host can end it.
- **Edit name** beside your own name in the **Players** card changes your name at any time without changing your identity, role, or progress. Names still need to be unique. Published hints retain the name used when they were sent; queued hints use the author's name at publication.
- The host can open the **Players** card and tap **Kick**, then confirm, in any phase. Kicked players lose access on their next request and return to the entry form. Their queued hints are canceled. During hiding, removing the last unready sardine can start the search; during seeking, removing the last unfound seeker can finish the round. If either role has no players left, the round ends. Lobby kicks clear roles so the host can shuffle again. A kick removes membership, rather than permanently banning someone from joining again between rounds.
- The app opens directly to a name field with Create and code/Join controls on one row. The room screen uses cards in this order: header with room code, round progress, hints, players, host controls, and a red Leave room button. Leaving is available between rounds; the button stays visible but disabled during an active round.

## A free address for the app

Vercel provides a free `your-name.vercel.app` address. To use a cleaner name, open the project in Vercel, go to **Settings → Domains**, and add an available name such as `sardines-with-friends.vercel.app` (or edit the existing Vercel domain if that option is shown). Assign it to Production. Vercel manages DNS and HTTPS for its own subdomains, so no registrar setup is required. See [Vercel's production domains](https://vercel.com/blog/default-production-domain) and [domain settings](https://vercel.com/docs/domains/working-with-domains/add-a-domain).

A standalone domain such as `yourgame.com` normally has a registration/renewal cost; Vercel's free hosting does not include purchasing it. If you already own a domain, you can add a subdomain such as `sardines.yourdomain.com` to this project on Hobby: enter it in **Settings → Domains → Add Domain**, then copy the CNAME record Vercel shows into your DNS provider. Wait for verification. Domain registration costs still apply to the parent domain.

Choose the address before a game: browser sessions are saved per origin, so switching between the old and new domain does not carry over a player's saved session.

## Timing and storage

Clients poll every 2.5 seconds while visible. Timers use server timestamps and render smoothly between polls. Scheduled hints are saved on the server and published atomically by the next room request at or after their boundary, even if the author disconnects. **No background worker or cron is needed:** if every phone is asleep, publication is reconciled when someone opens the app, using the original scheduled timestamp. Hints require a sardine to write and queue them; the app does not invent clues automatically.

SQLite transactions handle local concurrency. Turso uses parameterized SQL and a version check on every write; conflicting requests reload and retry, preventing lost joins, votes, or duplicated scheduled hints across serverless instances. Ordinary polls perform one indexed room lookup and no writes. Room changes refresh the 24-hour expiry; unchanged polls refresh it at most about once an hour per room. Consequently, an idle room expires roughly 23–24 hours after its last activity. Expired rooms are immediately unavailable, and each new-room creation removes up to 100 expired records using the expiry index. Schema setup happens once per store instance, and does not run on every poll. A room supports up to 40 players and retains the most recent 200 hints per round. Scheduled hints are canceled when a round ends.

This is intended for small private friend groups. Anyone with a room code can join between rounds; there is no account system or public directory. For a large public launch, add rate limiting and abuse controls.

## Check the app

```sh
.venv/bin/python -m unittest discover -s tests -v
node --check public/assets/app.js
```

Tests cover round transitions, all-sardines readiness, found/undo, automatic ending, host permissions, kicking during all phases, name changes, revoked access, join restrictions, scheduled hint timing, draft privacy, replay, reconnects, request validation, concurrent joins, Turso conflict retries, expiry, parameter binding, protocol/network failures, and read-only polling.
