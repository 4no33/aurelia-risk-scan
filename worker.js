// Aurelia Solana Risk Scan — Cloudflare Worker edition (x402, USDC on Base).
// Payment flow mirrors the @x402 v2 SDK: 402 + PAYMENT-REQUIRED header;
// on PAYMENT-SIGNATURE, verify then settle via the PayAI facilitator REST API.

const PAY_TO = "0xeB65682C1d9096827ae8A0957495a15D0f9Dc97d";
const FACILITATOR = "https://facilitator.payai.network";
const DESCRIPTION =
  "Solana token rug-risk scan: mint/freeze authority, holder concentration, liquidity and pair age, returned as a 0-100 risk score with flags.";
const ACCEPTS = {
  scheme: "exact",
  network: "eip155:8453",
  amount: "50000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
};
const EXTENSIONS = {
  bazaar: {
    info: {
      input: { type: "http", queryParams: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, method: "GET" },
      output: {
        type: "json",
        example: {
          mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          riskScore: 35,
          grade: "MODERATE",
          flags: [{ code: "MINT_AUTHORITY_ACTIVE", points: 20, detail: "Mint authority is set: new supply can be created." }],
        },
      },
    },
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "http" },
            method: { type: "string", enum: ["GET"] },
            queryParams: {
              type: "object",
              properties: { mint: { type: "string", description: "Solana token mint address (base58, 32-44 chars)" } },
              required: ["mint"],
            },
          },
          required: ["type", "method"],
          additionalProperties: false,
        },
        output: {
          type: "object",
          properties: { type: { type: "string" }, example: { type: "object" } },
          required: ["type"],
        },
      },
      required: ["input"],
    },
  },
};

const b64encode = (obj) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(obj))));
const b64decodeJson = (s) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))));

function paymentRequired(url) {
  const body = { x402Version: 2, error: "Payment required", resource: { url, description: DESCRIPTION, mimeType: "application/json" }, accepts: [ACCEPTS], extensions: EXTENSIONS };
  return new Response(JSON.stringify({ error: "Payment required" }), {
    status: 402,
    headers: { "content-type": "application/json", "PAYMENT-REQUIRED": b64encode(body) },
  });
}

