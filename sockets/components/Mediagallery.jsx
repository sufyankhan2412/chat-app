import React, { useEffect, useMemo, useState } from "react";
import { getMedia } from "../api";
import { resolveAvatarUrl } from "../utils/avatar";
import { formatFileSize } from "../utils/formatFileSize";
import MediaViewer from "./MediaViewer";

const TABS = [
  { key: "media", label: "Media" },
  { key: "links", label: "Links" },
  { key: "docs", label: "Docs" },
];

// The full "Media, links and docs" screen, opened from the preview row in
// Contact info. Tabbed the same way WhatsApp splits Media / Links / Docs,
// so each type gets its own scrollable list instead of one long page.
export default function MediaGallery({ userId }) {
  const [media, setMedia] = useState([]);
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewerMedia, setViewerMedia] = useState(null);
  const [activeTab, setActiveTab] = useState("media");

  useEffect(() => {
    let isCurrent = true;
    const fetchMedia = async () => {
      try {
        const res = await getMedia(userId);
        if (isCurrent) {
          setMedia(res.data.media || []);
          setLinks(res.data.links || []);
        }
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

  const visualItems = useMemo(
    () => media.filter((m) => m.type === "image" || m.type === "video"),
    [media]
  );
  const fileItems = useMemo(() => media.filter((m) => m.type === "file"), [media]);

  const counts = {
    media: visualItems.length,
    links: links.length,
    docs: fileItems.length,
  };
  const isEmptyOverall = media.length === 0 && links.length === 0;

  if (loading) {
    return (
      <div className="messages-loading">
        <div className="spinner" />
      </div>
    );
  }

  if (isEmptyOverall) {
    return <div className="empty-state">No media, links or docs shared yet</div>;
  }

  return (
    <div className="media-gallery-shell">
      <div className="media-gallery-tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.key}
            className={`media-gallery-tab${activeTab === tab.key ? " active" : ""}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
            {counts[tab.key] > 0 && (
              <span className="media-gallery-tab-count">{counts[tab.key]}</span>
            )}
          </button>
        ))}
      </div>

      <div className="media-gallery-body">
        {activeTab === "media" &&
          (visualItems.length > 0 ? (
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
          ) : (
            <div className="empty-state media-gallery-empty-tab">No media shared yet</div>
          ))}

        {activeTab === "links" &&
          (links.length > 0 ? (
            <div className="media-gallery-links">
              {links.map((l) => (
                <a
                  key={l._id}
                  href={l.link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="media-gallery-link-row"
                >
                  <span className="media-gallery-link-icon" aria-hidden="true">
                    🔗
                  </span>
                  <span className="media-gallery-link-info">
                    <span className="media-gallery-link-url">{l.link.url}</span>
                    {l.link.text && l.link.text !== l.link.url && (
                      <span className="media-gallery-link-context">{l.link.text}</span>
                    )}
                  </span>
                </a>
              ))}
            </div>
          ) : (
            <div className="empty-state media-gallery-empty-tab">No links shared yet</div>
          ))}

        {activeTab === "docs" &&
          (fileItems.length > 0 ? (
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
          ) : (
            <div className="empty-state media-gallery-empty-tab">No documents shared yet</div>
          ))}
      </div>

      <MediaViewer media={viewerMedia} onClose={() => setViewerMedia(null)} />
    </div>
  );
}