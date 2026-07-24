import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";

export const PROFILES = {
  general: {
    description: "General web search with stable broad sources.",
    engines: ["brave", "google", "wikipedia"],
    category: "general",
  },
  news: {
    description: "Recent news and current events.",
    engines: ["brave.news", "google news", "reuters", "brave", "google"],
    category: "news",
  },
  tech: {
    description: "Technical documentation, code, and engineering sources.",
    engines: ["brave", "google", "github", "stackoverflow", "mdn", "arxiv"],
    category: "general,it,science",
  },
  academic: {
    description: "Academic papers and research indexes.",
    engines: ["google scholar", "arxiv", "semantic scholar", "pubmed"],
    category: "science,scientific publications",
  },
  images: {
    description: "Image search only.",
    engines: ["brave.images", "google images", "bing images", "openverse"],
    category: "images",
  },
  videos: {
    description: "Video search only.",
    engines: ["brave.videos", "google videos", "bing videos", "youtube"],
    category: "videos",
  },
};

const AUTO_PATTERNS = [
  ["news", /\b(latest|today|yesterday|breaking|news|current events)\b|新闻|时事|最新|今日|昨日/u],
  ["academic", /\b(paper|papers|academic|research|citation|arxiv|scholar)\b|论文|学术|研究|引用/u],
  ["images", /\b(image|images|photo|photos|picture|pictures)\b|图片|照片|图像/u],
  ["videos", /\b(video|videos|watch|纪录片)\b|视频/u],
  ["tech", /\b(api|sdk|code|coding|github|stackoverflow|documentation|docs|programming|error|library|framework)\b|代码|技术|接口|文档|报错|编程/u],
];

export function inferMode(query) {
  for (const [mode, pattern] of AUTO_PATTERNS) {
    if (pattern.test(query)) return mode;
  }
  return "general";
}

export function selectProfile(mode, query) {
  const selected = mode === "auto" ? inferMode(query) : mode;
  if (!PROFILES[selected]) {
    throw cliError(`Unknown search mode: ${mode}`, "usage", 2);
  }
  return { mode: selected, profile: PROFILES[selected] };
}

export function cliError(message, type = "internal", exitCode = 1, retryable = false) {
  const error = new Error(message);
  error.type = type;
  error.exitCode = exitCode;
  error.retryable = retryable;
  return error;
}

export async function assertSafeReadUrl(rawUrl, allowPrivate = false) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw cliError(`Invalid URL: ${rawUrl}`, "usage", 2);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw cliError("Only http and https URLs are allowed", "security", 4);
  }
  if (url.username || url.password) throw cliError("URLs containing credentials are not allowed", "security", 4);
  await resolveTarget(url, allowPrivate);
  return url;
}

export async function fetchPublic(url, options = {}) {
  const allowPrivate = Boolean(options.allowPrivate);
  const maxRedirects = options.maxRedirects ?? 5;
  let current = url;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const target = await resolveTarget(current, allowPrivate);
    const response = await requestPinned(target, options);
    const status = response.statusCode || 0;
    if (![301, 302, 303, 307, 308].includes(status)) {
      return {
        ok: status >= 200 && status < 300,
        status,
        url: current.toString(),
        headers: new Headers(response.headers),
        body: Readable.toWeb(response),
      };
    }
    const location = response.headers.location;
    response.resume();
    if (!location) throw cliError("Redirect response has no Location header", "network", 3);
    current = await assertSafeReadUrl(new URL(location, current).toString(), allowPrivate);
  }
  throw cliError("Too many redirects", "network", 3, true);
}

function isPrivateAddress(address) {
  if (net.isIP(address) === 4) {
    const value = ipv4Number(address);
    return IPV4_BLOCKS.some(([network, bits]) => inCidr(value, ipv4Number(network), bits));
  }
  const normalized = address.toLowerCase();
  const value = ipv6Number(normalized);
  return !inIpv6Cidr(value, ipv6Number("2000::"), 3)
    || inIpv6Cidr(value, ipv6Number("2001:db8::"), 32)
    || inIpv6Cidr(value, ipv6Number("2002::"), 16);
}

const IPV4_BLOCKS = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
];

async function resolveTarget(url, allowPrivate) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses;
  try {
    addresses = net.isIP(hostname)
      ? [hostname]
      : (await dns.lookup(hostname, { all: true, verbatim: true })).map((item) => item.address);
  } catch (error) {
    throw cliError(`DNS lookup failed for ${hostname}: ${error.message}`, "network", 3, true);
  }
  if (!addresses.length) throw cliError(`DNS lookup returned no addresses for ${hostname}`, "network", 3, true);
  if (!allowPrivate && addresses.some(isPrivateAddress)) {
    throw cliError("Private, reserved, or loopback URLs require --allow-private", "security", 4);
  }
  return { url, address: addresses[0], family: net.isIP(addresses[0]) };
}

function requestPinned(target, options) {
  return new Promise((resolve, reject) => {
    const transport = target.url.protocol === "https:" ? https : http;
    const request = transport.request({
      protocol: target.url.protocol,
      hostname: target.url.hostname.replace(/^\[|\]$/g, ""),
      port: target.url.port || undefined,
      path: `${target.url.pathname}${target.url.search}`,
      method: "GET",
      headers: options.headers,
      signal: options.signal,
      lookup: (_hostname, lookupOptions, callback) => {
        const resolved = { address: target.address, family: target.family };
        if (lookupOptions?.all) callback(null, [resolved]);
        else callback(null, resolved.address, resolved.family);
      },
    }, resolve);
    request.once("error", reject);
    request.end();
  });
}

function ipv4Number(address) {
  return address.split(".").reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function inCidr(value, network, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (network & mask);
}

function ipv6Number(address) {
  let input = address.split("%", 1)[0];
  if (input.includes(".")) {
    const index = input.lastIndexOf(":");
    const ipv4 = input.slice(index + 1).split(".").map(Number);
    input = `${input.slice(0, index)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const [left = "", right = ""] = input.split("::");
  const leftParts = left ? left.split(":") : [];
  const rightParts = right ? right.split(":") : [];
  const missing = 8 - leftParts.length - rightParts.length;
  const parts = input.includes("::")
    ? [...leftParts, ...Array(missing).fill("0"), ...rightParts]
    : leftParts;
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part || "0"}`), 0n);
}

function inIpv6Cidr(value, network, bits) {
  const shift = 128n - BigInt(bits);
  return (value >> shift) === (network >> shift);
}
