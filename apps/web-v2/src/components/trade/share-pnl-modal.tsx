"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { AlertTriangle, Copy, Download, X } from "lucide-react";

export interface PnlImageData {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
}

interface SharePnlModalProps {
  open: boolean;
  symbol: string;
  onClose: () => void;
  /** Generates a card; called once per hide-$-size variant and cached. */
  generate: (hideAmount: boolean) => Promise<PnlImageData>;
}

/**
 * Overlay dialog that previews a generated PNL card with "Hide $ size",
 * Download, and Copy actions. A fresh image is generated each time the
 * modal opens; both variants are cached for the life of that opening.
 */
export function SharePnlModal({ open, symbol, onClose, generate }: SharePnlModalProps) {
  const [images, setImages] = useState<{ normal?: PnlImageData; hidden?: PnlImageData }>({});
  const [hideAmount, setHideAmount] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Invalidates in-flight generations from a previous opening of the modal.
  const sessionRef = useRef(0);

  const runGenerate = useCallback(
    async (hide: boolean) => {
      const session = sessionRef.current;
      setIsGenerating(true);
      setError(null);
      try {
        const image = await generate(hide);
        if (sessionRef.current !== session) return;
        setImages((prev) => ({ ...prev, [hide ? "hidden" : "normal"]: image }));
      } catch (err) {
        if (sessionRef.current !== session) return;
        setError(err instanceof Error ? err.message : "Failed to generate image");
      } finally {
        if (sessionRef.current === session) setIsGenerating(false);
      }
    },
    [generate]
  );

  // Generate a fresh image each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    sessionRef.current += 1;
    setImages({});
    setHideAmount(false);
    setError(null);
    void runGenerate(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const current = hideAmount ? images.hidden : images.normal;
  const dataUrl = current ? `data:${current.mimeType};base64,${current.base64}` : null;

  const handleToggleHide = (next: boolean) => {
    setHideAmount(next);
    const cached = next ? images.hidden : images.normal;
    if (!cached) void runGenerate(next);
  };

  const handleDownload = () => {
    if (!dataUrl) return;
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = `pnl-${symbol}-${Date.now()}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Browser clipboards handle PNG far better than JPEG, so re-encode on a
  // canvas before writing. Requires a secure context (HTTPS or localhost).
  const handleCopy = async () => {
    if (!dataUrl || !current) return;
    try {
      const img = new Image();
      img.src = dataUrl;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Failed to load image"));
      });
      const canvas = document.createElement("canvas");
      canvas.width = current.width;
      canvas.height = current.height;
      canvas.getContext("2d")?.drawImage(img, 0, 0);
      const pngBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Failed to encode PNG"))), "image/png");
      });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
      toast.success("Image copied to clipboard");
    } catch (err) {
      console.error("[SharePnl] Copy failed:", err);
      toast.error("Couldn't copy image - try Download instead");
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`Share ${symbol} P&L`}
    >
      <div
        className="grid h-[calc(100dvh-2rem)] w-full max-w-2xl grid-rows-[auto_minmax(0,1fr)_auto] gap-3 overflow-hidden rounded-lg border bg-card p-4 shadow-floating"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between">
          <div className="text-sm font-medium">Share {symbol} P&L</div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={onClose}
            aria-label="Close share dialog"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="relative min-h-0 w-full overflow-hidden rounded-md border bg-muted/40">
          {dataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={dataUrl} alt={`${symbol} P&L card`} className="h-full w-full object-contain" />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {error ? (
                <span className="flex items-center gap-2 px-4 text-destructive">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {error}
                </span>
              ) : (
                "Generating image..."
              )}
            </div>
          )}
          {isGenerating && dataUrl && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-sm text-white">
              Generating...
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch
              checked={hideAmount}
              onCheckedChange={handleToggleHide}
              disabled={isGenerating}
              aria-label="Hide dollar amounts"
            />
            Hide $ size
          </label>
          <div className="flex gap-2">
            {error && (
              <Button variant="outline" size="sm" onClick={() => void runGenerate(hideAmount)} disabled={isGenerating}>
                Retry
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => void handleCopy()} disabled={!dataUrl}>
              <Copy className="mr-1 h-4 w-4" />
              Copy
            </Button>
            <Button size="sm" onClick={handleDownload} disabled={!dataUrl}>
              <Download className="mr-1 h-4 w-4" />
              Download
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
