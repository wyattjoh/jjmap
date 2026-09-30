/** @jsxImportSource react */
import type { ReactNode } from "react";

/**
 * Envelope glyph used for the wordmark, cards, and empty folders.
 */
export function Envelope() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 6.5h16v12H4zM4 7l8 6 8-6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Shared 3D folder: back, optional filed sheets, and a front with name, corner slot, and stats.
 */
export function FolderArtwork({
  name,
  filled,
  pulse,
  count,
  total,
  attachments,
  children,
}: {
  name: ReactNode;
  filled: boolean;
  pulse: number;
  count: ReactNode;
  total: ReactNode | undefined;
  /**
   * Items stuck onto the folder front, such as sticky notes.
   */
  attachments: ReactNode | undefined;
  children: ReactNode;
}) {
  return (
    <>
      <div className="folder-back" />
      {filled && (
        <div className="filed-sheets">
          <i />
          <i />
          <i />
        </div>
      )}
      <div className={`folder-front ${pulse ? "received" : ""}`} key={pulse}>
        <span className="folder-top">
          <span className="folder-name">{name}</span>
          {count}
        </span>
        {attachments && <span className="folder-attachments">{attachments}</span>}
        {total ?? (
          <span className="folder-mark">
            <Envelope />
          </span>
        )}
        {children}
      </div>
      {Boolean(pulse) && <div className="arrival-ring" key={`ring-${pulse}`} />}
    </>
  );
}

/**
 * Placeholder bar for a value that is still loading.
 */
export function Shimmer({ width }: { width: string }) {
  return <span className="shimmer" style={{ width }} aria-hidden="true" />;
}

/**
 * Non-interactive folder tile shown while folders or categories load; `index` staggers the pulse.
 */
export function GhostFolder({ index }: { index: number }) {
  return (
    <div
      className="folder-choice destination ghost-folder"
      style={{ "--i": index }}
      aria-hidden="true"
    >
      <div className="folder-object">
        <FolderArtwork
          name={<Shimmer width="4.5em" />}
          filled={false}
          pulse={0}
          attachments={undefined}
          count={undefined}
          total={<Shimmer width="2.5em" />}
        >
          <Shimmer width="2.5em" />
        </FolderArtwork>
      </div>
    </div>
  );
}
