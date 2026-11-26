import { useQueryClient } from '@tanstack/react-query';
import {
  getGetConsentQueryKey,
  useGetConsent,
  useSetConsent,
  useWithdrawConsent,
} from '@workspace/api-client-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Lock, Loader2, Trash2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { getSubjectId } from '@/lib/subject';

/** Friendly titles; the authoritative wording comes from the server. */
const SCOPE_TITLES: Record<string, string> = {
  'none': 'Nothing at all',
  'outcomes-only': 'Anonymous results only',
  'redacted-examples': 'Redacted examples',
  'full-examples': 'Redacted examples and my corrections',
};

export function ConsentSettings() {
  const subject = getSubjectId();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const consent = useGetConsent({ subject });
  const setConsent = useSetConsent();
  const withdraw = useWithdrawConsent();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getGetConsentQueryKey({ subject }) });

  const current = consent.data?.scope ?? 'none';
  const options = consent.data?.options ?? [];
  const busy = setConsent.isPending || withdraw.isPending;

  const handleChange = (scope: string) => {
    setConsent.mutate(
      { data: { subject, scope } },
      {
        onSuccess: () => {
          invalidate();
          toast({
            title: scope === 'none' ? 'Collection turned off' : 'Preference saved',
            description:
              scope === 'none'
                ? 'Anything previously collected has been deleted.'
                : 'You can change or withdraw this at any time.',
          });
        },
        onError: () =>
          toast({
            title: "Couldn't save that",
            description: 'Your preference is unchanged. Nothing is being collected.',
            variant: 'destructive',
          }),
      },
    );
  };

  const handleWithdraw = () => {
    withdraw.mutate(
      { data: { subject } },
      {
        onSuccess: (result) => {
          invalidate();
          toast({
            title: 'Everything deleted',
            description: `Removed ${result.interactionsPurged} example${
              result.interactionsPurged === 1 ? '' : 's'
            } and ${result.outcomesPurged} result${result.outcomesPurged === 1 ? '' : 's'}.`,
          });
        },
        onError: () =>
          toast({
            title: "Couldn't delete right now",
            description: 'Please try again in a moment.',
            variant: 'destructive',
          }),
      },
    );
  };

  return (
    <Card className="border border-card-border bg-card/40 shadow-[var(--shadow-sm)]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-serif text-xl">
          <Lock className="w-5 h-5 text-primary" />
          Help improve the Studio
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Nothing you write is kept unless you turn it on here. Email addresses, phone numbers,
          addresses, and names are stripped out before anything is stored, and a request that
          appears to contain a password or API key is discarded entirely rather than saved.
        </p>

        {consent.isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading your preference…
          </div>
        ) : consent.isError ? (
          <p className="text-sm text-muted-foreground py-2">
            Couldn't load your preference, so nothing is being collected.
          </p>
        ) : (
          <RadioGroup
            value={current}
            onValueChange={handleChange}
            disabled={busy}
            className="space-y-3"
          >
            {options.map((option) => (
              <div key={option.scope} className="flex items-start gap-3">
                <RadioGroupItem
                  value={option.scope}
                  id={`consent-${option.scope}`}
                  className="mt-1"
                  data-testid={`radio-consent-${option.scope}`}
                />
                <Label htmlFor={`consent-${option.scope}`} className="font-normal cursor-pointer">
                  <span className="block text-sm font-medium text-foreground">
                    {SCOPE_TITLES[option.scope] ?? option.scope}
                  </span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    {option.description}
                  </span>
                </Label>
              </div>
            ))}
          </RadioGroup>
        )}

        <div className="pt-2 border-t border-card-border flex items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground">
            Withdrawing deletes what was collected — it does not just stop future collection.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={handleWithdraw}
            disabled={busy}
            className="shrink-0"
            data-testid="button-withdraw-consent"
          >
            {withdraw.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Trash2 className="w-4 h-4" />
            )}
            Delete my data
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
