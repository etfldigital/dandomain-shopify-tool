import { Project, ProjectStatus } from '@/types/database';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { 
  ShoppingBag, 
  Users, 
  FileText, 
  Folder, 
  ChevronRight,
  MoreHorizontal,
  Trash2,
  Clock
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatDistanceToNow } from 'date-fns';
import { da } from 'date-fns/locale';

interface ProjectCardProps {
  project: Project;
  onOpen: (projectId: string) => void;
  onDelete: (projectId: string) => void;
}

const STATUS_CONFIG: Record<ProjectStatus, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  draft: { label: 'Kladde', variant: 'secondary' },
  connected: { label: 'Forbundet', variant: 'outline' },
  extracted: { label: 'Udtrukket', variant: 'outline' },
  mapped: { label: 'Mappet', variant: 'outline' },
  migrating: { label: 'Migrerer...', variant: 'default' },
  completed: { label: 'Fuldført', variant: 'default' },
};

export function ProjectCard({ project, onOpen, onDelete }: ProjectCardProps) {
  const statusConfig = STATUS_CONFIG[project.status];

  return (
    <Card className="group hover:shadow-elevated hover:border-border cursor-pointer transition-all duration-200 ease-out w-full">
      <CardContent className="p-5 sm:p-6" onClick={() => onOpen(project.id)}>
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-5">
          <div className="flex items-center gap-3.5 min-w-0 flex-1">
            <div className="w-11 h-11 shrink-0 rounded-xl bg-primary/10 flex items-center justify-center">
              <ShoppingBag className="w-5 h-5 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold text-foreground group-hover:text-primary transition-colors duration-200 truncate">
                {project.name}
              </h3>
              {project.dandomain_shop_url && (
                <p className="text-sm text-muted-foreground truncate mt-0.5">
                  {project.dandomain_shop_url}
                </p>
              )}
            </div>
          </div>
          
          <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
            <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity duration-200 rounded-lg">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="rounded-xl shadow-float border-border/60">
                <DropdownMenuItem 
                  onClick={() => onDelete(project.id)}
                  className="text-destructive cursor-pointer rounded-lg mx-1 my-0.5"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Slet projekt
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
          <Stat icon={ShoppingBag} label="Produkter" value={project.product_count} />
          <Stat icon={Users} label="Kunder" value={project.customer_count} />
          <Stat icon={FileText} label="Ordrer" value={project.order_count} />
          <Stat icon={Folder} label="Kategorier" value={project.category_count} />
        </div>

        <div className="flex items-center justify-between pt-4 border-t border-border/60">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">
              Opdateret {formatDistanceToNow(new Date(project.updated_at), { addSuffix: true, locale: da })}
            </span>
          </div>
          <ChevronRight className="w-5 h-5 shrink-0 text-muted-foreground/50 group-hover:text-primary group-hover:translate-x-0.5 transition-all duration-200" />
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof ShoppingBag; label: string; value: number }) {
  return (
    <div className="text-center py-2">
      <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1.5">
        <Icon className="w-3.5 h-3.5" />
      </div>
      <p className="text-lg font-semibold text-foreground tabular-nums">{value.toLocaleString('da-DK')}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
