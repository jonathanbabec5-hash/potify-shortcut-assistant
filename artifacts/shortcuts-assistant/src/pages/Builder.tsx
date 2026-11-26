import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation, useSearch } from 'wouter';
import {
  useListShortcutsActions,
  useSuggestNextActions,
  useDiagnoseShortcut,
  useStoreShortcutFile,
  getGetShortcutFileUrl,
} from '@workspace/api-client-react';
import type { ShortcutPlist, ShortcutAction } from '@workspace/api-client-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Plus, ChevronUp, ChevronDown, Trash2, Lightbulb, Download, Settings2,
  Sparkles, Activity, AlertTriangle, Search, RotateCcw, Undo2, HelpCircle,
} from 'lucide-react';
import { shortcutStore } from '@/lib/store';
import { pendingEditCount, recordEdit } from '@/lib/edit-journal';
import { useRunFeedback } from '@/lib/use-run-feedback';
import { cn } from '@/lib/utils';
import { useImportStrategy } from '@/lib/import-strategy';
import { ImportFlow } from '@/components/ImportFlow';
import {
  addActionToShortcut,
  addSuggestedActionToShortcut,
  moveActionInShortcut,
  deleteActionFromShortcut,
  isValidActionIdentifier,
} from '@/lib/builder-logic';

