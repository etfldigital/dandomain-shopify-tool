import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { 
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Loader2, Save, ArrowRight, Folder, Tag, RefreshCw } from 'lucide-react';
import { Project, CanonicalCategory } from '@/types/database';
import { supabase } from '@/integrations/supabase/client';

interface MappingStepProps {
  project: Project;
  onUpdateProject: (updates: Partial<Project>) => Promise<void>;
  onNext: () => void;
  onBack?: () => void;
}

export function MappingStep({ project, onUpdateProject, onNext, onBack }: MappingStepProps) {
  const [categories, setCategories] = useState<CanonicalCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadCategories();
  }, [project.id]);

  const loadCategories = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('canonical_categories')
      .select('*')
      .eq('project_id', project.id)
      .order('name');

    if (!error && data) {
      setCategories(data as CanonicalCategory[]);
    }
    setLoading(false);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === categories.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(categories.map(c => c.id)));
    }
  };

  const updateCategory = async (id: string, updates: Partial<CanonicalCategory>) => {
    const { error } = await supabase
      .from('canonical_categories')
      .update(updates)
      .eq('id', id);

    if (!error) {
      setCategories(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c));
    }
  };

  const handleExcludeSelected = async () => {
    setSaving(true);
    for (const id of selectedIds) {
      await updateCategory(id, { exclude: true });
    }
    setSelectedIds(new Set());
    setSaving(false);
  };

  const handleSaveAndContinue = async () => {
    setSaving(true);
    await onUpdateProject({ status: 'mapped' });
    setSaving(false);
    onNext();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-semibold mb-2">Kategori Mapping</h2>
        <p className="text-muted-foreground">
          Tilpas hvordan DanDomain kategorier omdannes til Shopify tags og collections
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">Kategorier ({categories.length})</CardTitle>
              <CardDescription>
                Hver kategori bliver til et Shopify tag og en Smart Collection
              </CardDescription>
            </div>
            {selectedIds.size > 0 && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleExcludeSelected}
                  disabled={saving}
                >
                  Ekskluder valgte ({selectedIds.size})
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {categories.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Folder className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>Ingen kategorier fundet</p>
              <p className="text-sm">Kategorier udtrækkes automatisk fra produkternes PROD_CAT_ID</p>
            </div>
          ) : (
            <div className="border rounded-lg overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">
                      <Checkbox
                        checked={selectedIds.size === categories.length}
                        onCheckedChange={toggleSelectAll}
                      />
                    </TableHead>
                    <TableHead className="w-20">ID</TableHead>
                    <TableHead>DanDomain Kategori</TableHead>
                    <TableHead>Shopify Tag</TableHead>
                    <TableHead className="w-24">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {categories.map(category => (
                    <TableRow 
                      key={category.id}
                      className={category.exclude ? 'opacity-50' : ''}
                    >
                      <TableCell>
                        <Checkbox
                          checked={selectedIds.has(category.id)}
                          onCheckedChange={() => toggleSelect(category.id)}
                        />
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs text-muted-foreground">
                          {category.external_id}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Folder className="w-4 h-4 text-muted-foreground" />
                          <span className="font-medium">{category.name}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <ArrowRight className="w-4 h-4 text-muted-foreground" />
                          <Input
                            value={category.shopify_tag || ''}
                            onChange={(e) => updateCategory(category.id, { shopify_tag: e.target.value })}
                            className="h-8 w-48"
                            disabled={category.exclude}
                          />
                          <Tag className="w-4 h-4 text-primary" />
                        </div>
                      </TableCell>
                      <TableCell>
                        {category.exclude ? (
                          <Badge variant="secondary">Ekskluderet</Badge>
                        ) : (
                          <Badge variant="outline">Aktiv</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-between gap-3 pt-4">
        {onBack && (
          <Button variant="outline" onClick={onBack}>
            <RefreshCw className="w-4 h-4 mr-2" />
            Gå tilbage og udtræk igen
          </Button>
        )}
        <div className="flex-1" />
        <Button onClick={handleSaveAndContinue} disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Gemmer...
            </>
          ) : (
            <>
              <Save className="w-4 h-4 mr-2" />
              Gem og fortsæt
            </>
          )}
        </Button>
      </div>
    </div>
  );
}