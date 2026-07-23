"use strict";

// One-off proxy refresh, runnable directly (e.g. `npm run refresh-proxies`)
// or from a cron job, independent of the bot process.
require("dotenv").config();
const { refreshProxies } = require("../src/utils/proxyRefresh");

refreshProxies()
  .then(({ candidates, working }) => {
    console.log(`Done: ${working}/${candidates} candidates validated and saved.`);
    process.exit(working > 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("Proxy refresh failed:", err);
    process.exit(1);
  });
