import { useEffect, useState } from "react";
import { api } from "../api";
import { Modal } from "./Modal";
import type { MediaListEntry } from "../types";

interface Props {
  entry: MediaListEntry;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Edit title/description.
 *
 * The description is not in the list projection (the GSIs use INCLUDE and
 * deliberately omit it), so opening this dialog fetches the full item first.
 * That is a direct, visible consequence of a DynamoDB cost decision — worth
 * noticing rather than hiding.
 */
export function EditRowModal({ entry, onClose, onSaved }: Props) {
  const [title, setTitle] = useState(entry.title);
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get(entry.mediaId)
      .then((res) => {
        if (cancelled) return;
        setTitle(res.item.title);
        setDescription(res.item.description ?? "");
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entry.mediaId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmed = title.trim();
    if (!trimmed) {
      setError("Title is required.");
      return;
    }

    setSaving(true);
    try {
      await api.update(entry.mediaId, {
        title: trimmed,
        description: description.trim(),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Edit media" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label className="field">
          <span className="field__label">Title</span>
          <input
            className="input"
            value={title}
            maxLength={200}
            disabled={loading || saving}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </label>

        <label className="field">
          <span className="field__label">Description</span>
          <textarea
            className="input"
            rows={4}
            maxLength={2000}
            value={description}
            disabled={loading || saving}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>

        {error && (
          <p className="alert alert--error" role="alert">
            {error}
          </p>
        )}

        <div className="modal__actions">
          <button
            type="button"
            className="button button--ghost"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button type="submit" className="button" disabled={loading || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
