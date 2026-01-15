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
  const totalItems = project.product_count + project.customer_count + project.order_count;

  return (
    <Card className="group hover:shadow-lg transition-all duration-200 cursor-pointer border-border hover:border-primary/20">
      <CardContent className="p-6" onClick={() => onOpen(project.id)}>
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <ShoppingBag className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground group-hover:text-primary transition-colors">
                {project.name}
              </h3>
              {project.dandomain_shop_url && (
                <p className="text-sm text-muted-foreground truncate max-w-[200px]">
                  {project.dandomain_shop_url}
                </p>
              )}
            </div>
          </div>
          
          <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <Badge variant={statusConfig.variant}>{statusConfig.label}</Badge>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem 
                  onClick={() => onDelete(project.id)}
                  className="text-destructive cursor-pointer"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Slet projekt
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-4 mb-4">
          <Stat icon={ShoppingBag} label="Produkter" value={project.product_count} />
          <Stat icon={Users} label="Kunder" value={project.customer_count} />
          <Stat icon={FileText} label="Ordrer" value={project.order_count} />
          <Stat icon={Folder} label="Kategorier" value={project.category_count} />
        </div>

        <div className="flex items-center justify-between pt-4 border-t border-border">
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Clock className="w-3.5 h-3.5" />
            <span>
              Opdateret {formatDistanceToNow(new Date(project.updated_at), { addSuffix: true, locale: da })}
            </span>
          </div>
          <ChevronRight className="w-5 h-5 text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof ShoppingBag; label: string; value: number }) {
  return (
    <div className="text-center">
      <div className="flex items-center justify-center gap-1 text-muted-foreground mb-1">
        <Icon className="w-3.5 h-3.5" />
      </div>
      <p className="text-lg font-semibold text-foreground">{value.toLocaleString('da-DK')}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}