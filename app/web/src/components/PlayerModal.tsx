import { useEffect, useState } from "react";
import { api } from "../api";
import { Modal } from "./Modal";
import { formatBytes, formatDuration } from "../format";
import type { DetailResponse } from "../types";

interface Props {
  mediaId: string;
  onClose: () => void;
}

/**
 * Playback.
 *
 * The media element's src is a presigned GET URL fetched on open. It is minted
 * per request and expires in minutes, so it is never stored anywhere and never
 * shared. That is why this component fetches on mount rather than receiving a
 * URL as a prop — a URL held in parent state would outlive its usefulness and
 * start failing silently.
 *
 * The bytes stream from S3 directly to the browser; the API is not in the data
 * path at all.
 */
export function PlayerModal({ mediaId, onClose }: Props) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get(mediaId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [mediaId]);

  return (
    <Modal title={data?.item.title ?? "Loading…"} onClose={onClose}>
      {error && (
        <p className="alert alert--error" role="alert">
          {error}
        </p>
      )}

      {!error && !data && <p className="muted">Loading…</p>}

      {data && (
        <div className="player">
          {data.item.mediaType === "video" ? (
            <video
              className="player__media"
              src={data.downloadUrl}
              controls
              autoPlay
              preload="metadata"
            />
          ) : (
            <audio className="player__media" src={data.downloadUrl} controls autoPlay />
          )}

          {data.item.description && <p className="player__desc">{data.item.description}</p>}

          <dl className="meta">
            <div>
              <dt>Type</dt>
              <dd>{data.item.contentType}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(data.item.sizeBytes)}</dd>
            </div>
            <div>
              <dt>Length</dt>
              <dd>{formatDuration(data.item.durationSec)}</dd>
            </div>
            <div>
              <dt>Uploaded</dt>
              <dd>{new Date(data.item.createdAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Original file</dt>
              <dd className="truncate">{data.item.originalFilename}</dd>
            </div>
          </dl>

          <p className="muted small">
            This playback link expires in {Math.round(data.expiresIn / 60)} minutes.
          </p>
        </div>
      )}
    </Modal>
  );
}
