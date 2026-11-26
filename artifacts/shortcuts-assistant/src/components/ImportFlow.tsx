/**
 * ImportFlow — renders the 3-path import UI as a Dialog.
 * Bind to `useImportStrategy` from `lib/import-strategy`.
 *
 * Usage:
 *   const imp = useImportStrategy(fileUrl);
 *   <Button onClick={imp.startImport}>Import</Button>
 *   <ImportFlow imp={imp} onNavigateToBuilder={() => setLocation('/builder')} />
 *
 * This dialog is also where the two signals that matter most are collected:
 * whether the import actually happened, and whether the shortcut then ran. The
 * app can verify neither on its own — only the person holding the phone knows —
 * so it asks, once, at the moment they would know. The questions are shown only
 * when the user has consented to something being kept; otherwise the dialog
 * behaves exactly as it did before.
 */

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Download, CheckCircle2, ArrowRight, Smartphone, Blocks, XCircle } from 'lucide-react';
import type { ImportStrategyResult } from '@/lib/import-strategy';
import { useRunFeedback } from '@/lib/use-run-feedback';

export interface ImportFlowProps {
  imp: ImportStrategyResult;
  onNavigateToBuilder: () => void;
}

export function ImportFlow({ imp, onNavigateToBuilder }: ImportFlowProps) {
  const isOpen = imp.stage !== 'idle';
  const feedback = useRunFeedback();

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => { if (!open) imp.reset(); }}
    >
      <DialogContent className="bg-card border-card-border text-foreground max-w-sm">
        {imp.stage === 'path-c-prompt' && (
          <>
            <DialogHeader>
              <DialogTitle className="font-serif text-xl flex items-center gap-2">
                <Smartphone className="w-5 h-5 text-accent" />
                Did Shortcuts open?
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                We sent the shortcut to the Shortcuts app via URL scheme. Did it open successfully on your iPhone or iPad?
              </DialogDescription>
            </DialogHeader>
            <div className="flex gap-3 mt-2">
              <Button
                className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={() => {
                  feedback.report({ importConfirmed: true });
                  imp.confirmSuccess();
                }}
                data-testid="import-yes"
              >
                <CheckCircle2 className="w-4 h-4 mr-2" />
                Yes, it opened
              </Button>
              <Button
                variant="outline"
                className="flex-1 border-border"
                onClick={() => {
                  feedback.report({ importConfirmed: false });
                  imp.fallbackToDownload();
                }}
                data-testid="import-no"
              >
                No, it didn't
              </Button>
            </div>
            <p className="text-xs text-muted-foreground text-center mt-1">
              This requires Safari on iOS/iPadOS with the Shortcuts app installed.
            </p>
            <button
              className="text-xs text-accent underline text-center w-full mt-1"
              onClick={() => { onNavigateToBuilder(); imp.reset(); }}
            >
              View step-by-step guide instead
              <ArrowRight className="w-3 h-3 inline ml-1" />
            </button>
          </>
        )}

        {imp.stage === 'path-d' && (
          <>
            <DialogHeader>
              <DialogTitle className="font-serif text-xl">Download the file</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Download the .shortcut file, then open it from the Files app on your iPhone or iPad to import it into Shortcuts.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 mt-2">
              <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
                <li>Tap <strong className="text-foreground">Download below</strong> (or AirDrop from your Mac)</li>
                <li>Open the <strong className="text-foreground">Files app</strong> on your iPhone</li>
                <li>Tap the downloaded <strong className="text-foreground">.shortcut file</strong></li>
                <li>Shortcuts will ask you to confirm the import</li>
              </ol>
              <Button
                className="w-full h-12 bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={imp.triggerDownload}
                data-testid="import-download"
              >
                <Download className="w-5 h-5 mr-2" />
                Download .shortcut file
              </Button>
              <Button
                variant="ghost"
                className="w-full text-muted-foreground hover:text-foreground"
                onClick={() => { onNavigateToBuilder(); imp.reset(); }}
                data-testid="import-builder-guide"
              >
                <Blocks className="w-4 h-4 mr-2" />
                View step-by-step guide in Builder
              </Button>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Files generated here are unsigned plists in the format Shortcuts expects. We do not sign files as Apple.
            </p>
          </>
        )}

        {imp.stage === 'success' && (
          <>
            <DialogHeader>
              <DialogTitle className="font-serif text-xl flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-primary" />
                Shortcut imported!
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                Your shortcut was sent to the Shortcuts app. Run it once in Shortcuts to confirm it works as expected.
              </DialogDescription>
            </DialogHeader>

            {feedback.canReport ? (
              <div className="space-y-3 mt-2">
                <p className="text-sm font-medium text-foreground">
                  Once you've run it — did it work?
                </p>
                <div className="flex gap-3">
                  <Button
                    className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
                    onClick={() => {
                      feedback.report({ deviceRunSucceeded: true, accepted: true });
                      imp.reset();
                    }}
                    data-testid="device-yes"
                  >
                    <CheckCircle2 className="w-4 h-4 mr-2" />
                    Yes, it worked
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1 border-border"
                    onClick={() => {
                      feedback.report({ deviceRunSucceeded: false });
                      imp.reset();
                    }}
                    data-testid="device-no"
                  >
                    <XCircle className="w-4 h-4 mr-2" />
                    Not quite
                  </Button>
                </div>
                <button
                  className="text-xs text-muted-foreground underline w-full text-center"
                  onClick={imp.reset}
                  data-testid="device-skip"
                >
                  Skip
                </button>
              </div>
            ) : (
              <Button
                className="w-full mt-2 bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={imp.reset}
              >
                Done
              </Button>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
