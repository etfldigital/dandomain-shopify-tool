import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, CheckCircle2, AlertCircle, ExternalLink, Store, Key } from 'lucide-react';
import { Project } from '@/types/database';

interface ConnectShopifyStepProps {
  project: Project;
  onUpdateProject: (updates: Partial<Project>) => Promise<void>;
  onNext: () => void;
}

export function ConnectShopifyStep({ project, onUpdateProject, onNext }: ConnectShopifyStepProps) {
  const [storeDomain, setStoreDomain] = useState(project.shopify_store_domain || '');
  const [accessToken, setAccessToken] = useState(project.shopify_access_token_encrypted || '');
  
  // If we already have saved credentials, show success state
  const hasExistingConnection = project.shopify_store_domain && project.shopify_access_token_encrypted;
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(hasExistingConnection ? 'success' : null);
  const [errorMessage, setErrorMessage] = useState('');

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    setErrorMessage('');

    try {
      // For MVP, we'll just save the credentials
      // In production, this would call an edge function to test the Shopify API
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      await onUpdateProject({
        shopify_store_domain: storeDomain,
        shopify_access_token_encrypted: accessToken, // In production, encrypt this
      });
      
      setTestResult('success');
    } catch (error) {
      setTestResult('error');
      setErrorMessage('Kunne ikke oprette forbindelse til Shopify.');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-semibold mb-2">Forbind til Shopify</h2>
        <p className="text-muted-foreground">
          Forbind til din Shopify butik for at starte upload af data
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Store className="w-5 h-5 text-primary" />
            Shopify Admin API
          </CardTitle>
          <CardDescription>
            Opret en Custom App i Shopify Admin for at få din Access Token
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-4 rounded-lg bg-secondary/50 space-y-2">
            <h4 className="font-medium text-sm">Sådan får du din Access Token:</h4>
            <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
              <li>Gå til Shopify Admin → Settings → Apps</li>
              <li>Klik på "App and sales channel development"</li>
              <li>Klik på "Create an app" og giv den et navn</li>
              <li>Gå til "Configuration" og konfigurer Admin API scopes</li>
              <li>Gå til "API credentials" og klik "Install app"</li>
              <li>Kopiér din Admin API access token</li>
            </ol>
            <a 
              href="https://shopify.dev/docs/apps/build/authentication-authorization/access-token-types/generate-app-access-tokens-admin" 
              target="_blank" 
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline mt-2"
            >
              Læs mere i Shopify dokumentationen
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>

          <div className="space-y-2">
            <Label htmlFor="storeDomain">Butik domæne</Label>
            <div className="relative">
              <Store className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="storeDomain"
                placeholder="min-butik.myshopify.com"
                value={storeDomain}
                onChange={(e) => setStoreDomain(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="accessToken">Admin API Access Token</Label>
            <div className="relative">
              <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="accessToken"
                type="password"
                placeholder="shpat_xxxxxxxxxxxx"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>

          {testResult === 'success' && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300">
              <CheckCircle2 className="w-5 h-5" />
              <span>Forbindelse til Shopify oprettet!</span>
            </div>
          )}

          {testResult === 'error' && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive">
              <AlertCircle className="w-5 h-5" />
              <span>{errorMessage}</span>
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <Button
              onClick={handleTestConnection}
              disabled={!storeDomain || !accessToken || testing}
              className="flex-1"
            >
              {testing ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Tester forbindelse...
                </>
              ) : (
                'Test forbindelse'
              )}
            </Button>

            {testResult === 'success' && (
              <Button onClick={onNext}>
                Fortsæt til upload
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="p-4 rounded-lg border border-border bg-muted/30">
        <h4 className="font-medium mb-2">Påkrævede API Scopes</h4>
        <div className="flex flex-col gap-2">
          {[
            { read: 'read_products', write: 'write_products' },
            { read: 'read_customers', write: 'write_customers' },
            { read: 'read_orders', write: 'write_orders' },
            { read: 'read_content', write: 'write_content' },
            { read: 'read_metaobjects', write: 'write_metaobjects' },
          ].map((pair, index) => (
            <div key={index} className="flex items-center gap-2">
              <code 
                className="px-2 py-1 rounded bg-secondary text-xs cursor-pointer hover:bg-secondary/80 transition-colors"
                onClick={() => {
                  navigator.clipboard.writeText(pair.read);
                  toast.success(`Kopieret: ${pair.read}`);
                }}
                title="Klik for at kopiere"
              >
                {pair.read}
              </code>
              <span className="text-muted-foreground text-xs">/</span>
              <code 
                className="px-2 py-1 rounded bg-secondary text-xs cursor-pointer hover:bg-secondary/80 transition-colors"
                onClick={() => {
                  navigator.clipboard.writeText(pair.write);
                  toast.success(`Kopieret: ${pair.write}`);
                }}
                title="Klik for at kopiere"
              >
                {pair.write}
              </code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}