async function facilitator(path, paymentPayload) {
  const r = await fetch(`${FACILITATOR}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: ACCEPTS }),
  });
  if (!r.ok) throw new Error(`facilitator ${path} HTTP ${r.status}`);
  return r.json();
}

// ---- scan logic (ported from scan.mjs; pure fetch) ----
const RPCS = ["https://solana-rpc.publicnode.com", "https://api.mainnet-beta.solana.com"];

async function rpc(method, params) {
  let lastErr;
  for (const url of RPCS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 9000);
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: ctrl.signal,
        });
        const j = await r.json();
        if (j.error) throw new Error(j.error.message || "rpc error");
        return j.result;
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await new Promise((res) => setTimeout(res, 1200));
      } finally {
        clearTimeout(t);
      }
    }
  }
  throw lastErr || new Error("all RPC endpoints failed");
}

async function largestAccounts(mint) {
  for (const url of RPCS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((res) => setTimeout(res, 1500 * attempt));
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 9000);
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenLargestAccounts", params: [mint] }),
          signal: ctrl.signal,
        });
        const j = await r.json();
        if (!j.error && j.result) return j.result;
      } catch {
        /* next */
      } finally {
        clearTimeout(t);
      }
    }
  }
  return null;
}

async function dexPairs(mint) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: ctrl.signal });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.pairs || []).filter((p) => p.chainId === "solana");
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

const validMint = (m) => typeof m === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m);

async function scanToken(mint) {
  const [acct, largest, pairs] = await Promise.all([
    rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]),
    largestAccounts(mint),
    dexPairs(mint),
  ]);
  const info = acct?.value?.data?.parsed?.info;
  if (!info) throw new Error("mint account not found or not a token mint");
  const supply = Number(info.supply) / 10 ** Number(info.decimals || 0);
  const flags = [];
  let risk = 0;
  const add = (points, code, detail) => {
    risk += points;
    flags.push({ code, points, detail });
  };

  if (info.mintAuthority) add(20, "MINT_AUTHORITY_ACTIVE", "Mint authority is set: new supply can be created.");
  else flags.push({ code: "MINT_AUTHORITY_RENOUNCED", points: 0, detail: "Mint authority renounced." });
  if (info.freezeAuthority) add(15, "FREEZE_AUTHORITY_ACTIVE", "Freeze authority is set: holder balances can be frozen.");
  else flags.push({ code: "FREEZE_AUTHORITY_RENOUNCED", points: 0, detail: "Freeze authority renounced." });

  let top1 = null, top10 = null;
  if (largest?.value?.length && supply > 0) {
    const amounts = largest.value.map((a) => Number(a.uiAmount || 0));
    top1 = amounts[0] / supply;
    top10 = amounts.slice(0, 10).reduce((s, x) => s + x, 0) / supply;
    if (top1 > 0.3) add(25, "TOP1_HOLDER_HIGH", `Top holder owns ${(top1 * 100).toFixed(1)}% of supply.`);
    else if (top1 > 0.15) add(15, "TOP1_HOLDER_ELEVATED", `Top holder owns ${(top1 * 100).toFixed(1)}% of supply.`);
    else if (top1 > 0.08) add(8, "TOP1_HOLDER_NOTABLE", `Top holder owns ${(top1 * 100).toFixed(1)}% of supply.`);
    if (top10 > 0.7) add(15, "TOP10_CONCENTRATED", `Top 10 holders own ${(top10 * 100).toFixed(1)}% of supply.`);
    else if (top10 > 0.5) add(10, "TOP10_ELEVATED", `Top 10 holders own ${(top10 * 100).toFixed(1)}% of supply.`);
  } else {
    flags.push({ code: "HOLDER_DATA_UNAVAILABLE", points: 0, detail: "Holder concentration unavailable (public RPC rate limit); score excludes concentration signals." });
  }

  let market = null;
  if (!pairs.length) {
    add(20, "NO_MARKET", "No trading pair found on major Solana DEXes.");
  } else {
    const best = pairs.reduce((a, b) => ((a.liquidity?.usd || 0) > (b.liquidity?.usd || 0) ? a : b));
    const liq = best.liquidity?.usd || 0;
    const ageH = best.pairCreatedAt ? (Date.now() - best.pairCreatedAt) / 3.6e6 : null;
    market = {
      dex: best.dexId,
      pair: best.pairAddress,
      liquidityUsd: Math.round(liq),
      fdvUsd: best.fdv ? Math.round(best.fdv) : null,
      ageHours: ageH !== null ? Math.round(ageH * 10) / 10 : null,
      url: best.url,
    };
    const isPumpMint = mint.endsWith("pump");
    const onCurve = pairs.some((p) => p.dexId === "pumpfun");
    const graduated = pairs.some((p) => p.dexId === "pumpswap" || p.dexId === "raydium");
    if (isPumpMint && onCurve && !graduated) add(10, "STILL_ON_BONDING_CURVE", "pump.fun token still on the bonding curve (not graduated).");
    else if (isPumpMint && graduated) flags.push({ code: "GRADUATED_FROM_PUMPFUN", points: 0, detail: "pump.fun token that graduated to a DEX." });
    if (liq < 5000) add(15, "LIQUIDITY_THIN", `Best pair liquidity is only $${Math.round(liq)}.`);
    else if (liq < 25000) add(8, "LIQUIDITY_LOW", `Best pair liquidity is $${Math.round(liq)}.`);
    if (ageH !== null && ageH < 1) add(10, "PAIR_VERY_NEW", `Best pair is ${Math.round(ageH * 60)} minutes old.`);
    else if (ageH !== null && ageH < 24) add(5, "PAIR_NEW", `Best pair is ${Math.round(ageH)} hours old.`);
  }

  risk = Math.min(100, risk);
  const grade = risk < 20 ? "LOW" : risk < 45 ? "MODERATE" : risk < 70 ? "HIGH" : "CRITICAL";
  return {
    mint,
    riskScore: risk,
    grade,
    flags,
    mintAuthority: info.mintAuthority || null,
    freezeAuthority: info.freezeAuthority || null,
    supply: Math.round(supply),
    decimals: info.decimals,
    top1Share: top1 !== null ? Math.round(top1 * 1000) / 10 : null,
    top10Share: top10 !== null ? Math.round(top10 * 1000) / 10 : null,
    market,
    scannedAt: new Date().toISOString(),
    disclaimer: "Heuristic risk flags from public on-chain data. Not financial advice and not a guarantee of safety or fraud.",
  };
}

const cache = new Map();

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "aurelia-solana-risk-scan", price: "$0.05", network: "base", payTo: PAY_TO });
    }
    if (url.pathname === "/") {
      return Response.json({
        service: "Aurelia Solana Risk Scan",
        endpoint: "GET /scan?mint=<solana-mint-address>",
        price: "$0.05 USDC on Base per call (x402)",
        description: DESCRIPTION,
      });
    }
    if (url.pathname !== "/scan") return Response.json({ error: "not found" }, { status: 404 });

    const sig = request.headers.get("PAYMENT-SIGNATURE");
    if (!sig) return paymentRequired(url.toString());

    let payload;
    try {
      payload = b64decodeJson(sig);
    } catch {
      return paymentRequired(url.toString());
    }

    let verify;
    try {
      verify = await facilitator("/verify", payload);
    } catch (e) {
      return Response.json({ error: `payment verification unavailable: ${e.message}` }, { status: 502 });
    }
    if (!verify.isValid) {
      const res = paymentRequired(url.toString());
      res.headers.set("X-PAYMENT-INVALID-REASON", String(verify.invalidReason || "invalid"));
      return res;
    }

    const mint = url.searchParams.get("mint");
    if (!validMint(mint)) return Response.json({ error: "query parameter 'mint' must be a Solana mint address" }, { status: 400 });

    let data;
    const hit = cache.get(mint);
    if (hit && Date.now() - hit.at < 120_000) data = { ...hit.data, cached: true };
    else {
      try {
        data = await scanToken(mint);
        cache.set(mint, { at: Date.now(), data });
      } catch (e) {
        return Response.json({ error: String(e.message || e) }, { status: 502 });
      }
    }

    let settle;
    try {
      settle = await facilitator("/settle", payload);
    } catch (e) {
      return Response.json({ error: `payment settlement failed: ${e.message}` }, { status: 502 });
    }
    if (!settle.success) return Response.json({ error: `payment settlement failed: ${settle.errorReason || "unknown"}` }, { status: 502 });

    return new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json", "PAYMENT-RESPONSE": b64encode(settle) },
    });
  },
};
