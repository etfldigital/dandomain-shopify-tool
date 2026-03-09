import { useState } from 'react';
import { Project } from '@/types/database';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Trash2, RotateCcw, Archive, Loader2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { da } from 'date-fns/locale';

interface DeletedProjectsDialogProps {
  deletedProjects: Project[];
  isLoading: boolean;
  onRestore: (id: string) => Promise<void>;
  onPermanentDelete: (id: string) => Promise<void>;
  isRestoring: boolean;
  isDeleting: boolean;
}

export function DeletedProjectsDialog({
  deletedProjects,
  isLoading,
  onRestore,
  onPermanentDelete,
  isRestoring,
  isDeleting,
}: DeletedProjectsDialogProps) {
  const [open, setOpen] = useState(false);
  const [permanentDeleteId, setPermanentDeleteId] = useState<string | null>(null);

  if (deletedProjects.length === 0 && !isLoading) return null;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-foreground gap-2"
        onClick={() => setOpen(true)}
      >
        <Archive className="w-4 h-4" />
        Slettede projekter ({deletedProjects.length})
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Slettede projekter</DialogTitle>
            <DialogDescription>
              Genskab eller slet permanent dine fjernede projekter.
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : deletedProjects.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              Ingen slettede projekter.
            </p>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {deletedProjects.map((project) => (
                <div
                  key={project.id}
                  className="flex items-center justify-between gap-3 p-3 rounded-xl border border-border/60 bg-muted/30"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm text-foreground truncate">
                      {project.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Slettet{' '}
                      {project.deleted_at &&
                        formatDistanceToNow(new Date(project.deleted_at), {
                          addSuffix: true,
                          locale: da,
                        })}
                    </p>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 rounded-lg"
                      onClick={() => onRestore(project.id)}
                      disabled={isRestoring}
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Genskab
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 text-destructive hover:text-destructive rounded-lg"
                      onClick={() => setPermanentDeleteId(project.id)}
                      disabled={isDeleting}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!permanentDeleteId} onOpenChange={() => setPermanentDeleteId(null)}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Slet permanent?</AlertDialogTitle>
            <AlertDialogDescription className="leading-relaxed">
              Dette vil permanent slette projektet og alle tilhørende data. Denne handling kan ikke fortrydes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-3 sm:gap-2">
            <AlertDialogCancel className="rounded-xl">Annuller</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (permanentDeleteId) {
                  await onPermanentDelete(permanentDeleteId);
                  setPermanentDeleteId(null);
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 rounded-xl"
            >
              Slet permanent
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
