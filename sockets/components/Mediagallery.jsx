import React, { useEffect, useState } from "react";
import { getMedia } from "../api";
import { resolveAvatarUrl } from "../utils/avatar";
import { formatFileSize } from "../utils/formatFileSize";
import MediaViewer from "./MediaViewer";

// The full "Media, links and docs" screen, opened from the preview row in
// Contact info. Photos/videos render as a tap-to-preview grid (reusing the
// same fullscreen MediaViewer the chat itself uses); documents render as a
// plain downloadable list underneath, same as WhatsApp does.
export default function MediaGallery({ userId }) {
  const [media, setMedia] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewerMedia, setViewerMedia] = useState(null);

  useEffect(() => {
    let isCurrent = true;
    const fetchMedia = async () => {
      try {
        const res = await getMedia(userId);
        if (isCurrent) setMedia(res.data.media);
      } catch (err) {
        console.error("Failed to fetch media:", err);
      } finally {
        if (isCurrent) setLoading(false);
      }
    };
    fetchMedia();
    return () => {
      isCurrent = false;
    };
  }, [userId]);

  const visualItems = media.filter((m) => m.type === "image" || m.type === "video");
  const fileItems = media.filter((m) => m.type === "file");

  if (loading) {
    return (
      <div className="messages-loading">
        <div className="spinner" />
      </div>
    );
  }

  if (media.length === 0) {
    return <div className="empty-state">No media, links or docs shared yet</div>;
  }

  return (
    <div className="media-gallery-body">
      {visualItems.length > 0 && (
        <div className="media-gallery-grid">
          {visualItems.map((m) => {
            const url = resolveAvatarUrl(m.attachment.url);
            return (
              <button
                key={m._id}
                type="button"
                className="media-gallery-thumb"
                onClick={() =>
                  setViewerMedia({ type: m.type, url, fileName: m.attachment.fileName })
                }
              >
                {m.type === "image" ? (
                  <img src={url} alt={m.attachment.fileName || "photo"} />
                ) : (
                  <>
                    <video src={url} muted preload="metadata" />
                    <span className="media-gallery-play">
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      )}

      {fileItems.length > 0 && (
        <div className="media-gallery-docs">
          {fileItems.map((m) => {
            const url = resolveAvatarUrl(m.attachment.url);
            return (
              <a
                key={m._id}
                href={url}
                download={m.attachment.fileName}
                className="media-gallery-doc-row"
              >
                <span className="media-gallery-doc-icon">📄</span>
                <span className="media-gallery-doc-info">
                  <span className="media-gallery-doc-name">{m.attachment.fileName}</span>
                  <span className="media-gallery-doc-size">
                    {formatFileSize(m.attachment.fileSize)}
                  </span>
                </span>
              </a>
            );
          })}
        </div>
      )}

      <MediaViewer media={viewerMedia} onClose={() => setViewerMedia(null)} />
    </div>
  );
}