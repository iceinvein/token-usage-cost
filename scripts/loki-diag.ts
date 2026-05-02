import { lokiConfigFromEnv } from "../src/loki-sink";

const cfg = lokiConfigFromEnv();
if (!cfg) process.exit(1);

const auth = "Basic " + Buffer.from(`${cfg.username ?? ""}:${cfg.password ?? ""}`).toString("base64");
const headers: Record<string, string> = { Authorization: auth };

// Count over a much larger window (30d) to see if events landed earlier
async function count(rangeWindow: string, lookback: number) {
  const url = new URL(cfg.url + "/loki/api/v1/query");
  url.searchParams.set("query", `sum(count_over_time({service="claude-cost"}[${rangeWindow}]))`);
  url.searchParams.set("time", String(Date.now() * 1_000_000));
  const res = await fetch(url, { headers });
  const j = await res.json();
  console.log(`window=${rangeWindow} ->`, JSON.stringify(j.data?.result));
}

await count("1h", 1);
await count("6h", 6);
await count("24h", 24);
await count("48h", 48);
await count("7d", 168);
await count("30d", 720);

// All-time series scan over 30d
const seriesUrl = new URL(cfg.url + "/loki/api/v1/series");
seriesUrl.searchParams.append("match[]", '{service="claude-cost"}');
seriesUrl.searchParams.set("start", String((Date.now() - 30 * 24 * 3600 * 1000) * 1_000_000));
seriesUrl.searchParams.set("end", String(Date.now() * 1_000_000));
const sres = await fetch(seriesUrl, { headers });
const sj = await sres.json();
const shards = new Set<string>();
const tools = new Set<string>();
for (const s of sj.data ?? []) {
  if (s.__time_shard__) shards.add(s.__time_shard__);
  if (s.tool) tools.add(s.tool);
}
console.log(`\nstreams: ${(sj.data ?? []).length}`);
console.log(`unique time shards: ${shards.size}`);
console.log(`tools: ${[...tools].join(", ")}`);
const sortedShards = [...shards].sort();
console.log("first 5 shards:", sortedShards.slice(0, 5).map(s => {
  const [a, b] = s.split("_").map(Number);
  return `${new Date(a*1000).toISOString()} - ${new Date(b*1000).toISOString()}`;
}));
console.log("last 5 shards:", sortedShards.slice(-5).map(s => {
  const [a, b] = s.split("_").map(Number);
  return `${new Date(a*1000).toISOString()} - ${new Date(b*1000).toISOString()}`;
}));

// Check oldest entry overall (last 30d)
const qrUrl = new URL(cfg.url + "/loki/api/v1/query_range");
qrUrl.searchParams.set("query", '{service="claude-cost"}');
qrUrl.searchParams.set("start", String((Date.now() - 30 * 24 * 3600 * 1000) * 1_000_000));
qrUrl.searchParams.set("end", String(Date.now() * 1_000_000));
qrUrl.searchParams.set("limit", "3");
qrUrl.searchParams.set("direction", "forward");
const qrRes = await fetch(qrUrl, { headers });
const qrj = await qrRes.json();
console.log("\noldest (30d window):");
for (const s of qrj.data?.result ?? []) {
  for (const [t, line] of s.values ?? []) {
    console.log("  ts_ns:", t, "->", new Date(Number(BigInt(t) / 1_000_000n)).toISOString());
  }
}