export function Builder() {
  const [, setLocation] = useLocation();
  const searchStr = useSearch();
  const params = new URLSearchParams(searchStr);
  const shortcutIdParam = params.get('shortcutId');

  const [shortcut, setShortcut] = useState<ShortcutPlist>(
    () => shortcutStore.get() || { WFWorkflowActions: [] },
  );
  const [deletedActions, setDeletedActions] = useState<Array<{ action: ShortcutAction; index: number; label: string }>>([]);
  const [isCatalogOpen, setIsCatalogOpen] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [storedFileId, setStoredFileId] = useState<string | null>(null);

  const actions = shortcut.WFWorkflowActions || [];
  const catalog = useListShortcutsActions();
  const suggestions = useSuggestNextActions();
  const diagnose = useDiagnoseShortcut();
  const storeFile = useStoreShortcutFile();

  const fileUrl = storedFileId ? getGetShortcutFileUrl(storedFileId) : undefined;
  const imp = useImportStrategy(fileUrl);

  // If ?shortcutId param present but store is empty, show a note
  const showParamNotice = !!shortcutIdParam && actions.length === 0;

  // `update`, not `set`: a Builder edit changes the shortcut belonging to the
  // current run, it does not start a new one. Using `set` here would clear the
  // run association and orphan every edit the user is about to make.
  useEffect(() => {
    shortcutStore.update(shortcut);
  }, [shortcut]);

  // Edits are reported when the user leaves the Builder — the natural "I'm done
  // changing this" moment, and the only one that catches edits made after an
  // import has already been confirmed. Nothing is sent when there is nothing to
  // send, and the server still requires consent for corrections.
  const feedback = useRunFeedback();
  const reportRef = useRef(feedback.report);
  reportRef.current = feedback.report;
  useEffect(
    () => () => {
      if (pendingEditCount() > 0) reportRef.current({});
    },
    [],
  );

  // Debounced auto-diagnose when action list changes
  useEffect(() => {
    if (actions.length === 0) return;
    const timer = setTimeout(() => {
      suggestions.mutate({ data: { actions } });
      diagnose.mutate({ data: { shortcut } });
    }, 1000);
    return () => clearTimeout(timer);
  }, [actions.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const getDisplayName = useCallback(
    (identifier: string) => {
      if (!catalog.data) return identifier.split('.').pop() || identifier;
      const entry = catalog.data.actions.find((a) => a.identifier === identifier);
      return entry ? entry.displayName : identifier.split('.').pop() || identifier;
    },
    [catalog.data],
  );

  const getActionTags = useCallback(
    (identifier: string): string[] => {
      if (!catalog.data) return [];
      const entry = catalog.data.actions.find((a) => a.identifier === identifier);
      return entry?.tags ?? [];
    },
    [catalog.data],
  );

  /**
   * Required parameters that have no value yet. The generator deliberately leaves
   * a detail unset rather than inventing one, so these render as an explicit
   * prompt instead of an empty parameter row the user would never notice.
   */
  const getMissingRequired = useCallback(
    (identifier: string, params: Record<string, unknown>): string[] => {
      if (!catalog.data) return [];
      const entry = catalog.data.actions.find((a) => a.identifier === identifier);
      if (!entry) return [];
      return entry.parameters.required
        .filter((p) => {
          const value = params[p.key];
          if (value === undefined || value === null) return true;
          if (typeof value === 'string') return value.trim() === '';
          if (Array.isArray(value)) return value.length === 0;
          return false;
        })
        .map((p) => p.displayName);
    },
    [catalog.data],
  );

  const moveAction = useCallback(
    (index: number, direction: 'up' | 'down') => {
      // Boundary moves are no-ops in builder-logic, so they must not be
      // journalled either — a reorder that never happened is not an edit.
      if (direction === 'up' && index === 0) return;
      if (direction === 'down' && index === actions.length - 1) return;
      recordEdit({ op: 'reorder-action', index });
      setShortcut((prev) => moveActionInShortcut(prev, index, direction));
    },
    [actions.length],
  );

  const deleteAction = useCallback(
    (index: number) => {
      const action = actions[index];
      recordEdit({
        op: 'remove-action',
        index,
        actionIdentifier: action.WFWorkflowActionIdentifier,
      });
      setDeletedActions((prev) => [
        { action, index, label: getDisplayName(action.WFWorkflowActionIdentifier) },
        ...prev,
      ]);
      setShortcut((prev) => deleteActionFromShortcut(prev, index));
    },
    [actions, getDisplayName],
  );

  const restoreAction = useCallback((deletedIdx: number) => {
    const item = deletedActions[deletedIdx];
    recordEdit({
      op: 'add-action',
      index: item.index,
      actionIdentifier: item.action.WFWorkflowActionIdentifier,
    });
    setShortcut((prev) => ({
      ...prev,
      WFWorkflowActions: [
        ...prev.WFWorkflowActions.slice(0, item.index),
        item.action,
        ...prev.WFWorkflowActions.slice(item.index),
      ],
    }));
    setDeletedActions((prev) => prev.filter((_, i) => i !== deletedIdx));
  }, [deletedActions]);

  const permanentlyRemove = useCallback((deletedIdx: number) => {
    setDeletedActions((prev) => prev.filter((_, i) => i !== deletedIdx));
  }, []);

  const addAction = useCallback(
    (identifier: string) => {
      if (isAdding) return;
      if (!isValidActionIdentifier(identifier)) {
        setAddError(`Cannot add action: "${identifier}" is not a valid action identifier.`);
        return;
      }
      setAddError(null);
      setIsAdding(true);
      recordEdit({ op: 'add-action', index: actions.length, actionIdentifier: identifier });
      setShortcut((prev) => addActionToShortcut(prev, identifier));
      setIsCatalogOpen(false);
      setTimeout(() => setIsAdding(false), 300);
    },
    [isAdding],
  );

  const addSuggested = useCallback(
    (suggestion: { identifier: string; parameters?: Record<string, unknown> }) => {
      if (isAdding) return;
      if (!isValidActionIdentifier(suggestion.identifier)) {
        setAddError(`Cannot add: "${suggestion.identifier}" is not a valid identifier.`);
        return;
      }
      setAddError(null);
      setIsAdding(true);
      recordEdit({
        op: 'add-action',
        index: actions.length,
        actionIdentifier: suggestion.identifier,
      });
      setShortcut((prev) => addSuggestedActionToShortcut(prev, suggestion));
      setTimeout(() => setIsAdding(false), 300);
    },
    [isAdding],
  );

  const handleExport = () => {
    storeFile.mutate(
      { data: { shortcut } },
      {
        onSuccess: (stored) => {
          setStoredFileId(stored.id);
          // small delay so state propagates to imp before startImport reads it
          setTimeout(() => imp.startImport(), 100);
        },
      },
    );
  };

  // Filtered catalog entries
  const filteredCatalog = catalog.data?.actions.filter((a) => {
    const q = catalogSearch.toLowerCase();
    return (
      !q ||
      a.displayName.toLowerCase().includes(q) ||
      a.identifier.toLowerCase().includes(q) ||
      a.description?.toLowerCase().includes(q)
    );
  }) ?? [];

  return (
    <div className="p-4 pt-8 pb-24 max-w-2xl mx-auto min-h-[100dvh] flex flex-col">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-secondary/20 bg-secondary/10 text-secondary-foreground text-xs font-medium tracking-wide uppercase mb-2">
            <Sparkles className="w-3 h-3" />
            Visual Assembler
          </div>
          <h1 className="text-3xl md:text-4xl font-serif font-medium tracking-tight text-foreground">
            Builder
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Assemble your shortcut action by action with guided feedback.
          </p>
        </div>
        <div className="flex items-center gap-2 mt-1">
          {deletedActions.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="border-border text-xs"
              onClick={() => setShowDeleted((v) => !v)}
              data-testid="button-show-deleted"
            >
              <Undo2 className="w-3.5 h-3.5 mr-1.5" />
              Deleted ({deletedActions.length})
            </Button>
          )}
          <Button
            onClick={handleExport}
            disabled={actions.length === 0 || storeFile.isPending}
            variant="outline"
            className="h-10 border-border hover:bg-elevate-1"
            data-testid="button-export"
          >
            <Download className="w-4 h-4 mr-2" />
            {storeFile.isPending ? 'Saving…' : 'Export'}
          </Button>
        </div>
      </div>

      {/* URL param notice */}
      {showParamNotice && (
        <Alert className="mb-4 border-accent/20 bg-accent/5 text-accent-foreground">
          <AlertTriangle className="w-4 h-4" />
          <AlertTitle>No shortcut loaded</AlertTitle>
          <AlertDescription>
            Go to the{' '}
            <button className="underline" onClick={() => setLocation('/')}>
              Generate tab
            </button>{' '}
            to create a shortcut and it will appear here automatically.
          </AlertDescription>
        </Alert>
      )}

      {/* Deleted list */}
      {showDeleted && deletedActions.length > 0 && (
        <Card className="border border-orange-500/20 bg-orange-500/5 mb-4">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-orange-400 flex items-center gap-2">
              <Trash2 className="w-4 h-4" />
              Deleted actions — restore or remove permanently
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {deletedActions.map((item, i) => (
              <div
                key={i}
                className="flex items-center justify-between text-sm p-2 rounded-lg border border-card-border bg-card"
                data-testid={`deleted-action-${i}`}
              >
                <span className="text-foreground font-medium">{item.label}</span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs border-border"
                    onClick={() => restoreAction(i)}
                    data-testid={`button-restore-${i}`}
                  >
                    <RotateCcw className="w-3 h-3 mr-1" />
                    Restore
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-destructive hover:text-destructive"
                    onClick={() => permanentlyRemove(i)}
                    data-testid={`button-remove-${i}`}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Action list */}
      <div className="flex-1 space-y-4 relative">
        {actions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center border-2 border-dashed border-card-border rounded-2xl bg-card/30">
            <Settings2 className="w-12 h-12 text-muted-foreground/50 mb-3" />
            <h3 className="font-semibold text-lg font-serif">Empty Shortcut</h3>
            <p className="text-muted-foreground text-sm max-w-xs mt-1">
              Add actions from the catalog to build your automation.
            </p>
          </div>
        ) : (
          <div className="space-y-3 relative before:absolute before:inset-0 before:ml-[1.125rem] before:-translate-x-px before:h-full before:w-0.5 before:bg-border/60">
            {actions.map((action, index) => (
              <Card
                key={index}
                data-testid={`action-card-${index}`}
                className="relative z-10 border border-card-border bg-card shadow-[var(--shadow-sm)] group transition-all hover:border-primary/30"
              >
                <CardContent className="p-3 flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-secondary text-secondary-foreground flex items-center justify-center font-bold text-sm shrink-0 border border-secondary-border">
                    {index + 1}
                  </div>
                  <div className="flex-1 min-w-0 pt-1">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="font-semibold text-base truncate">
                        {getDisplayName(action.WFWorkflowActionIdentifier)}
                      </h4>
                      <div className="flex items-center gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="w-7 h-7"
                          onClick={() => moveAction(index, 'up')}
                          disabled={index === 0}
                          data-testid={`button-move-up-${index}`}
                        >
                          <ChevronUp className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="w-7 h-7"
                          onClick={() => moveAction(index, 'down')}
                          disabled={index === actions.length - 1}
                          data-testid={`button-move-down-${index}`}
                        >
                          <ChevronDown className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="w-7 h-7 text-destructive hover:text-destructive"
                          onClick={() => deleteAction(index)}
                          data-testid={`button-delete-${index}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {getActionTags(action.WFWorkflowActionIdentifier)
                        .slice(0, 3)
                        .map((tag: string) => (
                          <Badge
                            key={tag}
                            variant="outline"
                            className="text-[10px] h-4 px-1 border-border text-muted-foreground"
                          >
                            {tag}
                          </Badge>
                        ))}
                    </div>
                    {(() => {
                      const missing = getMissingRequired(
                        action.WFWorkflowActionIdentifier,
                        action.WFWorkflowActionParameters,
                      );
                      if (missing.length === 0) return null;
                      return (
                        <div
                          className="mt-2 flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs"
                          data-testid={`needs-input-${index}`}
                        >
                          <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                          <span className="text-foreground">
                            <span className="font-medium text-amber-700 dark:text-amber-400">
                              Needs your input:
                            </span>{' '}
                            {missing.join(', ')}
                          </span>
                        </div>
                      );
                    })()}
                    {Object.keys(action.WFWorkflowActionParameters).length > 0 && (
                      <div className="mt-2 text-xs font-mono text-muted-foreground bg-secondary/30 rounded p-2 truncate">
                        {JSON.stringify(action.WFWorkflowActionParameters)}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Live diagnostics */}
        {diagnose.data && actions.length > 0 && (
          <Card className="border border-card-border bg-card/40">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" />
                Live diagnostics
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Unbound inputs</span>
                <Badge variant={diagnose.data.unboundInputs > 0 ? 'destructive' : 'outline'}>
                  {diagnose.data.unboundInputs}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Unreachable steps</span>
                <Badge variant={diagnose.data.unreachableSteps.length > 0 ? 'destructive' : 'outline'}>
                  {diagnose.data.unreachableSteps.length}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Device features</span>
                <span className="text-xs text-foreground">
                  {diagnose.data.requiredDeviceFeatures.length > 0
                    ? diagnose.data.requiredDeviceFeatures.join(', ')
                    : 'None'}
                </span>
              </div>
            </CardContent>
          </Card>
        )}

        {/* AI suggestions */}
        {suggestions.data && suggestions.data.suggestions.length > 0 && (
          <Card className="border border-accent/20 bg-accent/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2 text-accent-foreground">
                <Lightbulb className="w-4 h-4" />
                Suggested next actions
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {suggestions.data.suggestions.map((s, i) => (
                <button
                  key={i}
                  data-testid={`suggestion-${i}`}
                  onClick={() => addSuggested(s)}
                  className="w-full text-left p-3 rounded-lg border border-card-border bg-card hover:border-accent/30 transition-colors"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm text-foreground">{s.displayName}</span>
                    <Plus className="w-4 h-4 text-muted-foreground" />
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{s.rationale}</p>
                </button>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Add error */}
      {addError && (
        <Alert variant="destructive" className="mt-4 border-destructive/30 bg-destructive/10">
          <AlertTriangle className="w-4 h-4" />
          <AlertTitle>Could not add action</AlertTitle>
          <AlertDescription className="text-xs">{addError}</AlertDescription>
        </Alert>
      )}

      {/* Add Action button */}
      <div className="mt-6">
        <Sheet open={isCatalogOpen} onOpenChange={setIsCatalogOpen}>
          <SheetTrigger asChild>
            <Button
              data-testid="button-add-action"
              className="w-full h-14 text-base rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 shadow-[var(--shadow-sm)]"
            >
              <Plus className="w-5 h-5 mr-2" />
              Add Action
            </Button>
          </SheetTrigger>
          <SheetContent side="bottom" className="bg-card border-card-border text-foreground h-[85vh] rounded-t-2xl">
            <SheetHeader className="pb-3">
              <SheetTitle className="font-serif text-xl">Action Catalog</SheetTitle>
            </SheetHeader>

            {/* Catalog search */}
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
              <Input
                data-testid="input-catalog-search"
                placeholder="Search actions…"
                value={catalogSearch}
                onChange={(e) => setCatalogSearch(e.target.value)}
                className="pl-9 bg-background/50 border-input"
              />
            </div>

            <ScrollArea className="h-[calc(85vh-130px)]">
              <div className="space-y-2 pb-6">
                {catalog.isLoading && (
                  <p className="text-muted-foreground text-center py-8">Loading catalog…</p>
                )}
                {filteredCatalog.length === 0 && catalogSearch && (
                  <p className="text-muted-foreground text-center py-8 text-sm">
                    No actions match "{catalogSearch}"
                  </p>
                )}
                {filteredCatalog.map((entry) => (
                  <button
                    key={entry.identifier}
                    type="button"
                    data-testid={`catalog-action-${entry.identifier}`}
                    onClick={() => addAction(entry.identifier)}
                    disabled={isAdding}
                    className="w-full text-left p-3 rounded-lg border border-card-border bg-card hover:border-primary/30 transition-colors disabled:opacity-50"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-sm text-foreground">{entry.displayName}</span>
                      <div className="flex items-center gap-2">
                        {entry.minimumClientVersion > 700 && (
                          <Badge variant="outline" className="text-[10px] h-4 px-1 border-border text-muted-foreground">
                            iOS {entry.minimumClientVersion >= 2702 ? '26+' : entry.minimumClientVersion >= 1500 ? '15+' : '12+'}
                          </Badge>
                        )}
                        <Plus className="w-4 h-4 text-muted-foreground" />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{entry.description}</p>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {entry.tags?.slice(0, 3).map((tag: string) => (
                        <Badge
                          key={tag}
                          variant="outline"
                          className="text-[10px] h-4 px-1 border-border text-muted-foreground"
                        >
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </SheetContent>
        </Sheet>
      </div>

      {/* Import flow dialog */}
      <ImportFlow imp={imp} onNavigateToBuilder={() => setLocation('/builder')} />
    </div>
  );
}
