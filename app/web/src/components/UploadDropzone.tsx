import { useCallback, useRef, useState } from "react";
import { api, probeDuration, uploadToS3 } from "../api";
import { ALLOWED_TYPES, formatBytes, validateFile } from "../format";

type Phase = "idle" | "presigning" | "uploading" | "confirming";

interface Props {
  onUploaded: () => void;
}

/**
 * The three-step upload, which is the most interesting flow in the app:
 *
 *   1. POST /api/uploads/presign  -> the server picks the S3 key and returns a
 *                                    short-lived signed URL plus a ticket id.
 *   2. PUT <signed url>           -> bytes go straight to S3. They never touch
 *                                    the API, which is not just an
 *                                    optimisation: API Gateway caps payloads
 *                                    at 10 MB, so proxying is impossible.
 *   3. POST /api/media            -> the server verifies the object really
 *                                    landed and creates the row.
 *
 * Step 2 can succeed and step 3 fail. That leaves an object in S3 with no row
 * pointing at it — deliberately harmless, because the bucket lifecycle rule
 * expires unreferenced uploads and the ticket TTLs out.
 */
export function UploadDropzone({ onUploaded }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [filename, setFilename] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const busy = phase !== "idle";

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);

      const problem = validateFile(file);
      if (problem) {
        setError(problem);
        return;
      }

      setFilename(file.name);
      setProgress(0);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        setPhase("presigning");
        const [presigned, durationSec] = await Promise.all([
          api.presign({
            filename: file.name,
            contentType: file.type,
            sizeBytes: file.size,
          }),
          probeDuration(file),
        ]);

        setPhase("uploading");
        await uploadToS3(
          presigned.uploadUrl,
          file,
          presigned.requiredHeaders,
          setProgress,
          controller.signal,
        );

        setPhase("confirming");
        await api.confirm({
          uploadId: presigned.uploadId,
          // Default the title to the filename minus its extension. The user
          // can rename it inline afterwards.
          title: file.name.replace(/\.[^.]+$/, "").slice(0, 200) || file.name,
          ...(durationSec !== undefined ? { durationSec } : {}),
        });

        onUploaded();
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          setError("Upload cancelled.");
        } else {
          setError((err as Error)?.message ?? "Upload failed.");
        }
      } finally {
        setPhase("idle");
        setProgress(0);
        abortRef.current = null;
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [onUploaded],
  );

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  };

  return (
    <section
      className={`dropzone${dragging ? " dropzone--active" : ""}${busy ? " dropzone--busy" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      aria-busy={busy}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ALLOWED_TYPES.join(",")}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />

      {!busy && (
        <>
          <div className="dropzone__icon" aria-hidden="true">
            ⬆
          </div>
          <p className="dropzone__title">
            Drop an audio or video file here, or{" "}
            <button
              type="button"
              className="linkbutton"
              onClick={() => inputRef.current?.click()}
            >
              browse
            </button>
          </p>
          <p className="dropzone__hint">
            mp4 · webm · mp3 · wav · ogg — up to {formatBytes(209_715_200)}
          </p>
        </>
      )}

      {busy && (
        <div className="upload">
          <div className="upload__row">
            <span className="upload__name" title={filename}>
              {filename}
            </span>
            <span className="upload__phase">
              {phase === "presigning" && "preparing…"}
              {phase === "uploading" && `${Math.round(progress * 100)}%`}
              {phase === "confirming" && "finishing…"}
            </span>
          </div>
          <div
            className="progress"
            role="progressbar"
            aria-valuenow={Math.round(progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={`progress__bar${phase !== "uploading" ? " progress__bar--pulse" : ""}`}
              style={{ width: phase === "uploading" ? `${progress * 100}%` : "100%" }}
            />
          </div>
          {phase === "uploading" && (
            <button
              type="button"
              className="linkbutton"
              onClick={() => abortRef.current?.abort()}
            >
              Cancel
            </button>
          )}
        </div>
      )}

      {error && (
        <p className="alert alert--error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
