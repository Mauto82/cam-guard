import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractFromZip } from "./zip.js";

export type NudeNetModel = "320n" | "640m";

/**
 * Where a model comes from. Weights are published by the NudeNet project and
 * are NOT part of this repository: they are fetched on first use and checked
 * against a pinned sha256, so a tampered or truncated file is refused.
 */
export type ModelSource =
  /** A file inside a zip (the PyPI wheel ships 320n). Anonymous. */
  | { kind: "zip"; url: string; sha256: string; entry: string }
  /**
   * A GitHub release asset. NudeNet's release assets require a signed-in
   * GitHub account, so this needs `GITHUB_TOKEN` (any token, no scopes).
   */
  | { kind: "github-asset"; apiUrl: string };

export interface ModelInfo {
  file: string;
  /** Square input side the model was exported with. */
  inputSize: number;
  bytes: number;
  sha256: string;
  sources: ModelSource[];
}

export const MODELS: Record<NudeNetModel, ModelInfo> = {
  "320n": {
    file: "nudenet-320n.onnx",
    inputSize: 320,
    bytes: 12_150_158,
    sha256: "c15d8273adad2d0a92f014cc69ab2d6c311a06777a55545f2c4eb46f51911f0f",
    sources: [
      {
        kind: "zip",
        url: "https://files.pythonhosted.org/packages/1c/ee/1aa02d44ba958cc77e16ff1e41a0aac5e721037db7bf62b9c9d124917f87/nudenet-3.4.2-py3-none-any.whl",
        sha256: "5937dbd84e5d8e5de038f08ffea5a1bb50a08475776bf2b4795914ce0eaf0331",
        entry: "nudenet/320n.onnx",
      },
      { kind: "github-asset", apiUrl: "https://api.github.com/repos/notAI-tech/NudeNet/releases/assets/176831997" },
    ],
  },
  "640m": {
    file: "nudenet-640m.onnx",
    inputSize: 640,
    bytes: 103_538_690,
    sha256: "04fe3d77980780c1f8297dc6d7f942fd5b3abe6942a188f742a85241e4f634eb",
    sources: [
      { kind: "github-asset", apiUrl: "https://api.github.com/repos/notAI-tech/NudeNet/releases/assets/176832019" },
    ],
  },
};

/** `$CAM_GUARD_MODELS_DIR`, else `$XDG_CACHE_HOME/cam-guard/models`, else `~/.cache/cam-guard/models`. */
export function defaultModelsDir(): string {
  if (process.env.CAM_GUARD_MODELS_DIR) return process.env.CAM_GUARD_MODELS_DIR;
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(cache, "cam-guard", "models");
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export interface EnsureModelOptions {
  dir?: string;
  /** Defaults to `process.env.GITHUB_TOKEN`. */
  githubToken?: string;
  log?: (message: string) => void;
  fetch?: typeof fetch;
}

async function download(url: string, headers: Record<string, string>, fetchImpl: typeof fetch): Promise<Buffer> {
  const res = await fetchImpl(url, { redirect: "follow", headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  // A sign-in wall answers 200 with an HTML page: never mistake it for weights.
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/html")) throw new Error(`${url} answered with an HTML page (sign-in required?)`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchFrom(source: ModelSource, opts: EnsureModelOptions, fetchImpl: typeof fetch): Promise<Buffer> {
  if (source.kind === "zip") {
    const zip = await download(source.url, {}, fetchImpl);
    const got = sha256(zip);
    if (got !== source.sha256) throw new Error(`${source.url}: sha256 ${got}, expected ${source.sha256}`);
    return extractFromZip(zip, source.entry);
  }
  const token = opts.githubToken ?? process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GitHub release assets of NudeNet require GITHUB_TOKEN (a token with no scopes is enough)");
  return download(
    source.apiUrl,
    { Accept: "application/octet-stream", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    fetchImpl,
  );
}

/**
 * Path to the model on disk, fetching it the first time.
 *
 * Written to a temp file and renamed only after the hash checks out, so an
 * interrupted run never leaves a half file that the next run would load.
 */
export async function ensureModel(model: NudeNetModel, opts: EnsureModelOptions = {}): Promise<string> {
  const info = MODELS[model];
  const dir = opts.dir ?? defaultModelsDir();
  const path = join(dir, info.file);
  const log = opts.log ?? (() => {});

  if ((await stat(path).catch(() => null))?.isFile()) {
    const got = sha256(await readFile(path));
    if (got === info.sha256) return path;
    throw new Error(`${path} has sha256 ${got}, expected ${info.sha256}. Delete it to fetch it again.`);
  }

  const failures: string[] = [];
  for (const source of info.sources) {
    const where = source.kind === "zip" ? source.url : source.apiUrl;
    log(`downloading NudeNet ${model} from ${where}`);
    let data: Buffer;
    try {
      data = await fetchFrom(source, opts, opts.fetch ?? fetch);
    } catch (err) {
      failures.push((err as Error).message);
      continue;
    }
    const got = sha256(data);
    if (got !== info.sha256) {
      failures.push(`${where}: model sha256 ${got}, expected ${info.sha256}`);
      continue;
    }
    await mkdir(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.part`;
    try {
      await writeFile(tmp, data);
      await rename(tmp, path);
    } finally {
      await rm(tmp, { force: true });
    }
    log(`saved ${path} (${(data.length / 1e6).toFixed(1)} MB)`);
    return path;
  }

  throw new Error(
    `could not obtain NudeNet ${model}:\n  - ${failures.join("\n  - ")}\n` +
      `Alternatively download it yourself and place it at ${path} (sha256 ${info.sha256}).`,
  );
}
