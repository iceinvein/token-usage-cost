import { lokiConfigFromEnv } from "../src/loki-sink";

const cfg = lokiConfigFromEnv();
if (!cfg) {
  console.error("no LOKI_URL");
  process.exit(1);
}

const auth = "Basic " + Buffer.from(`${cfg.username ?? ""}:${cfg.password ?? ""}`).toString("base64");
const headers: Record<string, string> = { Authorization: auth };
if (cfg.tenantId) headers["X-Scope-OrgID"] = cfg.tenantId;

const nowNs = Date.now() * 1_000_000;
const startNs = (Date.now() - 7 * 24 * 3600 * 1000) * 1_000_000;

async function instant(q: string) {
  const url = new URL(cfg.url + "/loki/api/v1/query");
  url.searchParams.set("query", q);
  url.searchParams.set("time", String(nowNs));
  const res = await fetch(url, { headers });
  console.log("---", q, "HTTP", res.status);
  console.log((await res.text()).slice(0, 600));
}

async function range(q: string) {
  const url = new URL(cfg.url + "/loki/api/v1/query_range");
  url.searchParams.set("query", q);
  url.searchParams.set("start", String(startNs));
  url.searchParams.set("end", String(nowNs));
  url.searchParams.set("step", "1d");
  const res = await fetch(url, { headers });
  console.log("---range", q, "HTTP", res.status);
  console.log((await res.text()).slice(0, 1200));
}

await instant('sum(count_over_time({service="claude-cost"}[7d]))');
await instant('sum by (tool) (count_over_time({service="claude-cost"}[7d]))');
await instant('sum by (team, env) (count_over_time({service="claude-cost"}[7d]))');
await range('sum(count_over_time({service="claude-cost"}[24h]))');

const seriesUrl = new URL(cfg.url + "/loki/api/v1/series");
seriesUrl.searchParams.append("match[]", '{service="claude-cost"}');
seriesUrl.searchParams.set("start", String(startNs));
seriesUrl.searchParams.set("end", String(nowNs));
const sres = await fetch(seriesUrl, { headers });
console.log("---series HTTP", sres.status);
console.log((await sres.text()).slice(0, 1500));

console.log("\n\n========= per-day breakdown =========");
async function rangeStep(q: string, step: string) {
  const url = new URL(cfg.url + "/loki/api/v1/query_range");
  url.searchParams.set("query", q);
  url.searchParams.set("start", String(startNs));
  url.searchParams.set("end", String(nowNs));
  url.searchParams.set("step", step);
  const res = await fetch(url, { headers });
  console.log("---", q, "step=", step, "HTTP", res.status);
  const json = await res.json();
  if (json?.data?.result) {
    for (const series of json.data.result) {
      console.log("metric:", JSON.stringify(series.metric));
      for (const [t, v] of series.values) {
        console.log("  ", new Date(t * 1000).toISOString(), "->", v);
      }
    }
  } else {
    console.log(JSON.stringify(json).slice(0, 400));
  }
}

await rangeStep('sum(count_over_time({service="claude-cost"}[1h]))', '1h');
await rangeStep('sum by (tool) (count_over_time({service="claude-cost"}[1d]))', '1d');

console.log("\n========= raw oldest 5 entries within 7d =========");
{
  const url = new URL(cfg.url + "/loki/api/v1/query_range");
  url.searchParams.set("query", '{service="claude-cost"}');
  url.searchParams.set("start", String(startNs));
  url.searchParams.set("end", String(nowNs));
  url.searchParams.set("limit", "5");
  url.searchParams.set("direction", "forward");
  const res = await fetch(url, { headers });
  console.log("HTTP", res.status);
  console.log((await res.text()).slice(0, 2000));
}

console.log("\n========= raw newest 5 entries within 7d =========");
{
  const url = new URL(cfg.url + "/loki/api/v1/query_range");
  url.searchParams.set("query", '{service="claude-cost"}');
  url.searchParams.set("start", String(startNs));
  url.searchParams.set("end", String(nowNs));
  url.searchParams.set("limit", "5");
  url.searchParams.set("direction", "backward");
  const res = await fetch(url, { headers });
  console.log("HTTP", res.status);
  console.log((await res.text()).slice(0, 2000));
}
