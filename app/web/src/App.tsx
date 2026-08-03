import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { UploadDropzone } from "./components/UploadDropzone";
import { MediaTable } from "./components/MediaTable";
import { EditRowModal } from "./components/EditRowModal";
import { PlayerModal } from "./components/PlayerModal";
import type { MediaListEntry } from "./types";

type Filter = "all" | "video" | "audio";

const PAGE_SIZE = 20;

export function App() {
  const [items, setItems] = useState<MediaListEntry[]>([]);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [playing, setPlaying] = useState<string | null>(null);
  const [editing, setEditing] = useState<MediaListEntry | null>(null);

  // Debounce the search box so typing does not fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  /**
   * Guards against a stale response overwriting a newer one. Without this,
   * switching filters quickly can leave you looking at results for a filter
   * you already moved away from, because responses can arrive out of order.
   */
  const requestSeq = useRef(0);

  const load = useCallback(
    async (pageIndex: number) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      try {
        const res = await api.list({
          ...(filter !== "all" ? { type: filter } : {}),
          ...(debouncedSearch ? { q: debouncedSearch } : {}),
          ...(cursors[pageIndex] ? { cursor: cursors[pageIndex] } : {}),
          limit: PAGE_SIZE,
        });
        if (seq !== requestSeq.current) return;
        setItems(res.items);
        setNextCursor(res.nextCursor);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setError((err as Error).message);
        setItems([]);
        setNextCursor(null);
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [filter, debouncedSearch, cursors],
  );

  // Changing filter or search invalidates pagination entirely — cursors are
  // only meaningful for the query that produced them.
  useEffect(() => {
    setCursors([undefined]);
    setPage(0);
  }, [filter, debouncedSearch]);

  useEffect(() => {
    void load(page);
  }, [load, page]);

  const refresh = useCallback(() => {
    setCursors([undefined]);
    setPage(0);
    void load(0);
  }, [load]);

  const goNext = () => {
    if (!nextCursor) return;
    setCursors((prev) => {
      const copy = [...prev];
      copy[page + 1] = nextCursor;
      return copy;
    });
    setPage((p) => p + 1);
  };

  const goPrev = () => setPage((p) => Math.max(0, p - 1));

  const handleDelete = async (item: MediaListEntry) => {
    if (!window.confirm(`Delete "${item.title}"? This cannot be undone.`)) return;
    try {
      await api.remove(item.mediaId);
      // Optimistically drop the row, then reload so pagination stays honest.
      setItems((prev) => prev.filter((i) => i.mediaId !== item.mediaId));
      void load(page);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1 className="brand">MediaVault</h1>
        <p className="muted small">Audio &amp; video uploads on S3, metadata in DynamoDB</p>
      </header>

      <main className="main">
        <UploadDropzone onUploaded={refresh} />

        <div className="toolbar">
          <div className="segmented" role="group" aria-label="Filter by type">
            {(["all", "video", "audio"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={`segmented__item${filter === value ? " is-active" : ""}`}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {value === "all" ? "All" : value === "video" ? "Video" : "Audio"}
              </button>
            ))}
          </div>

          <label className="search">
            <span className="visually-hidden">Search titles</span>
            <input
              className="input"
              type="search"
              placeholder="Search title…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>

          <button
            type="button"
            className="button button--ghost"
            onClick={refresh}
            disabled={loading}
          >
            Refresh
          </button>
        </div>

        {error && (
          <p className="alert alert--error" role="alert">
            {error}
          </p>
        )}

        <MediaTable
          items={items}
          loading={loading}
          onPlay={setPlaying}
          onEdit={setEditing}
          onDelete={handleDelete}
        />

        {/*
          Prev/next rather than page numbers. DynamoDB has no OFFSET — you
          follow an opaque cursor — so "jump to page 7" is not a thing the data
          store can answer cheaply, and pretending otherwise would mean reading
          every preceding page.

          Note also that with a search term active, a page can come back empty
          while nextCursor is still set: the filter is applied AFTER the read.
          So the next button keys off nextCursor, never off items.length.
        */}
        <nav className="pager" aria-label="Pagination">
          <button
            type="button"
            className="button button--ghost"
            onClick={goPrev}
            disabled={page === 0 || loading}
          >
            ‹ Prev
          </button>
          <span className="muted small">Page {page + 1}</span>
          <button
            type="button"
            className="button button--ghost"
            onClick={goNext}
            disabled={!nextCursor || loading}
          >
            Next ›
          </button>
        </nav>
      </main>

      {playing && <PlayerModal mediaId={playing} onClose={() => setPlaying(null)} />}
      {editing && (
        <EditRowModal
          entry={editing}
          onClose={() => setEditing(null)}
          onSaved={() => void load(page)}
        />
      )}
    </div>
  );
}
