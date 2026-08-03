import type { MediaListEntry } from "../types";
import { formatBytes, formatDuration, formatRelative } from "../format";

interface Props {
  items: MediaListEntry[];
  loading: boolean;
  onPlay: (id: string) => void;
  onEdit: (item: MediaListEntry) => void;
  onDelete: (item: MediaListEntry) => void;
}

/**
 * The CRUD surface. Every row exercises a different endpoint, which is exactly
 * why the table is the centre of the demo rather than an afterthought.
 *
 * On escaping: `title` is user-supplied and rendered here as a JSX expression,
 * which React escapes automatically. That is the whole defence against stored
 * XSS, and it holds as long as nobody reaches for dangerouslySetInnerHTML.
 * Don't.
 */
export function MediaTable({ items, loading, onPlay, onEdit, onDelete }: Props) {
  if (loading && items.length === 0) {
    return <p className="muted">Loading…</p>;
  }

  if (items.length === 0) {
    return (
      <div className="empty">
        <p>Nothing here yet.</p>
        <p className="muted">Upload an audio or video file to get started.</p>
      </div>
    );
  }

  return (
    <div className="tablewrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col" className="col-type">
              <span className="visually-hidden">Type</span>
            </th>
            <th scope="col">Title</th>
            <th scope="col" className="col-num">
              Size
            </th>
            <th scope="col" className="col-num">
              Length
            </th>
            <th scope="col">Uploaded</th>
            <th scope="col" className="col-actions">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.mediaId}>
              <td className="col-type">
                <span
                  className="typeicon"
                  title={item.mediaType}
                  aria-label={item.mediaType}
                  role="img"
                >
                  {item.mediaType === "video" ? "🎬" : "🎵"}
                </span>
              </td>
              <td className="cell-title">
                <span title={item.title}>{item.title}</span>
                {item.status !== "ready" && (
                  <span className={`badge badge--${item.status}`}>{item.status}</span>
                )}
              </td>
              <td className="col-num">{formatBytes(item.sizeBytes)}</td>
              <td className="col-num">{formatDuration(item.durationSec)}</td>
              <td title={new Date(item.createdAt).toLocaleString()}>
                {formatRelative(item.createdAt)}
              </td>
              <td className="col-actions">
                <button
                  type="button"
                  className="iconbutton"
                  onClick={() => onPlay(item.mediaId)}
                  title="Play"
                  aria-label={`Play ${item.title}`}
                >
                  ▶
                </button>
                <button
                  type="button"
                  className="iconbutton"
                  onClick={() => onEdit(item)}
                  title="Edit"
                  aria-label={`Edit ${item.title}`}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="iconbutton iconbutton--danger"
                  onClick={() => onDelete(item)}
                  title="Delete"
                  aria-label={`Delete ${item.title}`}
                >
                  🗑
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
