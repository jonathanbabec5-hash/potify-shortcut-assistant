import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { AppShell, type StudioMode } from '@/components/layout/AppShell';

import { Generate } from '@/pages/Generate';
import { Validate } from '@/pages/Validate';
import { Builder } from '@/pages/Builder';
import { About } from '@/pages/About';

const queryClient = new QueryClient();

export interface StudioProps {
  mode?: StudioMode;
}

export function StudioRouter({ mode = "standalone" }: StudioProps) {
  return (
    <AppShell mode={mode}>
      <Switch>
        <Route path="/" component={Generate} />
        <Route path="/validate" component={Validate} />
        <Route path="/builder" component={Builder} />
        <Route path="/about" component={About} />
        <Route component={NotFound} />
      </Switch>
    </AppShell>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <StudioRouter mode="standalone" />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
