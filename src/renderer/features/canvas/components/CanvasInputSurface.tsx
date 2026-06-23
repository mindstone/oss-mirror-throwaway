import { useState, useRef, useCallback, useEffect } from 'react';
import { Paperclip } from 'lucide-react';
import type { MindElixirInstance } from 'mind-elixir';
import { 
  Button, 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle, 
  DialogBody, 
  DialogFooter 
} from '@renderer/components/ui';
import { MindMapCanvas, extractSemanticText, type MindMapExport } from './MindMapCanvas';
import styles from './CanvasInputSurface.module.css';

export interface CanvasInputSurfaceProps {
  isOpen: boolean;
  onClose: () => void;
  onSend: (data: MindMapExport) => Promise<void>;
  onError?: (message: string) => void;
  theme?: 'light' | 'dark';
}

export function CanvasInputSurface({ isOpen, onClose, onSend, onError, theme = 'dark' }: CanvasInputSurfaceProps) {
  const [mindInstance, setMindInstance] = useState<MindElixirInstance | null>(null);
  const [isAttaching, setIsAttaching] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [showHints, setShowHints] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setShowHints(true);
      setShowSuccess(false);
    }
  }, [isOpen]);

  // Auto-hide hints after first interaction
  useEffect(() => {
    if (!mindInstance) return;
    const hideHints = () => setShowHints(false);
    const bus = mindInstance.bus as { addListener(event: string, fn: () => void): void; removeListener(event: string, fn: () => void): void } | undefined;
    if (!bus) return;
    bus.addListener('selectNode', hideHints);
    return () => {
      bus.removeListener('selectNode', hideHints);
    };
  }, [mindInstance]);

  const handleReady = useCallback((instance: MindElixirInstance) => {
    setMindInstance(instance);
  }, []);

  const handleAttach = useCallback(async () => {
    if (!mindInstance || !containerRef.current) return;
    
    setIsAttaching(true);
    try {
      const json = mindInstance.getData();
      const semanticText = extractSemanticText(json);
      
      // Export PNG - simplified text representation for MVP
      // (Full visual export deferred to Phase 2)
      const mapContainer = containerRef.current.querySelector('.map-container') as HTMLElement;
      if (!mapContainer) throw new Error('Map container not found');
      
      const rect = mapContainer.getBoundingClientRect();
      const scale = 2;
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      
      if (!ctx) throw new Error('Canvas context not available');
      
      ctx.scale(scale, scale);
      const bgColor = getComputedStyle(mapContainer).backgroundColor || '#1a1a2e';
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, width, height);
      
      ctx.fillStyle = theme === 'dark' ? '#e2e8f0' : '#1e293b';
      ctx.font = '14px system-ui';
      
      const lines = semanticText.split('\n');
      lines.forEach((line, i) => {
        ctx.fillText(line, 20, 30 + i * 20);
      });
      
      const png = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Failed to create PNG'));
        }, 'image/png');
      });
      
      await onSend({ png, json, semanticText, width, height });
      
      // Show success animation before closing
      setShowSuccess(true);
      await new Promise(resolve => setTimeout(resolve, 400));
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't export the mind map";
      console.error('Failed to export mind map:', error);
      onError?.(message);
    } finally {
      setIsAttaching(false);
    }
  }, [mindInstance, onSend, onClose, onError, theme]);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className={styles.dialogContent} data-testid="canvas-surface">
        <DialogHeader onClose={onClose}>
          <DialogTitle>Mind Map</DialogTitle>
        </DialogHeader>
        
        <DialogBody className={styles.dialogBody}>
          <div ref={containerRef} className={styles.canvasContainer}>
            <MindMapCanvas 
              theme={theme} 
              onReady={handleReady}
            />
            
            {/* Success overlay */}
            {showSuccess && (
              <div className={styles.successOverlay}>
                <div className={styles.successIcon}>✓</div>
                <p>Attached!</p>
              </div>
            )}
            {/* Floating hints - auto-hide after first interaction */}
            {showHints && (
              <div className={styles.hintsOverlay}>
                <div className={styles.hintCard}>
                  <p className={styles.hintTitle}>Quick Start</p>
                  <div className={styles.hintList}>
                    <span><kbd>Tab</kbd> Add child</span>
                    <span><kbd>Enter</kbd> Add sibling</span>
                    <span><kbd>F2</kbd> Edit text</span>
                    <span><kbd>Del</kbd> Remove</span>
                  </div>
                  <p className={styles.hintDismiss}>Click any node to begin</p>
                </div>
              </div>
            )}
          </div>
        </DialogBody>
        
        <DialogFooter className={styles.dialogFooter}>
          <p className={styles.hint}>
            Your mind map will be attached to the composer
          </p>
          <div className={styles.actions}>
            <Button variant="ghost" onClick={onClose} disabled={isAttaching}>
              Cancel
            </Button>
            <Button 
              onClick={handleAttach} 
              disabled={!mindInstance || isAttaching}
              data-testid="canvas-attach-button"
            >
              {isAttaching ? 'Attaching...' : (
                <>
                  <Paperclip size={16} />
                  Attach
                </>
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

CanvasInputSurface.displayName = 'CanvasInputSurface';
