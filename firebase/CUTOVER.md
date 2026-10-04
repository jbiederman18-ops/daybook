# Daybook: lock the database down

Do the steps in order. Nothing breaks until step 5, and steps 1-4 can be undone.

## 1. Put the new files live
- Replace `FoodlogLG.html` in your repo with the patched one (or run
  `node apply-auth-patch.mjs FoodlogLG.html` in the repo), commit, and let GitHub Pages publish.
- Cloudflare -> your `daybook-siri` worker -> Edit code -> paste `siri-worker.js` -> Deploy.
  Open the worker's address in a browser: it should say version `2026-10-04 auth-1`.
  If the worker has a Cron Trigger (Settings -> Triggers), delete it. Oura is gone.

## 2. Give the worker its own Firebase identity
- Firebase console -> Project settings -> Service accounts -> Generate new private key.
- Open the downloaded .json, copy all of it, and add it to the worker as a secret named `FIREBASE_SA`.
- Delete the downloaded file afterwards. Don't paste it into a chat.
- Test: run the Siri Shortcut once. It should log as before. (The worker prefers
  `FIREBASE_SA` over `FIREBASE_SECRET` as soon as it exists.)

## 3. Sign in on each device
- Settings -> Sync. Paste the Web API key (Project settings -> General -> Web API key).
- Email and password of the user you created -> Sign in. You should see "Signed in and synced".
- Do this on the phone, iPad and any browser that syncs.
- Check: log something on one device, then Sync now on another.

## 4. Repoint the Health Shortcut
- Your "Daybook Moved" Shortcut currently writes straight to Firebase with the secret.
  Change its URL to `https://YOUR-WORKER.workers.dev/active`, method POST, header
  `x-log-token: YOUR LOG_TOKEN`, JSON body `{"active": <Active Energy>, "date": "<yyyy-MM-dd>"}`.
- Run it once and confirm the Moved figure appears in the app.
  (If you'd like me to check the Shortcut first, describe its actions and I'll adjust the steps.)

## 5. Tighten the rules (this is the actual fix)
- Firebase console -> Realtime Database -> Rules -> paste `database.rules.json` -> Publish.
- Sync on each device once more. Everything should still work.
- If anything fails, Rules -> history -> restore the previous version. That's the rollback.

## 6. Retire the old secret
- In the app on each device, clear the "Legacy secret" field and Save.
- Remove `FIREBASE_SECRET` from the worker.
- Firebase console -> Project settings -> Service accounts -> Database secrets -> delete it.
- Google Cloud console -> APIs & Services -> Credentials -> the browser API key: restrict it to
  HTTP referrers `https://YOURNAME.github.io/*`, and to the Identity Toolkit and Token Service APIs.
- Realtime Database -> Data: delete the `ouraAuth` node if it's there.

Then the Firebase warning should clear within a day or so.
