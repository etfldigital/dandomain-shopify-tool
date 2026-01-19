import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/layout/Header';
import { ProjectCard } from '@/components/dashboard/ProjectCard';
import { CreateProjectDialog } from '@/components/dashboard/CreateProjectDialog';
import { useProjects } from '@/hooks/useProjects';
import { Loader2, FolderOpen } from 'lucide-react';
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

export default function Dashboard() {
  const navigate = useNavigate();
  const { projects, isLoading, createProject, deleteProject } = useProjects();
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const handleCreateProject = async (name: string) => {
    const project = await createProject.mutateAsync(name);
    navigate(`/project/${project.id}`);
  };

  const handleOpenProject = (projectId: string) => {
    navigate(`/project/${projectId}`);
  };

  const handleDeleteProject = async () => {
    if (deleteId) {
      await deleteProject.mutateAsync(deleteId);
      setDeleteId(null);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 lg:py-12">
        <div className="flex items-start sm:items-center justify-between gap-4 mb-10">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold text-foreground tracking-tight">Mine Projekter</h1>
            <p className="text-muted-foreground text-sm">
              Administrer dine DanDomain til Shopify migreringer
            </p>
          </div>
          <CreateProjectDialog 
            onCreateProject={handleCreateProject}
            isCreating={createProject.isPending}
          />
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-7 h-7 animate-spin text-primary" />
          </div>
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-5">
              <FolderOpen className="w-7 h-7 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium text-foreground mb-1.5">
              Ingen projekter endnu
            </h3>
            <p className="text-muted-foreground mb-8 max-w-sm text-sm leading-relaxed">
              Opret dit første projekt for at starte migreringen fra DanDomain til Shopify
            </p>
            <CreateProjectDialog 
              onCreateProject={handleCreateProject}
              isCreating={createProject.isPending}
            />
          </div>
        ) : (
          <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {projects.map(project => (
              <ProjectCard
                key={project.id}
                project={project}
                onOpen={handleOpenProject}
                onDelete={(id) => setDeleteId(id)}
              />
            ))}
          </div>
        )}
      </main>

      <AlertDialog open={!!deleteId} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent className="rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Slet projekt?</AlertDialogTitle>
            <AlertDialogDescription className="leading-relaxed">
              Dette vil permanent slette projektet og alle tilhørende data. 
              Denne handling kan ikke fortrydes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-3 sm:gap-2">
            <AlertDialogCancel className="rounded-xl">Annuller</AlertDialogCancel>
            <AlertDialogAction 
              onClick={handleDeleteProject}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 rounded-xl"
            >
              Slet projekt
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
