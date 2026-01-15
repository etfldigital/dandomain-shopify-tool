import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, CheckCircle2, AlertCircle, Upload, Globe, Key } from 'lucide-react';
import { Project } from '@/types/database';

interface ConnectDanDomainStepProps {
  project: Project;
  onUpdateProject: (updates: Partial<Project>) => Promise<void>;
  onNext: () => void;
}

export function ConnectDanDomainStep({ project, onUpdateProject, onNext }: ConnectDanDomainStepProps) {
  const [shopUrl, setShopUrl] = useState(project.dandomain_shop_url || '');
  const [apiKey, setApiKey] = useState(project.dandomain_api_key_encrypted || '');
  
  // If we already have saved credentials, show success state
  const hasExistingConnection = project.dandomain_shop_url && project.dandomain_api_key_encrypted;
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(hasExistingConnection ? 'success' : null);
  const [errorMessage, setErrorMessage] = useState('');

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    setErrorMessage('');

    try {
      // Simulate API test - in production, this would call an edge function
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // For MVP, we'll just save the credentials and proceed
      await onUpdateProject({
        dandomain_shop_url: shopUrl,
        dandomain_api_key_encrypted: apiKey, // In production, encrypt this
        status: 'connected',
      });
      
      setTestResult('success');
    } catch (error) {
      setTestResult('error');
      setErrorMessage('Kunne ikke oprette forbindelse. Tjek dine oplysninger.');
    } finally {
      setTesting(false);
    }
  };

  const handleSkipToCSV = async () => {
    await onUpdateProject({
      dandomain_shop_url: shopUrl || 'CSV Import',
      status: 'connected',
    });
    onNext();
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-semibold mb-2">Forbind til DanDomain</h2>
        <p className="text-muted-foreground">
          Indtast dine DanDomain API-oplysninger for at starte migreringen
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Globe className="w-5 h-5 text-primary" />
            API-forbindelse
          </CardTitle>
          <CardDescription>
            Find din API-nøgle i DanDomain Admin under Indstillinger → API
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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

          {testResult === 'success' && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300">
              <CheckCircle2 className="w-5 h-5" />
              <span>Forbindelse oprettet!</span>
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
              disabled={!shopUrl || !apiKey || testing}
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
                Fortsæt
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">eller</span>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Upload className="w-5 h-5 text-primary" />
            CSV Import
          </CardTitle>
          <CardDescription>
            Har du ikke API-adgang? Du kan uploade CSV-filer direkte
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={handleSkipToCSV} className="w-full">
            Spring til CSV import
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}