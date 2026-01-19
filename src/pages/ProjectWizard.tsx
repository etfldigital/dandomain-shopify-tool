import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Header } from '@/components/layout/Header';
import { WizardStepper } from '@/components/wizard/WizardStepper';
import { ConnectDanDomainStep } from '@/components/wizard/steps/ConnectDanDomainStep';
import { ExtractStep } from '@/components/wizard/steps/ExtractStep';
import { MappingStep } from '@/components/wizard/steps/MappingStep';
import { ConnectShopifyStep } from '@/components/wizard/steps/ConnectShopifyStep';
import { UploadStep } from '@/components/wizard/steps/UploadStep';
import { ReviewStep } from '@/components/wizard/steps/ReviewStep';
import { ReportStep } from '@/components/wizard/steps/ReportStep';
import { useProject } from '@/hooks/useProjects';
import { supabase } from '@/integrations/supabase/client';
import { WizardStep, Project, ProjectStatus } from '@/types/database';
import { Button } from '@/components/ui/button';
import { Loader2, ArrowLeft } from 'lucide-react';

const STATUS_TO_STEP: Record<ProjectStatus, WizardStep> = {
  draft: 'connect-dandomain',
  connected: 'extract',
  extracted: 'mapping',
  mapped: 'connect-shopify',
  migrating: 'upload',
  completed: 'review',
};

const STEP_ORDER: WizardStep[] = [
  'connect-dandomain',
  'extract',
  'mapping',
  'connect-shopify',
  'upload',
  'review',
  'report',
];

export default function ProjectWizard() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { project, isLoading, error } = useProject(projectId);
  const [currentStep, setCurrentStep] = useState<WizardStep>('connect-dandomain');
  const [completedSteps, setCompletedSteps] = useState<WizardStep[]>([]);

  useEffect(() => {
    if (project) {
      const step = STATUS_TO_STEP[project.status];
      setCurrentStep(step);
      
      // Mark all previous steps as completed
      const stepIndex = STEP_ORDER.indexOf(step);
      setCompletedSteps(STEP_ORDER.slice(0, stepIndex));
    }
  }, [project]);

  const handleUpdateProject = async (updates: Partial<Project>) => {
    if (!projectId) return;
    
    await supabase
      .from('projects')
      .update(updates)
      .eq('id', projectId);
  };

  const handleNext = () => {
    const currentIndex = STEP_ORDER.indexOf(currentStep);
    if (currentIndex < STEP_ORDER.length - 1) {
      setCompletedSteps(prev => [...prev, currentStep]);
      setCurrentStep(STEP_ORDER[currentIndex + 1]);
    }
  };

  const handleStepClick = (step: WizardStep) => {
    const stepIndex = STEP_ORDER.indexOf(step);
    const currentIndex = STEP_ORDER.indexOf(currentStep);
    if (stepIndex <= currentIndex || completedSteps.includes(step)) {
      setCurrentStep(step);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-semibold mb-2">Projekt ikke fundet</h2>
          <Button onClick={() => navigate('/')}>Tilbage til projekter</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/')}
            className="mb-4"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Tilbage til projekter
          </Button>
          
          <h1 className="text-2xl font-semibold text-foreground mb-6">{project.name}</h1>
          
          <WizardStepper
            currentStep={currentStep}
            completedSteps={completedSteps}
            onStepClick={handleStepClick}
          />
        </div>

        <div className="mt-12">
          {currentStep === 'connect-dandomain' && (
            <ConnectDanDomainStep
              project={project}
              onUpdateProject={handleUpdateProject}
              onNext={handleNext}
            />
          )}
          {currentStep === 'extract' && (
            <ExtractStep
              project={project}
              onUpdateProject={handleUpdateProject}
              onNext={handleNext}
            />
          )}
          {currentStep === 'mapping' && (
            <MappingStep
              project={project}
              onUpdateProject={handleUpdateProject}
              onNext={handleNext}
            />
          )}
          {currentStep === 'connect-shopify' && (
            <ConnectShopifyStep
              project={project}
              onUpdateProject={handleUpdateProject}
              onNext={handleNext}
            />
          )}
          {currentStep === 'upload' && (
            <UploadStep
              project={project}
              onUpdateProject={handleUpdateProject}
              onNext={handleNext}
            />
          )}
          {currentStep === 'review' && (
            <ReviewStep
              project={project}
              onUpdateProject={handleUpdateProject}
              onNext={handleNext}
            />
          )}
          {currentStep === 'report' && (
            <ReportStep project={project} />
          )}
        </div>
      </main>
    </div>
  );
}