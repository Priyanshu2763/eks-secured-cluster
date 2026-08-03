import type {
  ApiErrorBody,
  DetailResponse,
  ListResponse,
  MediaItem,
  PresignResponse,
} from "./types";

/**
 * Where the API lives.
 *
 * In deployment this is a DIFFERENT ORIGIN from the page (api.<DOMAIN> vs
 * app.<DOMAIN>), because the API sits behind API Gateway while the SPA is
 * served as static files. That means every call is genuinely cross-origin and
 * triggers a CORS preflight, which API Gateway answers.
 *
 * Locally it defaults to "" so requests are same-origin and Vite's dev proxy
 * forwards them — keeping development behaviour close to production rather
 * than papering over CORS until deploy day.
 */
const BASE = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: { path: string; message: string }[];

  constructor(status: number, body: ApiErrorBody | null, fallback: string) {
    super(body?.error?.message ?? fallback);
    this.name = "ApiError";
    this.status = status;
    this.code = body?.error?.code ?? "UNKNOWN";
    this.details = body?.error?.details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch {
    // fetch() rejects only on network-level failure. A blocked CORS preflight
    // lands here too, which is why the message names it explicitly — it is by
    // far the most common cause of this branch in this app.
    throw new ApiError(0, null, "Network error, or the request was blocked by CORS");
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const body = text ? (safeJson(text) as ApiErrorBody | null) : null;

  if (!res.ok) {
    throw new ApiError(res.status, body, `Request failed with status ${res.status}`);
  }
  return (body as T) ?? (undefined as T);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  list(params: {
    type?: "video" | "audio";
    q?: string;
    cursor?: string;
    limit?: number;
  }): Promise<ListResponse> {
    const qs = new URLSearchParams();
    if (params.type) qs.set("type", params.type);
    if (params.q) qs.set("q", params.q);
    if (params.cursor) qs.set("cursor", params.cursor);
    if (params.limit) qs.set("limit", String(params.limit));
    const suffix = qs.toString() ? `?${qs}` : "";
    return request<ListResponse>(`/api/media${suffix}`);
  },

  get(id: string): Promise<DetailResponse> {
    return request<DetailResponse>(`/api/media/${encodeURIComponent(id)}`);
  },

  update(
    id: string,
    patch: { title?: string; description?: string },
  ): Promise<{ item: MediaItem }> {
    return request(`/api/media/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    });
  },

  remove(id: string): Promise<void> {
    return request<void>(`/api/media/${encodeURIComponent(id)}`, { method: "DELETE" });
  },

  presign(input: {
    filename: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<PresignResponse> {
    return request<PresignResponse>("/api/uploads/presign", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  confirm(input: {
    uploadId: string;
    title: string;
    description?: string;
    durationSec?: number;
  }): Promise<{ item: MediaItem }> {
    return request("/api/media", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
};

/**
 * PUT the file straight to S3 using the presigned URL.
 *
 * XMLHttpRequest rather than fetch, for one reason: fetch has no upload
 * progress event. For a 200 MB video a progress bar is not decoration, it is
 * the difference between "working" and "frozen".
 *
 * The headers come from the server's requiredHeaders and are sent verbatim.
 * Content-Type and Content-Length were bound into the signature, so any
 * deviation — a charset appended, a different byte count — produces
 * SignatureDoesNotMatch from S3 rather than a helpful error.
 *
 * Content-Length is NOT set here: the browser derives it from the body and
 * forbids scripts from setting it. It still gets signed and still gets checked;
 * we simply must not (and cannot) write it ourselves.
 */
export function uploadToS3(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);

    for (const [name, value] of Object.entries(headers)) {
      // Skip forbidden headers the browser manages itself.
      if (name.toLowerCase() === "content-length") continue;
      xhr.setRequestHeader(name, value);
    }

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
        return;
      }
      // S3 returns XML errors. Surface the code, which is usually enough to
      // tell SignatureDoesNotMatch from AccessDenied from EntityTooLarge.
      const code = /<Code>([^<]+)<\/Code>/.exec(xhr.responseText)?.[1];
      reject(new Error(code ? `S3 rejected the upload: ${code}` : `Upload failed (${xhr.status})`));
    };

    xhr.onerror = () =>
      reject(new Error("Upload failed. Check the bucket CORS configuration."));
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));

    signal?.addEventListener("abort", () => xhr.abort(), { once: true });

    xhr.send(file);
  });
}

/**
 * Read a media file's duration in the browser so the table can show it.
 *
 * Purely cosmetic, and treated as such: the server accepts this value but
 * never relies on it. Resolves to undefined rather than rejecting, because a
 * file whose duration cannot be probed is still a perfectly valid upload.
 */
export function probeDuration(file: File): Promise<number | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
    const done = (value: number | undefined) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    el.preload = "metadata";
    el.onloadedmetadata = () =>
      done(Number.isFinite(el.duration) ? Math.round(el.duration) : undefined);
    el.onerror = () => done(undefined);
    el.src = url;
    setTimeout(() => done(undefined), 5000);
  });
}
