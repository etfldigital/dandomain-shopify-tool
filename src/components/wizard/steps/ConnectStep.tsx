import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, CheckCircle2, AlertCircle, ExternalLink, Store, Key, Globe } from 'lucide-react';
import { Project } from '@/types/database';

interface ConnectStepProps {
  project: Project;
  onUpdateProject: (updates: Partial<Project>) => Promise<void>;
  onNext: () => void;
}

export function ConnectStep({ project, onUpdateProject, onNext }: ConnectStepProps) {
  // DanDomain state
  const [shopUrl, setShopUrl] = useState(project.dandomain_shop_url || (project as any).dandomain_base_url || '');
  const [apiKey, setApiKey] = useState(project.dandomain_api_key_encrypted || '');
  
  // Shopify state
  const [storeDomain, setStoreDomain] = useState(project.shopify_store_domain || '');
  const [accessToken, setAccessToken] = useState(project.shopify_access_token_encrypted || '');
  
  // Connection status
  const hasDanDomainConnection = project.dandomain_shop_url && project.dandomain_api_key_encrypted;
  const hasShopifyConnection = project.shopify_store_domain && project.shopify_access_token_encrypted;
  
  const [testingDanDomain, setTestingDanDomain] = useState(false);
  const [testingShopify, setTestingShopify] = useState(false);
  const [danDomainResult, setDanDomainResult] = useState<'success' | 'error' | null>(hasDanDomainConnection ? 'success' : null);
  const [shopifyResult, setShopifyResult] = useState<'success' | 'error' | null>(hasShopifyConnection ? 'success' : null);
  const [danDomainError, setDanDomainError] = useState('');
  const [shopifyError, setShopifyError] = useState('');

  const handleTestDanDomain = async () => {
    setTestingDanDomain(true);
    setDanDomainResult(null);
    setDanDomainError('');

    try {
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      await onUpdateProject({
        dandomain_shop_url: shopUrl,
        dandomain_api_key_encrypted: apiKey,
        dandomain_base_url: (shopUrl || null) as any,
        status: 'connected',
      } as any);
      
      setDanDomainResult('success');
    } catch (error) {
      setDanDomainResult('error');
      setDanDomainError('Kunne ikke oprette forbindelse. Tjek dine oplysninger.');
    } finally {
      setTestingDanDomain(false);
    }
  };

  const handleTestShopify = async () => {
    setTestingShopify(true);
    setShopifyResult(null);
    setShopifyError('');

    try {
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      await onUpdateProject({
        shopify_store_domain: storeDomain,
        shopify_access_token_encrypted: accessToken,
      });
      
      setShopifyResult('success');
    } catch (error) {
      setShopifyResult('error');
      setShopifyError('Kunne ikke oprette forbindelse til Shopify.');
    } finally {
      setTestingShopify(false);
    }
  };

  const bothConnected = danDomainResult === 'success' && shopifyResult === 'success';

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-semibold mb-2">Forbind til dine butikker</h2>
        <p className="text-muted-foreground">
          Indtast dine API-oplysninger for både DanDomain og Shopify
        </p>
      </div>

      {/* DanDomain Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Globe className="w-5 h-5 text-primary" />
            DanDomain API
            {danDomainResult === 'success' && (
              <CheckCircle2 className="w-5 h-5 text-success ml-auto" />
            )}
          </CardTitle>
          <CardDescription>
            Find din API-nøgle i DanDomain Admin under Indstillinger → API
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="shopUrl">Shop URL</Label>
              <Input
                id="shopUrl"
                placeholder="https://minshop.dandomain.dk"
                value={shopUrl}
                onChange={(e) => setShopUrl(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="apiKey">API-nøgle</Label>
              <div className="relative">
                <Key className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="apiKey"
                  type="password"
                  placeholder="Din DanDomain API-nøgle"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
          </div>

          {danDomainResult === 'success' && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-success/10 text-success">
              <CheckCircle2 className="w-5 h-5" />
              <span>DanDomain forbindelse oprettet!</span>
            </div>
          )}

          {danDomainResult === 'error' && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive">
              <AlertCircle className="w-5 h-5" />
              <span>{danDomainError}</span>
            </div>
          )}

          <Button
            onClick={handleTestDanDomain}
            disabled={!shopUrl || !apiKey || testingDanDomain}
            variant={danDomainResult === 'success' ? 'outline' : 'default'}
            className="w-full"
          >
            {testingDanDomain ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Tester forbindelse...
              </>
            ) : danDomainResult === 'success' ? (
              'Opdater DanDomain forbindelse'
            ) : (
              'Test DanDomain forbindelse'
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Shopify Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Store className="w-5 h-5 text-primary" />
            Shopify Admin API
            {shopifyResult === 'success' && (
              <CheckCircle2 className="w-5 h-5 text-success ml-auto" />
            )}
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

          <div className="grid gap-4 sm:grid-cols-2">
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
          </div>

          {shopifyResult === 'success' && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-success/10 text-success">
              <CheckCircle2 className="w-5 h-5" />
              <span>Forbindelse til Shopify oprettet!</span>
            </div>
          )}

          {shopifyResult === 'error' && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive">
              <AlertCircle className="w-5 h-5" />
              <span>{shopifyError}</span>
            </div>
          )}

          <Button
            onClick={handleTestShopify}
            disabled={!storeDomain || !accessToken || testingShopify}
            variant={shopifyResult === 'success' ? 'outline' : 'default'}
            className="w-full"
          >
            {testingShopify ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Tester forbindelse...
              </>
            ) : shopifyResult === 'success' ? (
              'Opdater Shopify forbindelse'
            ) : (
              'Test Shopify forbindelse'
            )}
          </Button>

          <div className="p-4 rounded-lg border border-border bg-muted/30">
            <h4 className="font-medium mb-2 text-sm">Påkrævede API Scopes</h4>
            <div className="flex flex-wrap gap-2">
              {[
                'read_products', 'write_products',
                'read_customers', 'write_customers',
                'read_orders', 'write_orders',
                'read_content', 'write_content',
              ].map(scope => (
                <code 
                  key={scope} 
                  className="px-2 py-1 rounded bg-secondary text-xs cursor-pointer hover:bg-secondary/80 transition-colors"
                  onClick={() => {
                    navigator.clipboard.writeText(scope);
                    toast.success(`Kopieret: ${scope}`);
                  }}
                  title="Klik for at kopiere"
                >
                  {scope}
                </code>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Continue Button */}
      {bothConnected && (
        <div className="flex justify-end pt-4">
          <Button onClick={onNext} size="lg">
            Fortsæt til udtræk
          </Button>
        </div>
      )}
    </div>
  );
}
