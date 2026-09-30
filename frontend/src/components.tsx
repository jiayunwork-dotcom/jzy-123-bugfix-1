export function ErrorBanner({ message, onClose }: { message: string | null; onClose?: () => void }) {
  if (!message) return null;
  return (
    <div className="banner banner-error" role="alert">
      <span>{message}</span>
      {onClose && (
        <button className="banner-close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      )}
    </div>
  );
}

export function NoticeBanner({ message, onClose }: { message: string | null; onClose?: () => void }) {
  if (!message) return null;
  return (
    <div className="banner banner-ok" role="status">
      <span>{message}</span>
      {onClose && (
        <button className="banner-close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      )}
    </div>
  );
}
