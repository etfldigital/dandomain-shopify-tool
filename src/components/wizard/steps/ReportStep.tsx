import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  CheckCircle2, 
  AlertCircle,
  Download,
  Loader2,
  ExternalLink,
  ShoppingBag,
  Users,
  FileText,
  Folder,
  RotateCcw,
  PartyPopper
} from 'lucide-react';
import { Project } from '@/types/database';
import { supabase } from '@/integrations/supabase/client';
import { useNavigate } from 'react-router-dom';

interface ReportStepProps {
  project: Project;
}

interface MigrationStats {
  products: { total: number; success: number; failed: number };
  customers: { total: number; success: number; failed: number };
  orders: { total: number; success: number; failed: number };
  categories: { total: number; success: number; failed: number };
}

export function ReportStep({ project }: ReportStepProps) {
  const navigate = useNavigate();
  const [isDownloadingReport, setIsDownloadingReport] = useState(false);
  const [stats, setStats] = useState<MigrationStats>({
    products: { total: 0, success: 0, failed: 0 },
    customers: { total: 0, success: 0, failed: 0 },
    orders: { total: 0, success: 0, failed: 0 },
    categories: { total: 0, success: 0, failed: 0 },
  });

  useEffect(() => {
    loadStats();
  }, [project.id]);

  const loadStats = async () => {
    // Get products stats
    const { count: productTotal } = await supabase
      .from('canonical_products')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id);

    const { count: productSuccess } = await supabase
      .from('canonical_products')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id)
      .eq('status', 'uploaded');

    const { count: productFailed } = await supabase
      .from('canonical_products')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id)
      .eq('status', 'failed');

    // Get customers stats
    const { count: customerTotal } = await supabase
      .from('canonical_customers')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id);

    const { count: customerSuccess } = await supabase
      .from('canonical_customers')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id)
      .eq('status', 'uploaded');

    const { count: customerFailed } = await supabase
      .from('canonical_customers')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id)
      .eq('status', 'failed');

    // Get orders stats
    const { count: orderTotal } = await supabase
      .from('canonical_orders')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id);

    const { count: orderSuccess } = await supabase
      .from('canonical_orders')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id)
      .eq('status', 'uploaded');

    const { count: orderFailed } = await supabase
      .from('canonical_orders')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id)
      .eq('status', 'failed');

    // Get categories stats
    const { count: categoryTotal } = await supabase
      .from('canonical_categories')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id)
      .eq('exclude', false);

    const { count: categorySuccess } = await supabase
      .from('canonical_categories')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id)
      .eq('status', 'uploaded');

    const { count: categoryFailed } = await supabase
      .from('canonical_categories')
      .select('*', { count: 'exact', head: true })
      .eq('project_id', project.id)
      .eq('status', 'failed');

    setStats({
      products: { 
        total: productTotal || 0, 
        success: productSuccess || 0, 
        failed: productFailed || 0 
      },
      customers: { 
        total: customerTotal || 0, 
        success: customerSuccess || 0, 
        failed: customerFailed || 0 
      },
      orders: { 
        total: orderTotal || 0, 
        success: orderSuccess || 0, 
        failed: orderFailed || 0 
      },
      categories: { 
        total: categoryTotal || 0, 
        success: categorySuccess || 0, 
        failed: categoryFailed || 0 
      },
    });
  };

  const totalItems = stats.products.total + stats.customers.total + stats.orders.total + stats.categories.total;
  const totalSuccess = stats.products.success + stats.customers.success + stats.orders.success + stats.categories.success;
  const totalFailed = stats.products.failed + stats.customers.failed + stats.orders.failed + stats.categories.failed;
  const successRate = totalItems > 0 ? Math.round((totalSuccess / totalItems) * 100) : 100;

  const STAT_CONFIG = [
    { key: 'products' as const, icon: ShoppingBag, label: 'Produkter' },
    { key: 'customers' as const, icon: Users, label: 'Kunder' },
    { key: 'orders' as const, icon: FileText, label: 'Ordrer' },
    { key: 'categories' as const, icon: Folder, label: 'Kategorier' },
  ];

  const handleDownloadErrorReport = async () => {
    setIsDownloadingReport(true);

    try {
      const escapeCsv = (value: unknown) =>
        `"${String(value ?? '').replace(/"/g, '""')}"`;

      const sb: any = supabase;

      const fetchAll = async (table: string, select: string) => {
        const pageSize = 1000;
        let from = 0;
        const all: any[] = [];

        while (true) {
          const { data, error } = await sb
            .from(table)
            .select(select)
            .eq('project_id', project.id)
            .eq('status', 'failed')
            .range(from, from + pageSize - 1);


          if (error) throw error;
          all.push(...(data ?? []));

          if (!data || data.length < pageSize) break;
          from += pageSize;
        }

        return all;
      };

      const [products, customers, orders, categories] = await Promise.all([
        fetchAll('canonical_products', 'external_id, error_message, data'),
        fetchAll('canonical_customers', 'external_id, error_message, data'),
        fetchAll('canonical_orders', 'external_id, error_message, data'),
        fetchAll('canonical_categories', 'external_id, error_message, name'),
      ]);

      const getTitle = (row: any) => {
        if (row?.name) return row.name;
        const data = row?.data ?? {};
        return (
          data.title ??
          data.name ??
          data.email ??
          [data.first_name, data.last_name].filter(Boolean).join(' ') ??
          ''
        );
      };

      let csv = 'Type,External ID,Titel/Navn,Fejlbesked\n';

      const appendRows = (label: string, rows: any[]) => {
        for (const row of rows) {
          csv += [
            escapeCsv(label),
            escapeCsv(row.external_id),
            escapeCsv(getTitle(row)),
            escapeCsv(row.error_message || 'Ukendt fejl'),
          ].join(',') + '\n';
        }
      };

      appendRows('Produkter', products);
      appendRows('Kunder', customers);
      appendRows('Ordrer', orders);
      appendRows('Kategorier', categories);

      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'fejlrapport.csv';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } finally {
      setIsDownloadingReport(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-green-100 dark:bg-green-900 mb-4">
          <PartyPopper className="w-8 h-8 text-green-600 dark:text-green-400" />
        </div>
        <h2 className="text-2xl font-semibold mb-2">Migrering fuldført!</h2>
        <p className="text-muted-foreground">
          {project.name} er nu migreret til Shopify
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">Opsummering</CardTitle>
              <CardDescription>Overblik over migreringen</CardDescription>
            </div>
            <Badge 
              variant={successRate >= 95 ? 'default' : successRate >= 80 ? 'secondary' : 'destructive'}
              className="text-lg px-4 py-1"
            >
              {successRate}% succes
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            {STAT_CONFIG.map(({ key, icon: Icon, label }) => {
              const stat = stats[key];
              return (
                <div key={key} className="p-4 rounded-xl bg-muted/50">
                  <div className="flex items-center gap-2 mb-3">
                    <Icon className="w-5 h-5 text-primary" />
                    <span className="font-medium">{label}</span>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Total</span>
                      <span className="font-medium">{stat.total.toLocaleString('da-DK')}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
                        <CheckCircle2 className="w-3 h-3" />
                        Succes
                      </span>
                      <span>{stat.success.toLocaleString('da-DK')}</span>
                    </div>
                    {stat.failed > 0 && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="flex items-center gap-1 text-destructive">
                          <AlertCircle className="w-3 h-3" />
                          Fejlet
                        </span>
                        <span>{stat.failed.toLocaleString('da-DK')}</span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {totalFailed > 0 && (
        <Card className="border-destructive/30">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2 text-destructive">
              <AlertCircle className="w-5 h-5" />
              {totalFailed} fejlede items
            </CardTitle>
            <CardDescription>
              Download fejlrapporten for at se detaljer
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              variant="outline"
              className="w-full"
              onClick={handleDownloadErrorReport}
              disabled={isDownloadingReport}
            >
              {isDownloadingReport ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Download className="w-4 h-4 mr-2" />
              )}
              Download fejlrapport (CSV)
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="flex gap-3 pt-4">
        <Button variant="outline" onClick={() => navigate('/')} className="flex-1">
          <RotateCcw className="w-4 h-4 mr-2" />
          Tilbage til projekter
        </Button>
        {project.shopify_store_domain && (
          <Button 
            className="flex-1" 
            onClick={() => window.open(`https://${project.shopify_store_domain}/admin`, '_blank')}
          >
            Åbn Shopify Admin
            <ExternalLink className="w-4 h-4 ml-2" />
          </Button>
        )}
      </div>
    </div>
  );
}