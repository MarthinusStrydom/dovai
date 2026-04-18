#!/usr/bin/env node
import fs from "node:fs";

const files = [
  "/Users/marthinusjstrydom/.dovai/domains/home_office/compile.json",
  "/Users/marthinusjstrydom/.dovai/domains/ehhoa/compile.json",
];

for (const f of files) {
  if (!fs.existsSync(f)) continue;
  const state = JSON.parse(fs.readFileSync(f, "utf8"));
  let transient = 0;
  let permanent = 0;
  for (const entry of Object.values(state.files)) {
    if (entry.status !== "failed") continue;
    const msg = (entry.error || "").toLowerCase();
    if (
      msg.includes("502") ||
      msg.includes("fetch failed") ||
      msg.includes("econnrefused") ||
      msg.includes("aborted")
    ) {
      entry.status = "pending";
      entry.error = undefined;
      entry.error_transient = undefined;
      transient++;
    } else {
      entry.error_transient = false;
      permanent++;
    }
  }
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, f);
  const domain = f.includes("home_office") ? "home_office" : "ehhoa";
  console.log(`${domain}: reset ${transient} transient → pending, ${permanent} permanent kept`);
}
