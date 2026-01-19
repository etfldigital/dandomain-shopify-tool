import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Plus, Loader2 } from 'lucide-react';

interface CreateProjectDialogProps {
  onCreateProject: (name: string) => Promise<void>;
  isCreating: boolean;
}

export function CreateProjectDialog({ onCreateProject, isCreating }: CreateProjectDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    
    await onCreateProject(name.trim());
    setName('');
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2 shadow-sm">
          <Plus className="w-4 h-4" />
          Nyt projekt
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Opret nyt projekt</DialogTitle>
            <DialogDescription>
              Giv dit migrationsprojekt et navn, så du nemt kan finde det igen.
            </DialogDescription>
          </DialogHeader>
          <div className="my-7">
            <Label htmlFor="projectName" className="text-sm font-medium">Projektnavn</Label>
            <Input
              id="projectName"
              placeholder="f.eks. MinWebshop.dk"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-2"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Annuller
            </Button>
            <Button type="submit" disabled={!name.trim() || isCreating}>
              {isCreating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                'Opret projekt'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
